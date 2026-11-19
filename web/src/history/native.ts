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

export async function nativeImportSupported(): Promise<boolean> {
  try {
    const r = await dshGoTransport().get(IMPORT_PATH);
    const j = obj(r.json);
    return r.status === 200 && j.supported === true && j.version === 1;
  } catch {
    return false;
  }
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

export interface ImportPreview {
  count: number;
  messages: number;
  from: number;
  to: number;
  /** Already in the conversation list from an earlier import. */
  already: number;
}

export async function previewImport(chats: ImportedChat[]): Promise<ImportPreview> {
  const have = new Set(sessions.value.map((s) => s.sessionId));
  let already = 0;
  for (const c of chats) if (have.has(await importedSessionId(c.source, sourceIdOf(c)))) already++;
  return {
    count: chats.length,
    messages: chats.reduce((n, c) => n + c.messages.length, 0),
    from: Math.min(...chats.map((c) => c.createdAt)),
    to: Math.max(...chats.map((c) => c.updatedAt)),
    already,
  };
}

/** Same-source runs of at most BATCH conversations and BATCH_BYTES of JSON. */
export function batches(chats: ImportedChat[]) {
  const out: { source: ImportedChat['source']; items: { chat: ImportedChat; wire: ReturnType<typeof toWire> }[] }[] = [];
  const tooLarge: ImportedChat[] = [];
  const enc = new TextEncoder();
  let bytes = 0;
  for (const chat of chats) {
    const wire = toWire(chat);
    const size = enc.encode(JSON.stringify(wire)).length;
    if (size > MAX_ONE) {
      tooLarge.push(chat);
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.source === chat.source && last.items.length < BATCH && bytes + size <= BATCH_BYTES) {
      last.items.push({ chat, wire });
      bytes += size;
    } else {
      out.push({ source: chat.source, items: [{ chat, wire }] });
      bytes = size;
    }
  }
  return { batches: out, tooLarge };
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

/**
 * Sends the chats batch by batch; `importRun` follows along. With removeLocal,
 * on-device copies (imported.ts) that reached the list are deleted afterwards.
 */
export async function runImport(chats: ImportedChat[], { removeLocal = false } = {}): Promise<ImportRun> {
  stopRequested = false;
  const { batches: queue, tooLarge } = batches(chats);
  const run: ImportRun = { total: chats.length, done: tooLarge.length, imported: 0, skipped: 0, failed: tooLarge.map((c) => ({ title: c.title, reason: REASON['too-large'] })), running: true, stopped: false };
  const publish = () => (importRun.value = { ...run, failed: [...run.failed] });
  const landed: ImportedChat[] = [];
  publish();
  for (const batch of queue) {
    if (stopRequested) {
      run.stopped = true;
      break;
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
      else run.failed.push({ title: chat.title, reason: REASON[str(results[i]?.code) ?? ''] ?? '没有导入' });
      if (status === 'imported' || status === 'skipped') landed.push(chat);
    });
    run.done += batch.items.length;
    publish();
  }
  run.running = false;
  publish();
  if (run.imported) void refreshSessions();
  if (removeLocal) for (const c of landed) await deleteImported(c.id);
  return run;
}
