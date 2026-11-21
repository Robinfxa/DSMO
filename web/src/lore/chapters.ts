// What was true at a chapter, worked out from a work's records the way the engine does
// (maidsh/lore/lib/core.mjs stateAt / relationAt / keyMode), so the lists can show it without
// another request.

import type { Op, Relation, State, Work } from './api';

const inRange = (x: { from?: number; until?: number }, ch: number) => (x.from === undefined || x.from <= ch) && (x.until === undefined || x.until === null || x.until >= ch);
const byTime = <T extends { from: number; createdAt: number }>(a: T, b: T) => a.from - b.from || a.createdAt - b.createdAt;

export interface StateNow {
  key: string;
  value: string;
  from: number;
}

/** Everything about [subject] at chapter [ch]; the latest change first. */
export function stateAt(work: Work, subject: string, ch: number): StateNow[] {
  const by = new Map<string, { key: string; value?: string; items?: string[]; from: number }>();
  for (const s of work.states.filter((s) => s.subject === subject && !s.supersededBy && inRange(s, ch)).sort(byTime)) {
    if (s.op === 'replace') by.set(s.key, { key: s.key, value: s.value, from: s.from });
    else {
      const items = by.get(s.key)?.items ?? [];
      const next = s.op === 'add' ? (items.includes(s.value) ? items : [...items, s.value]) : items.filter((v) => v !== s.value);
      by.set(s.key, { key: s.key, items: next, from: s.from });
    }
  }
  return [...by.values()]
    .map((x) => ({ key: x.key, value: x.items ? x.items.join('、') : (x.value ?? ''), from: x.from }))
    .filter((x) => x.value)
    .sort((a, b) => b.from - a.from);
}

/** The two at chapter [ch]: [{ key, value, from, id }]. */
export function relationAt(work: Work, a: string, b: string, ch: number): (StateNow & { id: string })[] {
  const [x, y] = a < b ? [a, b] : [b, a];
  const by = new Map<string, Relation>();
  for (const r of work.relations.filter((r) => r.a === x && r.b === y && !r.supersededBy && inRange(r, ch)).sort(byTime)) by.set(r.key, r);
  return [...by.values()].map((r) => ({ key: r.key, value: r.value, from: r.from, id: r.id }));
}

/** Every pair with a relation at chapter [ch], latest first. */
export function relationsAt(work: Work, ch: number) {
  const pairs = new Set(work.relations.map((r) => `${r.a}\u0000${r.b}`));
  const out: { a: string; b: string; key: string; value: string; from: number }[] = [];
  for (const p of pairs) {
    const [a, b] = p.split('\u0000');
    for (const r of relationAt(work, a, b, ch)) out.push({ a, b, key: r.key, value: r.value, from: r.from });
  }
  return out.sort((p, q) => q.from - p.from);
}

/** Whether [key] holds one value or a list: set by its first record. null if never written. */
export function keyMode(work: Work, subject: string, key: string): 'single' | 'list' | null {
  const first = work.states.filter((s) => s.subject === subject && s.key === key).sort((a, b) => a.createdAt - b.createdAt)[0];
  return first ? (first.op === 'replace' ? 'single' : 'list') : null;
}
/** Items that are naturally a list the first time they're recorded (持有: 断弦琴、玉佩…). */
const LIST_KEYS = new Set(['持有', '随身', '物品', '技能']);
export const defaultOp = (work: Work, subject: string, key: string): Op => {
  const mode = keyMode(work, subject, key);
  return mode === 'list' || (mode === null && LIST_KEYS.has(key)) ? 'add' : 'replace';
};

/** The records behind [subject]'s state, in chapter order (rewritten ones left out). */
export const historyOf = (work: Work, subject: string): State[] => work.states.filter((s) => s.subject === subject && !s.supersededBy).sort(byTime);
export const pairHistory = (work: Work, a: string, b: string): Relation[] => {
  const [x, y] = a < b ? [a, b] : [b, a];
  return work.relations.filter((r) => r.a === x && r.b === y && !r.supersededBy).sort(byTime);
};

export const OP_MARK: Record<Op, string> = { replace: '=', add: '+', remove: '−' };
export const span = (x: { from?: number; until?: number }) =>
  x.until !== undefined && x.until !== null ? `第 ${x.from ?? 0}–${x.until} 章` : (x.from ?? 0) > 0 ? `第 ${x.from} 章起` : '开写前起';
/** Recorded by the AI: through its tool, or sorted out after a turn (auto:<turn>). */
export const byAi = (source: string | undefined) => source === 'tool' || !!source?.startsWith('auto:');
