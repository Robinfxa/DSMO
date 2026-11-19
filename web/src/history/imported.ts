// 导入历史对话. DSH has no endpoint that creates a session from an old log
// (dsh-Go's share-codes design says so: it replays instead), so imported
// conversations live on this device: read-only, listed with the others, and
// 「接着聊」 starts a new conversation that carries the old one as context.
//
// Accepted files: the DeepSeek website's 导出所有历史对话 zip (one
// chat_sessions/<id>.json per conversation, see fromDeepSeekSession), the
// ChatGPT export (a `mapping` tree), this app's own JSON export (DSH session
// logs), and a plain [{ title, messages: [{ role, content }] }].

import { signal } from '@preact/signals';
import { list, obj, str } from '../engine/json';
import { parseLogEvent } from '../engine/events';
import { Transcript } from '../engine/transcript';

export interface ImportedMessage {
  role: 'user' | 'assistant';
  text: string;
  think?: string;
  /** When the export dates its messages (ms). */
  time?: number;
  model?: string;
}
export interface ImportedChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  source: 'deepseek' | 'chatgpt' | 'api-demo' | 'dsh-go' | 'other';
  messages: ImportedMessage[];
}
export type ImportedSummary = Omit<ImportedChat, 'messages'> & { count: number; preview: string };

export const SOURCE_NAME: Record<ImportedChat['source'], string> = { deepseek: 'DeepSeek', chatgpt: 'ChatGPT', 'api-demo': 'DSMO', 'dsh-go': 'dsh-Go 分享', other: '文件' };

// ---------------------------------------------------------------- parsing

const ms = (v: unknown): number => {
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    const n = Number(v);
    if (!Number.isNaN(n)) return ms(n);
  }
  return 0;
};
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

/** Follows a `mapping` tree from the root along the newest branch (or back from `current_node`). */
function walkMapping(mapping: Record<string, unknown>, current?: string): Record<string, unknown>[] {
  const nodes = mapping;
  if (current && nodes[current]) {
    const out: Record<string, unknown>[] = [];
    let id: string | undefined = current;
    const seen = new Set<string>();
    while (id && nodes[id] && !seen.has(id)) {
      seen.add(id);
      const n = obj(nodes[id]);
      out.unshift(n);
      id = str(n.parent) ?? (typeof n.parent === 'number' ? String(n.parent) : undefined);
    }
    return out;
  }
  const root = Object.entries(nodes).find(([, n]) => obj(n).parent == null)?.[0] ?? 'root';
  const out: Record<string, unknown>[] = [];
  let id: string | undefined = root;
  const seen = new Set<string>();
  while (id && nodes[id] && !seen.has(id)) {
    seen.add(id);
    const n = obj(nodes[id]);
    out.push(n);
    const kids = list(n.children).map(String);
    id = kids[kids.length - 1];
  }
  return out;
}

function fromMapping(c: Record<string, unknown>): ImportedChat | null {
  const nodes = walkMapping(obj(c.mapping), str(c.current_node));
  const messages: ImportedMessage[] = [];
  let source: ImportedChat['source'] = 'chatgpt';
  for (const n of nodes) {
    const m = obj(n.message);
    if (!Object.keys(m).length) continue;
    if (Array.isArray(m.fragments)) {
      // DeepSeek web export: fragments REQUEST / THINK / RESPONSE / SEARCH…
      source = 'deepseek';
      let think = '';
      const time = ms(m.inserted_at) || undefined;
      const model = str(m.model);
      for (const f of list(m.fragments).map(obj)) {
        const type = (str(f.type) ?? '').toUpperCase();
        const content = str(f.content) ?? '';
        if (type === 'REQUEST') messages.push({ role: 'user', text: content, ...(time ? { time } : {}) });
        else if (type === 'THINK') think += content;
        else if (type === 'RESPONSE') {
          messages.push({ role: 'assistant', text: content, ...(think ? { think } : {}), ...(time ? { time } : {}), ...(model ? { model } : {}) });
          think = '';
        }
      }
      continue;
    }
    const role = str(obj(m.author).role);
    if (role !== 'user' && role !== 'assistant') continue;
    const content = obj(m.content);
    const text = list(content.parts)
      .map((p) => (typeof p === 'string' ? p : str(obj(p).text) ?? ''))
      .join('')
      .trim() || (str(content.text) ?? '');
    if (!text) continue;
    if (str(content.content_type) === 'thoughts') continue;
    const time = ms(m.create_time) || undefined;
    const model = role === 'assistant' ? str(obj(m.metadata).model_slug) : undefined;
    messages.push({ role, text, ...(time ? { time } : {}), ...(model ? { model } : {}) });
  }
  if (!messages.length) return null;
  const created = ms(c.inserted_at ?? c.create_time);
  const updated = ms(c.updated_at ?? c.update_time) || created;
  const id = str(c.id) ?? str(c.conversation_id) ?? hash(JSON.stringify(messages[0]) + created);
  return { id: `${source}:${id}`, title: str(c.title) || messages[0].text.slice(0, 20), createdAt: created || Date.now(), updatedAt: updated || Date.now(), source, messages };
}

