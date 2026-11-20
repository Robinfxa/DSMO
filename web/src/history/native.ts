// 导入到对话列表: parsed chats go to dsh-go-bridge's session import
// (runtime/bridge/dsh-go-bridge/lib/session-import.js in dsh-Go), which writes each
// one as a real Session on the engine's host — listed with its original date,
// opened like any chat, and continued with the old turns as model history.
//
//   GET  /dsh-go/v1/sessions/import  {supported, version: 1}
//   POST /dsh-go/v1/sessions/import  {source, conversations} -> {results: [{sourceId, status, sessionId?, code?}]}
//
// Hosts without the route (a remote host on an older bridge) keep the
// on-device read-only import in imported.ts.
//
// A conversation over 4000 messages or 7 MiB goes alone, in parts, when the bridge says
// `parts: true` (patch 0011): each part ≤ PART_MESSAGES messages and PART_BYTES of JSON,
// in order, with `part: {index, count}`; the bridge writes the Session on the last part.

import { signal } from '@preact/signals';
import { obj, list, str } from '../engine/json';
import { dshGoTransport } from '../plugins/dshgo';
import { refreshSessions, sessions } from '../state/store';
import { importedSessionId } from './import-id';
import { deleteImported, type ImportedChat } from './imported';

export const IMPORT_PATH = '/dsh-go/v1/sessions/import';
const BATCH = 20;
const BATCH_BYTES = 3 * 1024 * 1024;
/** The bridge reads at most 8 MiB per request. */
const MAX_ONE = 7 * 1024 * 1024;
/** One part of a long conversation (the bridge takes 4000 messages a request). */
const PART_MESSAGES = 3000;
const PART_BYTES = 5 * 1024 * 1024;

/** Whether the bridge takes long conversations in parts (patch 0011); set by nativeImportSupported. */
let partsSupported = false;

export async function nativeImportSupported(): Promise<boolean> {
  try {
    const r = await dshGoTransport().get(IMPORT_PATH);
    const j = obj(r.json);
    partsSupported = j.parts === true;
    return r.status === 200 && j.supported === true && j.version === 1;
  } catch {
    return false;
  }
}

type Wire = ReturnType<typeof toWire>;

