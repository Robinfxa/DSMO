// DeepSeek's real 导出所有历史对话 zip (chat_sessions/<id>.json, see imported.ts fromDeepSeekSession)
// and DSMO's own export, read back through the same streaming import.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseFiles } from '../src/history/stream';
import { source } from './stream-source';

/** One conversation file as chat.deepseek.com exports it. */
const session = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  current_message_id: 5,
  messages: [
    { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-03-02T10:00:00+08:00', fragments: [{ type: 'REQUEST', content: '你好' }] },
    { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-03-02T10:00:05+08:00', model: 'deepseek-chat', fragments: [{ type: 'THINK', content: '先打招呼' }, { type: 'RESPONSE', content: '你好呀' }] },
    // A branch the user left: an old answer to the same question.
    { id: 3, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-03-02T10:00:04+08:00', fragments: [{ type: 'RESPONSE', content: '旧的回答' }] },
    { id: 4, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: '2026-03-02T10:01:00+08:00', fragments: [{ type: 'REQUEST', content: '看看这个' }, { type: 'FILE', files: [{ file_name: '日记.txt' }] }] },
    // A reply that failed before a word: not a message.
    { id: 6, parent_id: 4, role: 'ASSISTANT', status: 'INCOMPLETE', inserted_at: '2026-03-02T10:01:02+08:00', fragments: [] },
    { id: 5, parent_id: 4, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-03-02T10:01:05+08:00', fragments: [{ type: 'RESPONSE', content: '收到' }] },
  ],
  ...extra,
});

describe('DeepSeek website export (chat_sessions/<id>.json)', () => {
  const zip = zipSync({
    'deepseek_data/chat_session_index.json': strToU8(JSON.stringify([{ id: 'abc', updated_at: '2026-03-02T10:01:05+08:00' }])),
    'deepseek_data/user.json': strToU8(JSON.stringify({ name: 'x' })),
    'deepseek_data/chat_sessions/abc.json': strToU8(JSON.stringify(session('  早安  \n 闲聊 '))),
    'deepseek_data/chat_sessions/def.json': strToU8(JSON.stringify(session('第二个'))),
  });

  it('reads every conversation along the branch last on screen', async () => {
    const { chats, skipped } = await parseFiles([source('deepseek_data-2026-03-02.zip', zip, 1000)]);
    expect(skipped).toBe(0); // the index and user files are not conversations, not failures
    expect(chats.map((c) => c.id).sort()).toEqual(['deepseek:abc', 'deepseek:def']);
    const c = chats.find((x) => x.id === 'deepseek:abc')!;
    expect(c.source).toBe('deepseek');
    expect(c.title).toBe('早安 闲聊');
    expect(c.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', '你好'],
      ['assistant', '你好呀'],
      ['user', '看看这个\n\n〔日记.txt〕'],
      ['assistant', '收到'],
    ]);
    expect(c.messages[1].think).toBe('先打招呼');
    expect(c.messages[1].model).toBe('deepseek-chat');
    expect(c.createdAt).toBe(Date.parse('2026-03-02T10:00:00+08:00'));
    expect(c.updatedAt).toBe(Date.parse('2026-03-02T10:01:05+08:00'));
  });

  it('without current_message_id follows the newest message', async () => {
    const one = zipSync({ 'chat_sessions/x.json': strToU8(JSON.stringify(session('t', { current_message_id: undefined }))) });
    const { chats } = await parseFiles([source('e.zip', one)]);
    expect(chats[0].messages.at(-1)?.text).toBe('收到');
  });
});

describe('DSMO export read back', () => {
  it('reads [{sessionId, header, events}] as written by 导出所有历史对话', async () => {
    const events = [
      { seq: 1, time: 1700000000000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '记得我喜欢猫吗' }], source: { kind: 'user' } } },
      {
        seq: 2,
        time: 1700000005000,
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '记得，你喜欢猫。' }] } },
      },
    ];
    const json = JSON.stringify([{ sessionId: 's-1', header: { title: '猫' }, events }]);
    const { chats } = await parseFiles([source('DSMO-对话-20261119.json', strToU8(json))]);
    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe('api-demo:s-1');
    expect(chats[0].messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
