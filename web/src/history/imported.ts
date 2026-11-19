// 导入历史对话. DSH has no endpoint that creates a session from an old log
// (dsh-Go's share-codes design says so: it replays instead), so imported
// conversations live on this device: read-only, listed with the others, and
// 「接着聊」 starts a new conversation that carries the old one as context.
//
// Accepted files: the export zip / conversations.json from the DeepSeek or
// ChatGPT websites (both use a `mapping` tree), this app's own JSON export
// (a DSH session log), and a plain [{ title, messages: [{ role, content }] }].

import { signal } from '@preact/signals';
import { unzipSync, strFromU8 } from 'fflate';
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

/** One JSON document → the conversations in it. */
export function parseJson(v: unknown): ImportedChat[] {
  const root = Array.isArray(v) ? v : isConversationList(v) ? list(obj(v).conversations ?? obj(v).items) : [v];
  const out: ImportedChat[] = [];
  for (const raw of root) {
    const c = obj(raw);
    const chat = c.mapping ? fromMapping(c) : Array.isArray(c.events) ? fromDshLog(c) : Array.isArray(c.messages) ? fromPlain(c) : null;
    if (chat) out.push(chat);
  }
  return out;
}
const isConversationList = (v: unknown) => Array.isArray(obj(v).conversations) || Array.isArray(obj(v).items);

function readBytes(f: Blob): Promise<Uint8Array> {
  if (typeof f.arrayBuffer === 'function') return f.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(f);
  });
}

/** Files picked by the user → conversations (zip archives are opened in place). */
export async function parseFiles(files: File[]): Promise<{ chats: ImportedChat[]; skipped: number }> {
  const chats: ImportedChat[] = [];
  let skipped = 0;
  const take = (name: string, text: string) => {
    try {
      const found = parseJson(JSON.parse(text));
      found.length ? chats.push(...found) : skipped++;
    } catch {
      if (/\.json$/i.test(name)) skipped++;
    }
  };
  for (const f of files) {
    const buf = await readBytes(f);
    if (/\.zip$/i.test(f.name) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
      const entries = unzipSync(buf, { filter: (e) => /\.json$/i.test(e.name) && !e.name.startsWith('__MACOSX') });
      for (const [name, data] of Object.entries(entries)) take(name, strFromU8(data));
    } else take(f.name, strFromU8(buf));
  }
  const byId = new Map(chats.map((c) => [c.id, c]));
  return { chats: [...byId.values()], skipped };
}

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
