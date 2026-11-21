// MaiDSH (陪伴套件, maidsh/CONTRACT.md): the routes its DSH plugins register on the engine, called
// through the local proxy like the persona library's. Reads are GET; writes are POST with a JSON
// body (the plugins refuse other content types and other origins). Every answer is
// `{ ok: true, value }` or `{ ok: false, error }` (4xx), and `error` is meant for the person.
//
// 404: that plugin isn't running in the engine (not installed, or installed and the engine not
// restarted). 401 / 403: not this device's engine, or no longer signed in — treated as unreachable.

import { signal } from '@preact/signals';
import { installed } from '../plugins/frontend';

export type Module = 'core' | 'mood' | 'bond' | 'memory' | 'expression' | 'initiative';

export const PLUGIN_ID: Record<Module, string> = {
  core: '@api-demo/maidsh-core',
  mood: '@api-demo/maidsh-mood',
  bond: '@api-demo/maidsh-bond',
  memory: '@api-demo/maidsh-memory',
  expression: '@api-demo/maidsh-expression',
  initiative: '@api-demo/maidsh-initiative',
};

/** Installed (and on) in DSMO: the engine may still need a restart before its routes answer. */
export const hasModule = (m: Module) => installed.value.some((x) => x.id === PLUGIN_ID[m] && x.enabled);

export class MaidshError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  /** The plugin's routes aren't there. */
  get missing() {
    return this.status === 404;
  }
}

/**
 * Which 档案 (CONTRACT §13) the 陪伴 page reads and writes: the one the current 人设 uses, or
 * the one picked in the list (maidsh/profiles.ts sets it). Without `?profile=` the routes answer
 * for the default 档案, which after the first switch may belong to another 人设.
 */
export const shownProfile = signal('default');
const forProfile = (path: string) => `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(shownProfile.value)}`;

async function answer<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { ok?: boolean; value?: unknown; error?: string } | null;
  if (res.status === 404) throw new MaidshError('not running', 404);
  if (res.status === 401 || res.status === 403) throw new MaidshError('连不上引擎', res.status);
  if (!res.ok || !j || j.ok === false) throw new MaidshError(j?.error || `HTTP ${res.status}`, res.status);
  return j.value as T;
}

export const get = async <T>(path: string): Promise<T> => answer<T>(await fetch(path, { credentials: 'same-origin' }));

export const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> =>
  answer<T>(await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

/** A failed write whose body still carries details (learn's `duplicateOf`). */
export async function postRaw(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; value?: unknown; error?: string; [k: string]: unknown }> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return { ...j, ok: res.ok && j.ok !== false, status: res.status } as never;
}

// ---------------------------------------------------------------- 总览: GET /api/maidsh/state

export interface MoodState {
  label: string;
  valence: number;
  arousal: number;
  updatedAt: number;
  personality?: { neuroticism: number; agreeableness: number };
}
export interface BondState {
  value: number;
  level: number;
  levelName: string;
  levels: string[];
  streak: number;
  /** Newest first. */
  recent: { at: number; label: string; delta: number; intensity?: number; source?: string }[];
}
export interface InitiativeState {
  enabled: boolean;
  today: number;
  perDay: number;
  nextAt: number;
  followups: { at: number; reason: string }[];
  ignored: number;
  stopped: boolean;
  quiet: string;
}
export interface Overview {
  lastFeeling: { label: string; intensity: number } | null;
  lastTurnAt: number;
  lastError: string;
  aspects: { id: string; title: string; state: Record<string, unknown> }[];
}
export const aspect = <T>(o: Overview | null, id: string): T | null => (o?.aspects.find((a) => a.id === id)?.state as T | undefined) ?? null;

export const readOverview = () => get<Overview>(forProfile('/api/maidsh/state'));

// ---------------------------------------------------------------- 记忆: /api/maidsh-memory/*

export type FactCat = 'identity' | 'relation' | 'stable' | 'pref' | 'recent' | 'uncertain' | 'world';
export interface Fact {
  id: string;
  text: string;
  cat: FactCat;
  source: 'auto' | 'user' | 'import';
  pinned: boolean;
  r: number;
  quote?: string;
  createdAt: number;
}
export interface Episode {
  id: string;
  at: string;
  title: string;
  summary: string;
  feeling?: { label: string; intensity?: number } | null;
  story?: boolean;
  salience: number;
  pinned: boolean;
  r: number;
}
export interface MemoryList {
  facts: Fact[];
  episodes: Episode[];
  profile: { impression: string; short: string };
  turn: number;
}
export const readMemory = () => get<MemoryList>(forProfile('/api/maidsh-memory/list'));
export const mutateMemory = (body: Record<string, unknown>) => post<MemoryList & { imported?: number }>(forProfile('/api/maidsh-memory/mutate'), body);

// ---------------------------------------------------------------- 表达: /api/maidsh-expression/*

export interface Expression {
  id: string;
  kind: 'style' | 'slang';
  when?: string[];
  say: string;
  means?: string;
  tone?: 'playful' | 'soft' | 'neutral' | string;
  n: number;
  weight: number;
  pinned: boolean;
  source?: string;
  seen?: number;
}
export const readExpression = () => get<{ items: Expression[]; turn: number }>(forProfile('/api/maidsh-expression/list'));
export const mutateExpression = (body: Record<string, unknown>) => post<{ items: Expression[]; turn: number }>(forProfile('/api/maidsh-expression/mutate'), body);

// ---------------------------------------------------------------- 主动: /api/maidsh-initiative/*

export const readInitiative = () => get<InitiativeState>(forProfile('/api/maidsh-initiative/state'));
export const mutateInitiative = (body: Record<string, unknown>) => post<InitiativeState>(forProfile('/api/maidsh-initiative/mutate'), body);

// ---------------------------------------------------------------- 学习与导入: /api/maidsh/learn, /api/maidsh/jobs

export type TextType = 'aboutme' | 'backstory' | 'story' | 'chatlog' | 'session';
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'undone';
export interface Job {
  id: string;
  textType: TextType;
  title: string;
  status: JobStatus;
  done: number;
  total: number;
  est: { chunks: number; calls: number; tokens: number; minutes: number };
  added: number;
  errors: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  duplicateOf?: string;
}
/**
 * Learn (or with dryRun, only estimate): `{ textType, title, text }` goes into the shown 档案;
 * `{ kind: 'session', sessionId | messages }` into that conversation's own 档案 (the engine decides).
 */
export const learn = (body: Record<string, unknown>) => postRaw('/api/maidsh/learn', body.kind === 'session' ? body : { profile: shownProfile.value, ...body });
export const readJobs = () => get<Job[]>('/api/maidsh/jobs');
export const actOnJob = (action: 'cancel' | 'pause' | 'resume' | 'undo', id: string) => post<Job>('/api/maidsh/jobs', { action, id });
