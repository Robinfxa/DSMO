// 导出历史对话: conversations as DSMO's own JSON, the format 导入历史对话 reads back
// (imported.ts fromDshLog): `[{sessionId, header: {title}, events: [{seq, time, type, data}]}]`.
// Each conversation's whole log is read through `session/page`, newest pages first.
// (DSH's `/api/session.export` is a zip of raw log files, which the importer can't read.)

import { getClient } from '../state/store';

/** Records per `session/page` call. */
const PAGE = 200;
/** A conversation longer than this many pages (200 × 500 records) is cut at its newest part. */
const MAX_PAGES = 500;

interface ExportedEvent {
  seq: number;
  time: number;
  type: string;
  data: unknown;
}

async function sessionEvents(sessionId: string): Promise<ExportedEvent[]> {
  const client = getClient();
  const through = await client.lastSeq(sessionId);
  if (through < 0) return [];
  const out: ExportedEvent[] = [];
  let before: number | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await client.history(sessionId, through, before, PAGE);
    if (!page.events.length) break;
    out.unshift(...page.events.map(({ seq, time, type, data }) => ({ seq, time, type, data })));
    if (!page.hasMore) break;
    before = Math.min(...page.events.map((e) => e.seq));
  }
  return out;
}

/** The conversations as one JSON text; [progress] after each (done, total). Unreadable ones are skipped. */
export async function exportConversations(
  list: { sessionId: string; title?: string }[],
  progress?: (done: number, total: number) => void,
): Promise<{ json: string; count: number; failed: number }> {
  const parts: string[] = [];
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    try {
      const events = await sessionEvents(s.sessionId);
      if (events.length) parts.push(JSON.stringify({ sessionId: s.sessionId, header: { title: s.title ?? '' }, events }));
    } catch {
      failed++;
    }
    progress?.(i + 1, list.length);
  }
  return { json: `[\n${parts.join(',\n')}\n]\n`, count: parts.length, failed };
}

/** A file name for an export made now. */
export const exportFileName = (what: string) => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `DSMO-${what}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`.replace(/[\\/:*?"<>|]/g, '_');
};
