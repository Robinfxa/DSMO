// A conversation file (对话文件, `kind: conversation`) opens as an imported
// conversation: read-only, with 「接着聊」 (history/imported.ts). dsh-Go
// replays it; here the prompts and replies are what is kept.

import { ShareFormatError } from './codec';
import type { ImportedChat, ImportedMessage } from '../history/imported';

const VERSION = 2;
const SCHEMA = 1;

export function conversationToImported(json: Record<string, unknown>, code: string): ImportedChat {
  const v = json.v;
  if (typeof v !== 'number' || v < 1) throw new ShareFormatError('no format version');
  if (v > VERSION) throw new ShareFormatError('newer format');
  const schema = json.schema;
  if (typeof schema !== 'number' || schema < 1) throw new ShareFormatError('no schema');
  if (schema > SCHEMA) throw new ShareFormatError('newer format');
  const start = typeof json.start === 'string' ? Date.parse(json.start) : NaN;
  if (Number.isNaN(start)) throw new ShareFormatError('no start time');
  const entries = json.entries;
  if (!Array.isArray(entries) || entries.length > 20000) throw new ShareFormatError('bad entries');
  const messages: ImportedMessage[] = [];
  let last = start;
  for (const raw of entries) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const t = typeof e.t === 'number' ? e.t : 0;
    last = Math.max(last, start + t + (typeof e.d === 'number' ? e.d : 0));
    if (e.type === 'user' && typeof e.text === 'string') messages.push({ role: 'user', text: e.text });
    else if (e.type === 'reply' && typeof e.text === 'string') {
      const prev = messages[messages.length - 1];
      const think = typeof e.think === 'string' && e.think ? e.think : undefined;
      // A turn's replies around its tool calls read as one answer.
      if (prev?.role === 'assistant') {
        prev.text = [prev.text, e.text].filter(Boolean).join('\n\n');
        if (think) prev.think = [prev.think, think].filter(Boolean).join('\n\n');
      } else messages.push({ role: 'assistant', text: e.text, ...(think ? { think } : {}) });
    }
  }
  const title = typeof json.title === 'string' && json.title.trim() ? json.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '分享的对话';
  return { id: `dshgo-${code.split('.').pop()}`, title, createdAt: start, updatedAt: last, source: 'dsh-go', messages };
}