function fromDshLog(c: Record<string, unknown>): ImportedChat | null {
  const t = new Transcript();
  const events = list(c.events).map(parseLogEvent);
  t.apply({ kind: 'snapshot', header: obj(c.header), cursor: -1, events, hasMore: false, projections: {}, isResync: false });
  const messages: ImportedMessage[] = [];
  for (const it of t.items) {
    if (it.kind === 'user' && it.text.trim()) messages.push({ role: 'user', text: it.text });
    if (it.kind === 'assistant' && it.text.trim()) messages.push({ role: 'assistant', text: it.text, ...(it.reasoning ? { think: it.reasoning } : {}) });
  }
  if (!messages.length) return null;
  const times = events.map((e) => e.time).filter(Boolean);
  const sid = str(c.sessionId) ?? hash(JSON.stringify(messages[0]));
  return {
    id: `api-demo:${sid}`,
    title: t.title || str(obj(c.header).title) || messages[0].text.slice(0, 20),
    createdAt: times.length ? Math.min(...times) : Date.now(),
    updatedAt: times.length ? Math.max(...times) : Date.now(),
    source: 'api-demo',
    messages,
  };
}

function fromPlain(c: Record<string, unknown>): ImportedChat | null {
  const messages: ImportedMessage[] = list(c.messages)
    .map(obj)
    .map((m) => ({ role: str(m.role), text: str(m.content) ?? str(m.text) ?? '' }))
    .filter((m): m is ImportedMessage => (m.role === 'user' || m.role === 'assistant') && !!m.text.trim());
  if (!messages.length) return null;
  const created = ms(c.createdAt ?? c.created_at) || Date.now();
  return { id: `other:${str(c.id) ?? hash(JSON.stringify(messages.slice(0, 2)) + created)}`, title: str(c.title) || messages[0].text.slice(0, 20), createdAt: created, updatedAt: ms(c.updatedAt ?? c.updated_at) || created, source: 'other', messages };
}

/**
 * One conversation file of DeepSeek's own export (chat.deepseek.com › 导出所有历史对话):
 * `chat_sessions/<id>.json` = `{title, current_message_id, messages: [{id, parent_id,
 * role: USER|ASSISTANT, status, inserted_at, fragments: [{type, content, files}]}]}`.
 * The messages are a tree; the branch last on screen ends at `current_message_id`.
 * Field meanings follow DeepSeek's own importer (deepseek-harness deepseek-chat-import)
 * as dsh-Go reads them (packages/dsh_tavern/lib/src/io/deepseek_export.dart).
 */
function fromDeepSeekSession(c: Record<string, unknown>, fileId?: string): ImportedChat | null {
  const raw = new Map<number, Record<string, unknown>>();
  for (const m of list(c.messages).map(obj)) if (typeof m.id === 'number') raw.set(m.id, m);
  if (!raw.size) return null;
  // The branch on screen: back from current_message_id (or the newest message with any text) to the root.
  const hasText = (m: Record<string, unknown>) => list(m.fragments).some((f) => typeof obj(f).content === 'string' && (obj(f).content as string).trim() !== '');
  const newest = Math.max(...[...raw].filter(([, m]) => hasText(m)).map(([id]) => id), Math.min(...raw.keys()));
  let at = typeof c.current_message_id === 'number' && raw.has(c.current_message_id) ? c.current_message_id : newest;
  const path: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  while (raw.has(at) && !seen.has(at)) {
    seen.add(at);
    const m = raw.get(at)!;
    path.unshift(m);
    if (typeof m.parent_id !== 'number') break;
    at = m.parent_id;
  }
  const messages: ImportedMessage[] = [];
  for (const m of path) {
    const user = String(m.role ?? '').toUpperCase() === 'USER';
    const text: string[] = [];
    const think: string[] = [];
    for (const f of list(m.fragments).map(obj)) {
      const type = String(f.type ?? '').toUpperCase();
      const content = typeof f.content === 'string' ? f.content : '';
      if ((type === 'REQUEST' || type === 'RESPONSE' || type === 'TEMPLATE_RESPONSE') && content) text.push(content);
      else if (type === 'THINK' && content) think.push(content);
      else if (type === 'FILE' && user) for (const file of list(f.files).map(obj)) if (typeof file.file_name === 'string') text.push(`〔${file.file_name}〕`);
    }
    const body = text.join('\n\n').trim();
    // A reply that failed before a word is not a message.
    if (!body) continue;
    const time = ms(m.inserted_at) || undefined;
    const model = !user ? str(m.model) : undefined;
    const thought = think.join('\n\n').trim();
    messages.push({ role: user ? 'user' : 'assistant', text: body, ...(thought && !user ? { think: thought } : {}), ...(time ? { time } : {}), ...(model ? { model } : {}) });
  }
  if (!messages.length) return null;
  const times = messages.map((m) => m.time ?? 0).filter(Boolean);
  const id = fileId ?? str(c.id) ?? hash(JSON.stringify(messages[0]));
  return {
    id: `deepseek:${id}`,
    title: (str(c.title) ?? '').replace(/\s+/g, ' ').trim() || messages[0].text.slice(0, 20),
    createdAt: ms(c.inserted_at) || (times.length ? Math.min(...times) : Date.now()),
    updatedAt: ms(c.updated_at) || (times.length ? Math.max(...times) : Date.now()),
    source: 'deepseek',
    messages,
  };
}
const isDeepSeekSession = (c: Record<string, unknown>) => list(c.messages).some((m) => Array.isArray(obj(m).fragments));