/** A long conversation cut into parts of at most PART_MESSAGES messages and about PART_BYTES of JSON. */
export function splitParts(wire: Wire, { maxMessages = PART_MESSAGES, maxBytes = PART_BYTES } = {}): Wire['messages'][] {
  const enc = new TextEncoder();
  const parts: Wire['messages'][] = [];
  let cur: Wire['messages'] = [];
  let bytes = 0;
  for (const m of wire.messages) {
    const size = enc.encode(JSON.stringify(m)).length + 1;
    if (cur.length && (cur.length >= maxMessages || bytes + size > maxBytes)) {
      parts.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(m);
    bytes += size;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/** The conversation's id inside its source (ImportedChat ids are `<source>:<id>`). */
export const sourceIdOf = (c: ImportedChat) => (c.id.startsWith(`${c.source}:`) ? c.id.slice(c.source.length + 1) : c.id);

export { importedSessionId } from './import-id';

export function toWire(c: ImportedChat) {
  return {
    sourceId: sourceIdOf(c),
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messages: c.messages.map((m) => ({
      role: m.role,
      text: m.text,
      ...(m.think ? { think: m.think } : {}),
      ...(m.model ? { model: m.model } : {}),
      ...(m.time ? { time: m.time } : {}),
    })),
  };
}

/** An array, or a stream of conversations read from the picked files (stream.ts). */
export type ChatFeed = Iterable<ImportedChat> | AsyncIterable<ImportedChat>;

export interface ImportPreview {
  count: number;
  messages: number;
  from: number;
  to: number;
  sources: ImportedChat['source'][];
  /** Already in the conversation list from an earlier import. */
  already: number;
}

/** One pass over the conversations, holding none of them. */
export async function previewImport(chats: ChatFeed): Promise<ImportPreview> {
  const have = new Set(sessions.value.map((s) => s.sessionId));
  const p: ImportPreview = { count: 0, messages: 0, from: Infinity, to: -Infinity, sources: [], already: 0 };
  for await (const c of chats) {
    p.count++;
    p.messages += c.messages.length;
    p.from = Math.min(p.from, c.createdAt);
    p.to = Math.max(p.to, c.updatedAt);
    if (!p.sources.includes(c.source)) p.sources.push(c.source);
    if (have.has(await importedSessionId(c.source, sourceIdOf(c)))) p.already++;
  }
  return p;
}

type Batch = { source: ImportedChat['source']; items: { chat: ImportedChat; wire: Wire }[] };
/** A conversation too long for one request, sent alone in parts. */
type Long = { long: ImportedChat; wire: Wire };

/** Fills same-source runs of at most BATCH conversations and BATCH_BYTES of JSON, one conversation at a time. */
class Batcher {
  private open: Batch | null = null;
  private bytes = 0;
  private readonly enc = new TextEncoder();

  /**
   * The conversation goes into the open batch; a batch that is full comes back. A conversation too
   * long for one request comes back as Long when the bridge takes parts, else 'too-large'.
   */
  add(chat: ImportedChat, parts = false): Batch | Long | 'too-large' | null {
    const wire = toWire(chat);
    const size = this.enc.encode(JSON.stringify(wire)).length;
    if (parts && (size > MAX_ONE || wire.messages.length > 4000)) return { long: chat, wire };
    if (size > MAX_ONE) return 'too-large';
    const last = this.open;
    if (last && last.source === chat.source && last.items.length < BATCH && this.bytes + size <= BATCH_BYTES) {
      last.items.push({ chat, wire });
      this.bytes += size;
      return null;
    }
    this.open = { source: chat.source, items: [{ chat, wire }] };
    this.bytes = size;
    return last;
  }

  flush(): Batch | null {
    const last = this.open;
    this.open = null;
    return last;
  }
}

/** Same-source runs of at most BATCH conversations and BATCH_BYTES of JSON. */
export function batches(chats: ImportedChat[]) {
  const out: Batch[] = [];
  const tooLarge: ImportedChat[] = [];
  const b = new Batcher();
  for (const chat of chats) {
    const r = b.add(chat);
    if (r === 'too-large') tooLarge.push(chat);
    else if (r && !('long' in r)) out.push(r);
  }
  const last = b.flush();
  if (last) out.push(last);
  return { batches: out, tooLarge };
}

/** The batches as the conversations stream in; only the batch being filled is held. */
async function* batchStream(chats: ChatFeed, tooLarge: (c: ImportedChat) => void, parts = false): AsyncGenerator<Batch | Long> {
  const b = new Batcher();
  for await (const chat of chats) {
    const r = b.add(chat, parts);
    if (r === 'too-large') tooLarge(chat);
    else if (r) yield r;
  }
  const last = b.flush();
  if (last) yield last;
}

export interface ImportFailure {
  title: string;
  reason: string;
}
export interface ImportRun {
  total: number;
  done: number;
  imported: number;
  skipped: number;
  failed: ImportFailure[];
  running: boolean;
  stopped: boolean;
  /** Set when the host stopped answering; the rest was not sent. */
  error?: string;
  /** Set when the file stopped reading part-way. */
  readError?: string;
  /** A long conversation going in parts right now. */
  part?: { title: string; index: number; count: number };
}
export const importRun = signal<ImportRun | null>(null);
let stopRequested = false;
export const stopImport = () => (stopRequested = true);

const REASON: Record<string, string> = {
  invalid: '文件里这个对话不完整',
  'write-failed': '写入失败',
  'verify-failed': '写入后读不回来',
  'too-many-deletions': '删除过太多次',
  'too-large': '对话太长',
};
/** The bridge's reasons for `invalid` (normalizeConversation in patch 0007) that the person can act on. */
const INVALID: Record<string, string> = {
  messages: '消息超过 4000 条，更新 App 后可以导入',
  'message text': '有一条消息超过 50 万字',
};
/** The same reasons when the bridge takes parts (patch 0011). */
const INVALID_PARTS: Record<string, string> = { messages: '消息超过 10 万条', 'message text': '有一条消息超过 50 万字' };
const REASON_PARTS: Record<string, string> = { 'too-large': '对话超过 256 MB', 'part-order': '分段导入被打断了，再导入一次' };

/**
 * One long conversation, part by part; resends from part 0 once if the bridge lost its place
 * (an earlier import cut off). Returns the last part's result.
 */
async function sendLong(source: ImportedChat['source'], chat: ImportedChat, wire: Wire, onPart: (index: number, count: number) => void): Promise<Record<string, unknown>> {
  const parts = splitParts(wire);
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: Record<string, unknown> = {};
    for (let index = 0; index < parts.length; index++) {
      if (stopRequested) return { status: 'stopped' };
      onPart(index, parts.length);
      const r = await dshGoTransport().post(IMPORT_PATH, { source, conversations: [{ ...wire, messages: parts[index], part: { index, count: parts.length } }] });
      if (r.status !== 200) throw new Error(str(obj(obj(r.json).error).message) ?? `HTTP ${r.status}`);
      result = obj(list(obj(r.json).results)[0]);
      const status = str(result.status);
      if (status === 'partial') continue;
      break; // imported, skipped (at part 0) or failed
    }
    if (str(result.code) !== 'part-order') return result;
  }
  return { status: 'failed', code: 'part-order' };
}

/**
 * Sends the chats batch by batch as they are read; `importRun` follows along
 * (pass `total` from the preview when [chats] is a stream). With removeLocal,
 * on-device copies (imported.ts) that reached the list are deleted afterwards.
 */
export async function runImport(chats: ChatFeed, { removeLocal = false, total }: { removeLocal?: boolean; total?: number } = {}): Promise<ImportRun> {
  stopRequested = false;
  const run: ImportRun = { total: total ?? (Array.isArray(chats) ? chats.length : 0), done: 0, imported: 0, skipped: 0, failed: [], running: true, stopped: false };
  const publish = () => (importRun.value = { ...run, total: Math.max(run.total, run.done), failed: [...run.failed] });
  const landed: string[] = [];
  publish();
  const parts = partsSupported;
  const reasonOf = (r: Record<string, unknown>) => {
    const code = str(r.code) ?? '';
    if (code === 'invalid') return (parts ? INVALID_PARTS : INVALID)[str(r.reason) ?? ''] || REASON.invalid;
    return (parts && REASON_PARTS[code]) || REASON[code] || '没有导入';
  };
  const queue = batchStream(
    chats,
    (c) => {
      run.failed.push({ title: c.title, reason: REASON['too-large'] });
      run.done++;
    },
    parts,
  );
  try {
    for await (const batch of queue) {
      if (stopRequested) {
        run.stopped = true;
        break;
      }
      if ('long' in batch) {
        const chat = batch.long;
        let result: Record<string, unknown>;
        try {
          result = await sendLong(chat.source, chat, batch.wire, (index, count) => {
            run.part = { title: chat.title, index, count };
            publish();
          });
        } catch (e) {
          run.error = e instanceof Error ? e.message : String(e);
          break;
        } finally {
          run.part = undefined;
        }
        const status = str(result.status);
        if (status === 'stopped') {
          run.stopped = true;
          break;
        }
        if (status === 'imported') run.imported++;
        else if (status === 'skipped') run.skipped++;
        else run.failed.push({ title: chat.title, reason: reasonOf(result) });
        if (status === 'imported' || status === 'skipped') landed.push(chat.id);
        run.done++;
        publish();
        continue;
      }
      let results: Record<string, unknown>[];
      try {
        const r = await dshGoTransport().post(IMPORT_PATH, { source: batch.source, conversations: batch.items.map((i) => i.wire) });
        if (r.status !== 200) throw new Error(str(obj(obj(r.json).error).message) ?? `HTTP ${r.status}`);
        results = list(obj(r.json).results).map(obj);
      } catch (e) {
        run.error = e instanceof Error ? e.message : String(e);
        break;
      }
      batch.items.forEach(({ chat }, i) => {
        const status = str(results[i]?.status);
        if (status === 'imported') run.imported++;
        else if (status === 'skipped') run.skipped++;
        else run.failed.push({ title: chat.title, reason: reasonOf(results[i] ?? {}) });
        if (status === 'imported' || status === 'skipped') landed.push(chat.id);
      });
      run.done += batch.items.length;
      publish();
    }
  } catch (e) {
    // the file stopped reading part-way (it went away, or the zip is damaged)
    run.readError = e instanceof Error ? e.message : String(e);
  } finally {
    // stops the reader if the loop left early
    await queue.return(undefined);
  }
  run.running = false;
  publish();
  if (run.imported) void refreshSessions();
  if (removeLocal) for (const id of landed) await deleteImported(id);
  return run;
}
