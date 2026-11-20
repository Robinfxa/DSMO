// 设定集 (dsmo-lore, maidsh/LORE-DESIGN.md): the engine plugin's routes under /api/dsmo-lore, the
// shapes they answer with, and the few signals the pages and menus share (the works list, which
// work each conversation uses). Reads are GET, writes POST + JSON; `{ ok, value }` or
// `{ ok: false, error }` with a message meant for people.

import { signal } from '@preact/signals';
import { hasUpdate, installed } from '../plugins/frontend';

export const LORE_ID = '@api-demo/dsmo-lore';
export const hasLore = () => installed.value.some((x) => x.id === LORE_ID && x.enabled);
const API = '/api/dsmo-lore';

export class LoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The route isn't there: not running in the engine (not restarted, or an older version). */
    readonly missing = false,
  ) {
    super(message);
  }
}
/** What to say when the plugin isn't running in the engine. */
export const missingText = () => (hasUpdate(LORE_ID) ? '设定集要先更新：插件 › 已安装 › 更新，再重启引擎。' : '设定集还没在引擎里运行：重启引擎后再试。');

async function answer<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { ok?: boolean; value?: unknown; error?: string } | null;
  // a 404 of the plugin's own (找不到这部作品) carries its message; one with none is a missing route
  if (res.status === 404 && (!j?.error || j.error === 'not found')) throw new LoreError(missingText(), 404, true);
  if (res.status === 401 || res.status === 403) throw new LoreError('连不上引擎', res.status);
  if (!res.ok || !j || j.ok === false) throw new LoreError(j?.error || `HTTP ${res.status}`, res.status);
  return j.value as T;
}
const get = async <T>(path: string): Promise<T> => answer<T>(await fetch(API + path, { credentials: 'same-origin' }));
const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> =>
  answer<T>(await fetch(API + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

// ---------------------------------------------------------------- shapes

export interface WorkSummary {
  id: string;
  title: string;
  chapter: number;
  characters: number;
  entries: number;
  states: number;
  updatedAt: number;
}
export type CardField = 'summary' | 'appearance' | 'personality' | 'background' | 'voice' | 'extra';
export interface Character {
  id: string;
  name: string;
  aliases: string[];
  tier: 'main' | 'side';
  secret: boolean;
  debut?: number;
  card: Partial<Record<CardField, string>>;
  source: string;
  createdAt: number;
}
export type Logic = 'and-any' | 'and-all' | 'not-all' | 'not-any';
export interface Entry {
  id: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  logic: Logic;
  selective: boolean;
  constant: boolean;
  enabled: boolean;
  order: number;
  content: string;
  caseSensitive: boolean;
  wholeWords: boolean;
  from?: number;
  until?: number;
  st?: Record<string, unknown>;
  source: string;
}
export type Op = 'replace' | 'add' | 'remove';
export interface State {
  id: string;
  /** A character's or an entry's id. */
  subject: string;
  key: string;
  op: Op;
  value: string;
  from: number;
  until?: number;
  evidence?: string;
  supersededBy?: string;
  source: string;
  createdAt: number;
}
export interface Relation {
  id: string;
  /** Character ids, a < b. */
  a: string;
  b: string;
  key: string;
  value: string;
  from: number;
  until?: number;
  evidence?: string;
  supersededBy?: string;
  source?: string;
  createdAt: number;
}
export interface ImportJob {
  id: string;
  kind: 'card' | 'worldbook';
  filename: string;
  at: number;
  added: { characters: string[]; entries: string[] };
  merged?: string[];
  undone?: boolean;
}
export interface Work {
  id: string;
  title: string;
  cursor: { chapter: number };
  settings: { userName: string; scanTail: number };
  updatedAt: number;
  characters: Character[];
  lore: Entry[];
  states: State[];
  relations: Relation[];
  imports: ImportJob[];
}
/** Which work a conversation uses, and from which layer. */
export interface Binding {
  sessionId: string;
  work: string | null;
  from: 'conversation' | 'workspace' | 'default' | 'bot';
  workspaceId: string;
  /** This conversation's own setting: a work, 'off', or null (follows its workspace). */
  conversation?: string | null;
}
export interface Bindings {
  default: string;
  conversations: Record<string, string>;
  workspaces: Record<string, string>;
  bots: number;
}
export interface RecordResult {
  written: { id: string; subject: string; key: string; op: Op; value: string; from: number }[];
  errors: string[];
  cursorMoved: boolean;
  chapter: number;
}

// ---------------------------------------------------------------- calls

export const listWorks = () => get<WorkSummary[]>('/works');
export const readWork = (id: string) => get<Work>(`/work?id=${encodeURIComponent(id)}`);
export const mutate = <T>(action: string, body: Record<string, unknown> = {}) => post<T>('/mutate', { action, ...body });

export const readBinding = (sessionId: string) => get<Binding>(`/binding?sessionId=${encodeURIComponent(sessionId)}`);
export const readBindings = () => get<Bindings>('/binding');
/** work: a work id, 'off', or null (follow the layer above). */
export const bindConversation = (sessionId: string, work: string | null) => post<Binding>('/binding', { action: 'set', sessionId, work });
export const bindWorkspace = (workspaceId: string, work: string | null) => post<Bindings>('/binding', { action: 'set-workspace', workspaceId, work });
export const bindDefault = (work: string) => post<Bindings>('/binding', { action: 'set-default', work });

export interface ImportBody {
  work?: string;
  title?: string;
  kind: 'card' | 'worldbook';
  filename: string;
  json?: unknown;
  pngBase64?: string;
  userName?: string;
  dryRun?: boolean;
  onConflict?: 'merge' | 'new' | 'skip';
  force?: boolean;
}
export interface ImportAnswer {
  report: string;
  characters?: number;
  entries?: number;
  conflicts?: string[];
  duplicate?: boolean;
  needsChoice?: boolean;
  work?: WorkSummary;
  jobId?: string;
}
export const importFile = (body: ImportBody) => post<ImportAnswer>('/import', body as unknown as Record<string, unknown>);
export const undoImport = (work: string, jobId: string) => post<{ removed: { characters: number; entries: number }; kept: string[]; merged: string[] }>('/import/undo', { work, jobId });
export const exportWork = (work: string, format: 'native' | 'st-worldbook') => get<unknown>(`/export?work=${encodeURIComponent(work)}&format=${format}`);

// ---------------------------------------------------------------- shared state

/** The works, newest change first (null until read). */
export const works = signal<WorkSummary[] | null>(null);
export async function refreshWorks() {
  works.value = await listWorks();
  return works.value;
}
export const workTitle = (id: string | null | undefined) => (id ? works.value?.find((w) => w.id === id)?.title : undefined);

/** Which work each conversation uses, as last read; null when it can't be read (not running). */
export const bindings = signal<Record<string, Binding | null>>({});
export async function refreshBinding(sessionId: string) {
  try {
    const b = await readBinding(sessionId);
    bindings.value = { ...bindings.value, [sessionId]: b };
    return b;
  } catch {
    bindings.value = { ...bindings.value, [sessionId]: null };
    return null;
  }
}
/** After a change that can move many conversations (a workspace, the default, a work deleted). */
export function forgetBindings() {
  bindings.value = {};
}

/** The chapter being looked at on a work's pages (dragging the timeline); null: where it's written up to. */
export const loreView = signal<{ work: string; ch: number } | null>(null);

export const chapterName = (n: number) => (n > 0 ? `第 ${n} 章` : '开写前');
