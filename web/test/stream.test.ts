// Reading exports as streams (导入历史对话 for files of any size).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { parseJson, type ImportedChat } from '../src/history/imported';
import { JsonArraySplitter, parseFiles, readAllChats } from '../src/history/stream';
import { importRun, previewImport, runImport } from '../src/history/native';
import { setDshGoTransport } from '../src/plugins/dshgo';
import { source } from './stream-source';

const split = (text: string, chunk: number) => {
  const out: string[] = [];
  const s = new JsonArraySplitter((t) => out.push(t));
  const bytes = strToU8(text);
  for (let i = 0; i < bytes.length; i += chunk) s.push(bytes.subarray(i, i + chunk));
  s.end();
  return out;
};

/** A DeepSeek-website export with [n] conversations of [turns] exchanges. */
function deepseekExport(n: number, turns: number, filler = '') {
  const convs = Array.from({ length: n }, (_, i) => {
    const mapping: Record<string, unknown> = { root: { id: 'root', parent: null, children: ['m0'], message: null } };
    for (let t = 0; t < turns * 2; t++) {
      const user = t % 2 === 0;
      mapping[`m${t}`] = {
        id: `m${t}`,
        parent: t ? `m${t - 1}` : 'root',
        children: t < turns * 2 - 1 ? [`m${t + 1}`] : [],
        message: {
          inserted_at: '2026-03-02T10:00:00+08:00',
          fragments: [{ type: user ? 'REQUEST' : 'RESPONSE', content: `${user ? '问' : '答'} ${i}/${t} "引号" [括号] {花括号} \\ 反斜杠 😀${filler}` }],
        },
      };
    }
    return { id: `c${i}`, title: `对话 ${i}`, inserted_at: '2026-03-02T10:00:00+08:00', updated_at: '2026-03-02T10:05:00+08:00', mapping };
  });
  return JSON.stringify(convs);
}

describe('JsonArraySplitter', () => {
  const tricky = JSON.stringify([{ a: '] } [ {', b: 'say "hi" \\', c: [1, [2, { d: '😀中文' }]] }, 'skip me, ]', 42, null, [{ e: '\\"' }], { f: '' }]);

  it('cuts the top-level elements out, whatever the chunk size', () => {
    for (const chunk of [1, 2, 3, 7, 64, 1 << 20]) {
      expect(split(tricky, chunk).map((t) => JSON.parse(t))).toEqual([JSON.parse(tricky)[0], JSON.parse(tricky)[4], JSON.parse(tricky)[5]]);
    }
  });

  it('passes a document that isn’t a list through whole, and skips a BOM', () => {
    expect(split('﻿  {"conversations": [{"x": 1}]}', 3).map((t) => JSON.parse(t))).toEqual([{ conversations: [{ x: 1 }] }]);
    expect(split('[]', 1)).toEqual([]);
  });
});

describe('reading exports as streams', () => {
  it('reads the fixtures the same as parsing them whole', async () => {
    for (const name of ['deepseek-conversations.json', 'chatgpt-conversations.json']) {
      const text = readFileSync(`test/fixtures/${name}`, 'utf8');
      const { chats } = await parseFiles([source(name, strToU8(text), 5)]);
      expect(chats).toEqual(parseJson(JSON.parse(text)));
    }
  });

  it('reads a large zipped export one conversation at a time', async () => {
    const text = deepseekExport(3000, 6, 'x'.repeat(2000)); // ~ 75 MB of JSON, over the old 64 MB cap
    expect(text.length).toBeGreaterThan(64 * 1024 * 1024);
    const zip = zipSync({ 'deepseek_data/conversations.json': strToU8(text), 'deepseek_data/user.json': strToU8('{"name":"x"}') }, { level: 1 });
    const file = source('deepseek_data.zip', zip, 256 * 1024);
    let count = 0;
    let last: ImportedChat | undefined;
    let read = 0;
    for await (const c of readAllChats([file], (p) => (read = p.read))) {
      count++;
      last = c;
    }
    expect(count).toBe(3000);
    expect(read).toBe(zip.length);
    expect(last?.title).toBe('对话 2999');
    expect(last?.messages).toHaveLength(12);
    expect(last?.messages[0].text).toContain('"引号" [括号] {花括号} \\ 反斜杠 😀');
  }, 60_000);

  it('previews, then imports in batches as it reads, from a second pass over the file', async () => {
    const file = source('conversations.json', strToU8(deepseekExport(45, 1)), 1000);
    const each = () => readAllChats([file]);
    const p = await previewImport(each());
    expect([p.count, p.messages, p.sources]).toEqual([45, 90, ['deepseek']]);
    const sent: number[] = [];
    setDshGoTransport({
      get: async () => ({ status: 200, json: { supported: true, version: 1 } }),
      post: async (_p, body: any) => {
        sent.push(body.conversations.length);
        return { status: 200, json: { results: body.conversations.map((c: any) => ({ sourceId: c.sourceId, status: 'imported' })) } };
      },
    });
    const r = await runImport(each(), { total: p.count });
    expect(sent).toEqual([20, 20, 5]);
    expect([r.imported, r.done, r.total, r.running]).toEqual([45, 45, 45, false]);
    expect(file.reads).toBe(2);
    expect(importRun.value?.imported).toBe(45);
  });

  it('reports a file that stops reading part-way', async () => {
    const good = strToU8(deepseekExport(30, 1));
    const broken = {
      name: 'conversations.json',
      size: good.length,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(good.slice(0, good.length >> 1));
          },
          pull(ctrl) {
            ctrl.error(new Error('文件已经不在了，请重新选择'));
          },
        }),
    };
    setDshGoTransport({
      get: async () => ({ status: 200, json: {} }),
      post: async (_p, body: any) => ({ status: 200, json: { results: body.conversations.map(() => ({ status: 'imported' })) } }),
    });
    const r = await runImport(readAllChats([broken]), { total: 30 });
    expect(r.readError).toContain('不在了');
    expect(r.running).toBe(false);
  });
});
