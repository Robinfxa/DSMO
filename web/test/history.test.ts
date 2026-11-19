import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { parseJson, saveImported, imported, getImported, clearImported, toMarkdown } from '../src/history/imported';
import { parseFiles } from '../src/history/stream';
import { source } from './stream-source';

const fx = (n: string) => readFileSync(`test/fixtures/${n}`, 'utf8');

describe('导入历史对话', () => {
  it('reads the DeepSeek web export (fragments, newest branch, thinking kept apart)', () => {
    const chats = parseJson(JSON.parse(fx('deepseek-conversations.json')));
    expect(chats).toHaveLength(2);
    const c = chats[0];
    expect(c.source).toBe('deepseek');
    expect(c.title).toBe('周末去哪玩');
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(c.messages[1].think).toContain('老人');
    expect(c.messages[1].text).toContain('西湖');
    expect(c.updatedAt).toBe(Date.parse('2026-03-02T10:05:00+08:00'));
  });

  it('reads the ChatGPT export along current_node and skips system messages', () => {
    const [c] = parseJson(JSON.parse(fx('chatgpt-conversations.json')));
    expect(c.source).toBe('chatgpt');
    expect(c.messages).toEqual([
      { role: 'user', text: 'How to match an email?' },
      { role: 'assistant', text: 'Use a simple pattern like `\\S+@\\S+`.' },
    ]);
    expect(c.createdAt).toBe(1767225600500);
  });

  it('reads a plain list and this app’s own session log', () => {
    expect(parseJson([{ title: 't', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] }])[0].messages).toHaveLength(2);
    const log = {
      sessionId: 's1',
      header: {},
      events: [
        { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, time: 1000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
        { seq: 3, time: 2000, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] } } },
        { seq: 4, time: 2000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    };
    const [c] = parseJson(log);
    expect(c.source).toBe('api-demo');
    expect(c.messages[0]).toEqual({ role: 'user', text: '你好' });
  });

  it('opens zip archives and de-duplicates by id', async () => {
    const zip = zipSync({ 'conversations.json': strToU8(fx('deepseek-conversations.json')), 'user.json': strToU8('{"name":"x"}') });
    const f1 = source('deepseek_data.zip', zip);
    const f2 = source('conversations.json', strToU8(fx('deepseek-conversations.json')));
    const { chats, skipped } = await parseFiles([f1, f2]);
    expect(chats).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it('saves on the device, replaces re-imports, and makes context for 接着聊', async () => {
    const chats = parseJson(JSON.parse(fx('deepseek-conversations.json')));
    expect(await saveImported(chats)).toEqual({ added: 2, updated: 0 });
    expect(await saveImported(chats.slice(0, 1))).toEqual({ added: 0, updated: 1 });
    expect(imported.value.map((c) => c.title)).toEqual(['周末去哪玩', '番茄炒蛋']);
    const c = await getImported(chats[0].id);
    expect(toMarkdown(c!)).toContain('**我**：周末在杭州');
    await clearImported();
    expect(imported.value).toHaveLength(0);
  });
});
