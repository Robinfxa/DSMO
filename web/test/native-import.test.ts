// A Session log written by dsh-go-bridge's session import (captured from a real DSH
// 0.2.2-rc.1 host, runtime/bridge/dsh-go-bridge/lib/session-import.js) renders like any chat.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJson, type ImportedChat } from '../src/history/imported';
import { batches, importRun, importedSessionId, nativeImportSupported, runImport, sourceIdOf, splitParts, toWire } from '../src/history/native';
import { setDshGoTransport } from '../src/plugins/dshgo';
import { parseLogEvent } from '../src/engine/events';
import { Transcript } from '../src/engine/transcript';

const here = dirname(fileURLToPath(import.meta.url));
const events = readFileSync(join(here, 'fixtures', 'imported_session.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => parseLogEvent(JSON.parse(l)));

describe('natively imported DeepSeek chat', () => {
  const t = new Transcript();
  t.apply({ kind: 'snapshot', header: { id: 'imported', createdAt: 1772416800000 }, cursor: -1, events, hasMore: false, projections: {}, isResync: false });

  it('shows the original turns, reasoning and title', () => {
    const items = t.items.filter((i) => i.kind === 'user' || i.kind === 'assistant');
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const [q, a] = items as any[];
    expect(q.text).toBe('周末在杭州有什么适合带父母去的地方？');
    expect(a.text).toContain('西湖');
    expect(a.reasoning).toBe('考虑老人体力……');
    expect(t.title).toBe('周末去哪玩');
  });

  it('keeps the original dates', () => {
    const first = t.items.find((i) => i.kind === 'user') as any;
    expect(new Date(first.time).toISOString()).toBe('2026-03-02T02:00:00.000Z');
  });

  it('shows no system head, import record or unfinished state', () => {
    expect(JSON.stringify(t.items)).not.toContain('dsh-go/import');
    expect(t.items.some((i: any) => i.kind === 'system')).toBe(false);
    expect(t.items.some((i: any) => i.streaming)).toBe(false);
  });
});

describe('client half of the session import', () => {
  const fixture = parseJson(JSON.parse(readFileSync(join(here, 'fixtures', 'deepseek-conversations.json'), 'utf8')));

  it('derives the same Session ids as dsh-go-bridge', async () => {
    // Both produced by runtime/bridge/dsh-go-bridge/lib/session-import.js on a real host.
    expect(await importedSessionId('deepseek', 'c1')).toBe('ea852124-2c4d-8998-a6c4-5735b197df7c');
    expect(await importedSessionId('deepseek', 'c1', 1)).toBe('4cdf3009-43b8-8c3c-ae04-c486bacd6c92');
  });

  it('keeps message times, models and reasoning on the wire', () => {
    const c = fixture.find((x) => sourceIdOf(x) === 'c1')!;
    const w = toWire(c);
    expect(w.sourceId).toBe('c1');
    expect(w.messages[0]).toEqual({ role: 'user', text: '周末在杭州有什么适合带父母去的地方？', time: Date.parse('2026-03-02T10:00:00+08:00') });
    expect(w.messages[1]).toMatchObject({ role: 'assistant', think: '考虑老人体力……', model: 'deepseek-reasoner' });
  });

  it('batches by source, 20 at a time, and holds back what the bridge cannot take', () => {
    const one = (i: number, source: ImportedChat['source'], text = 'x'): ImportedChat => ({ id: `${source}:${i}`, title: `t${i}`, createdAt: 1, updatedAt: 1, source, messages: [{ role: 'user', text }] });
    const chats = [...Array.from({ length: 25 }, (_, i) => one(i, 'deepseek')), one(99, 'chatgpt'), one(100, 'deepseek', 'y'.repeat(8 * 1024 * 1024))];
    const { batches: b, tooLarge } = batches(chats);
    expect(b.map((x) => [x.source, x.items.length])).toEqual([['deepseek', 20], ['deepseek', 5], ['chatgpt', 1]]);
    expect(tooLarge.map((c) => c.id)).toEqual(['deepseek:100']);
  });

  it('runs the batches and counts imported, skipped and failed', async () => {
    const sent: any[] = [];
    setDshGoTransport({
      get: async () => ({ status: 200, json: { supported: true, version: 1 } }),
      post: async (_p, body: any) => {
        sent.push(body);
        return { status: 200, json: { results: body.conversations.map((c: any, i: number) => ({ sourceId: c.sourceId, status: ['imported', 'skipped', 'failed'][i % 3], code: 'write-failed' })) } };
      },
    });
    const r = await runImport(fixture);
    expect(sent).toHaveLength(1);
    expect(sent[0].source).toBe('deepseek');
    expect([r.imported, r.skipped, r.failed.length, r.done, r.running]).toEqual([1, 1, 0, 2, false]);
    expect(importRun.value?.imported).toBe(1);
  });

  it('stops at a host that stops answering and says so', async () => {
    setDshGoTransport({ get: async () => ({ status: 200, json: {} }), post: async () => ({ status: 503, json: { error: { message: 'Session import is not available on this host.' } } }) });
    const r = await runImport(fixture);
    expect(r.error).toContain('not available');
    expect(r.done).toBe(0);
  });

  const longChat = (n: number, id = 'long'): ImportedChat => ({
    id: `deepseek:${id}`, title: '很长的对话', createdAt: 1, updatedAt: 2, source: 'deepseek',
    messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第 ${i} 条` })) as ImportedChat['messages'],
  });

  it('cuts a long conversation into parts by count and by size', () => {
    expect(splitParts(toWire(longChat(9001))).map((p) => p.length)).toEqual([3000, 3000, 3000, 1]);
    const big = toWire({ ...longChat(10), messages: Array.from({ length: 10 }, () => ({ role: 'user', text: 'x'.repeat(1000) })) as ImportedChat['messages'] });
    expect(splitParts(big, { maxBytes: 3500 }).map((p) => p.length)).toEqual([3, 3, 3, 1]);
  });

  it('sends a long conversation alone, part by part, when the bridge takes parts', async () => {
    const sent: any[] = [];
    setDshGoTransport({
      get: async () => ({ status: 200, json: { supported: true, version: 1, parts: true } }),
      post: async (_p, body: any) => {
        sent.push(body);
        return { status: 200, json: { results: body.conversations.map((c: any) => (c.part && c.part.index < c.part.count - 1 ? { sourceId: c.sourceId, status: 'partial', part: c.part.index } : { sourceId: c.sourceId, status: 'imported' })) } };
      },
    });
    expect(await nativeImportSupported()).toBe(true);
    const r = await runImport([longChat(9001), longChat(3, 'short')]);
    expect(sent.map((b) => b.conversations.map((c: any) => (c.part ? `${c.part.index}/${c.part.count}:${c.messages.length}` : `whole:${c.messages.length}`)))).toEqual([
      ['0/4:3000'], ['1/4:3000'], ['2/4:3000'], ['3/4:1'], ['whole:3'],
    ]);
    expect(sent[0].conversations[0].title).toBe('很长的对话');
    expect([r.imported, r.failed.length, r.done]).toEqual([2, 0, 2]);
    expect(importRun.value?.part).toBeUndefined();
  });

  it('starts a long conversation again from part 0 once when the bridge lost its place', async () => {
    let first = true;
    const order: string[] = [];
    setDshGoTransport({
      get: async () => ({ status: 200, json: { supported: true, version: 1, parts: true } }),
      post: async (_p, body: any) => {
        const c = body.conversations[0];
        order.push(`${c.part.index}`);
        if (first && c.part.index === 1) {
          first = false;
          return { status: 200, json: { results: [{ sourceId: c.sourceId, status: 'failed', code: 'part-order' }] } };
        }
        return { status: 200, json: { results: [c.part.index < c.part.count - 1 ? { status: 'partial' } : { status: 'imported' }] } };
      },
    });
    await nativeImportSupported();
    const r = await runImport([longChat(4500)]);
    expect(order).toEqual(['0', '1', '0', '1']);
    expect(r.imported).toBe(1);
  });

  it('an older bridge without parts still gets the conversation and says why it refused', async () => {
    const sent: any[] = [];
    setDshGoTransport({
      get: async () => ({ status: 200, json: { supported: true, version: 1 } }),
      post: async (_p, body: any) => {
        sent.push(body);
        return { status: 200, json: { results: [{ status: 'failed', code: 'invalid', reason: 'messages' }] } };
      },
    });
    await nativeImportSupported();
    const r = await runImport([longChat(4500)]);
    expect(sent[0].conversations[0].part).toBeUndefined();
    expect(r.failed[0].reason).toBe('消息超过 4000 条，更新 App 后可以导入');
  });
});