/** The conversation id DeepSeek's export puts in a file's name (`chat_sessions/<id>.json`). */
const deepSeekFileId = (name?: string) => name?.match(/(?:^|\/)chat_sessions\/([^/]+)\.json$/i)?.[1];

/** One JSON document → the conversations in it. [file]: its name (inside a zip: its path there). */
export function parseJson(v: unknown, file?: string): ImportedChat[] {
  const root = Array.isArray(v) ? v : isConversationList(v) ? list(obj(v).conversations ?? obj(v).items) : [v];
  const out: ImportedChat[] = [];
  for (const raw of root) {
    const c = obj(raw);
    const chat = c.mapping
      ? fromMapping(c)
      : Array.isArray(c.events)
        ? fromDshLog(c)
        : isDeepSeekSession(c)
          ? fromDeepSeekSession(c, root.length === 1 ? deepSeekFileId(file) : undefined)
          : Array.isArray(c.messages)
            ? fromPlain(c)
            : null;
    if (chat) out.push(chat);
  }
  return out;
}

/** Files in an export that hold no conversations (DeepSeek's index and account files): skipped, not counted as unreadable. */
export const NOT_CONVERSATIONS = /(?:^|\/)(?:chat_session_index|user|users|shared_conversations|message_feedback|model_comparisons)\.json$/i;
const isConversationList = (v: unknown) => Array.isArray(obj(v).conversations) || Array.isArray(obj(v).items);

// ---------------------------------------------------------------- storage (IndexedDB on this device)

export const imported = signal<ImportedSummary[]>([]);

const DB = 'api-demo-history';
const STORE = 'chats';
let memory: Map<string, ImportedChat> | null = null; // when IndexedDB is unavailable

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    t.onerror = () => reject(t.error);
  });
}

const summary = (c: ImportedChat): ImportedSummary => ({
  id: c.id,
  title: c.title,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  source: c.source,
  count: c.messages.length,
  preview: c.messages.find((m) => m.role === 'assistant')?.text.slice(0, 80) ?? '',
});

async function all(): Promise<ImportedChat[]> {
  if (memory) return [...memory.values()];
  const r = await tx<ImportedChat[]>('readonly', (s) => s.getAll());
  if (r === undefined) {
    memory = new Map();
    return [];
  }
  return r;
}

export async function loadImported() {
  imported.value = (await all()).map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Saves; a conversation already imported (same source and id) is replaced, not duplicated. */
export async function saveImported(chats: ImportedChat[]): Promise<{ added: number; updated: number }> {
  const have = new Set(imported.value.map((c) => c.id));
  const added = chats.filter((c) => !have.has(c.id)).length;
  if (!memory && !(await db())) memory = new Map();
  if (memory) for (const c of chats) memory.set(c.id, c);
  else await tx('readwrite', (s) => void chats.forEach((c) => s.put(c)));
  await loadImported();
  return { added, updated: chats.length - added };
}

export async function getImported(id: string): Promise<ImportedChat | undefined> {
  if (memory) return memory.get(id);
  return tx<ImportedChat>('readonly', (s) => s.get(id));
}

export async function deleteImported(id: string) {
  if (memory) memory.delete(id);
  else await tx('readwrite', (s) => s.delete(id));
  await loadImported();
}

export async function clearImported() {
  if (memory) memory.clear();
  else await tx('readwrite', (s) => s.clear());
  await loadImported();
}

/** The old conversation as Markdown, for 「接着聊」. */
export function toMarkdown(c: ImportedChat, limit = 12000): string {
  const lines = [`# ${c.title}`, ''];
  for (const m of c.messages) lines.push(`**${m.role === 'user' ? '我' : 'AI'}**：${m.text}`, '');
  const md = lines.join('\n');
  return md.length > limit ? md.slice(md.length - limit) : md;
}
