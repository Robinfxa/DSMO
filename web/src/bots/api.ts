// SPDX-FileCopyrightText: 2026 Fei2411 and the DS Bot contributors
// SPDX-License-Identifier: Apache-2.0 (the ink table and defaultColor, from DS Bot
// src/client/inks.js and characters.js via dsh-Go); the rest AGPL-3.0. See NOTICE.md.
//
// DS Bot client: the channel of the `ds-bot` DSH plugin on the host, as dsh-Go speaks it
// (packages/dsh_client/lib/src/dsbot_api.dart):
//
//   POST /api/bot        {"endpoint": "<name>", "payload": {...}}
//   200 {"ok": true, "value": ...} | {"ok": false, "error": {"code": "bot/...", "message": "..."}}
//   GET  /api/bot/feed   text/event-stream: hello | revision | live | message | stream | notice | room
//
// The page reaches both through the app's proxy, on the device's own engine
// and on SSH hosts alike.

const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const b = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const sl = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ms = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined);

export class DsBotError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 200,
  ) {
    super(message);
  }
}

/** Short words for a failed call (DS Bot's own English stays out of the interface). */
export function describeError(e: unknown): string {
  if (e instanceof DsBotError) {
    if (e.code === 'bot/read-only') return '另一个 DSH 正在管理这个团队，这里只能看';
    if (e.status === 404) return '这台主机没有装 DS Bot';
    if (e.status === 401 || e.status === 403) return '主机登录失效了';
    if (e.code === 'transport') return '没能连上引擎';
    return '没能完成，再试一次';
  }
  return '出了点意外';
}

// ---------------------------------------------------------------- models

export interface Hello {
  api?: number;
  pluginVersion: string;
  capabilities: Set<string>;
  boot: string;
  seq: number;
  revision: number;
  readOnly?: string;
  memory: boolean;
}
export interface Bot {
  id: string;
  name: string;
  role: string;
  instructions: string;
  color?: string;
  imageRef?: string;
  image?: string;
  model?: string;
  appliedModel?: string;
  effort?: string;
  sessionId: string;
  parts: string[];
  waiting: boolean;
  createdAt?: number;
  workDir?: string;
}
export interface Room {
  id: string;
  name: string;
  members: string[];
  admin?: string;
  mode: 'admin' | 'everyone' | string;
  relayLimit?: number | null;
  relayLimitDefault?: number;
  pausedCallIds: string[];
  notice: string;
  preview?: string;
  createdAt?: number;
  workDir?: string;
  parts: string[];
}
export interface Question {
  id: string;
  question: string;
  detail?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowCustom: boolean;
}
export interface ViewCard {
  id: string;
  title: string;
  view: Record<string, unknown>;
}
export interface Model {
  ref: string;
  name: string;
  providerName: string;
  needsKey: boolean;
}
export interface Work {
  botId?: string;
  since?: number;
  tool?: string;
  note?: string;
  target?: string;
  roomId?: string;
  switching: boolean;
  speaking: boolean;
}
export interface Approval {
  id: string;
  sessionId: string;
  botId: string;
  roomId?: string;
  tool: string;
  reason: string;
  at?: number;
  answerable: boolean;
}
export interface Live {
  activity: Record<string, string>;
  bots: Record<string, Work>;
  rooms: Record<string, Work[]>;
  approvals: Approval[];
}
export interface Team {
  revision: number;
  mainBotIds: string[];
  bots: Bot[];
  rooms: Room[];
  questions: Record<string, Question>;
  views: Record<string, ViewCard>;
  models: Model[];
  defaultModel?: string;
  modelsKey?: string;
  memory: boolean;
  readOnly?: string;
}
export type ItemKind = 'user' | 'bot' | 'event' | 'answer' | 'divider' | 'unknown';
export interface Item {
  kind: ItemKind;
  id?: string;
  text: string;
  time?: number;
  botId?: string;
  name?: string;
  color?: string;
  event?: string;
  role?: string;
  roomId?: string;
  images: number;
  live: boolean;
  whole?: { length: number; file: Record<string, unknown> };
}
export interface Notice {
  seq: number;
  kind: string;
  botId: string;
  name: string;
  roomId?: string;
  title?: string;
  text: string;
  time?: number;
}
export interface MemoryEntry {
  scope: 'own' | 'team' | 'group' | string;
  text: string;
  topic?: string;
  added?: string;
  by?: string;
}
export interface MemoryView {
  entries: MemoryEntry[];
  summary?: string;
  summarizing: boolean;
  error?: string;
}
export interface Totals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  calls: number;
}
export const totalTokens = (t: Totals) => t.input + t.cacheRead + t.cacheWrite + t.output;
export interface Usage {
  scanning: boolean;
  day: Totals;
  week: Totals;
  month: Totals;
  models: { key: string; name: string; totals: Totals }[];
}

const readBot = (v: unknown): Bot => {
  const m = o(v);
  const av = o(m.avatar);
  const id = s(m.id) ?? '';
  return {
    id,
    name: s(m.name) ?? '',
    role: s(m.role) ?? '',
    instructions: s(m.instructions) ?? '',
    color: s(m.color),
    imageRef: s(av.imageRef) ?? (s(av.image) ? `inline:${s(av.image)!.length}` : undefined),
    image: s(av.image),
    model: s(m.model),
    appliedModel: s(m.appliedModel),
    effort: s(m.effort),
    sessionId: s(m.sessionId) ?? id,
    parts: sl(m.parts),
    waiting: b(m.waiting) ?? false,
    createdAt: ms(m.createdAt),
    workDir: s(m.workDir),
  };
};
export const readRoom = (v: unknown): Room => {
  const m = o(v);
  return {
    id: s(m.id) ?? '',
    name: s(m.name) ?? '',
    members: sl(m.members),
    admin: s(m.admin),
    mode: s(m.mode) ?? 'admin',
    relayLimit: m.relayLimit === null ? null : n(m.relayLimit),
    relayLimitDefault: n(m.relayLimitDefault),
    pausedCallIds: (Array.isArray(m.paused) ? m.paused : []).map((x) => s(o(x).id)).filter((x): x is string => !!x),
    notice: s(m.notice) ?? '',
    preview: s(m.preview),
    createdAt: ms(m.createdAt),
    workDir: s(m.workDir),
    parts: sl(m.parts),
  };
};
const readWork = (v: unknown, botId?: string): Work => {
  const m = o(v);
  return { botId: s(m.botId) ?? botId, since: ms(m.since), tool: s(m.tool), note: s(m.note), target: s(m.target), roomId: s(m.roomId), switching: b(m.switching) ?? false, speaking: b(m.speaking) ?? false };
};
export const readItem = (v: unknown): Item => {
  const m = o(v);
  const k = s(m.kind);
  const whole = m.whole ? o(m.whole) : null;
  return {
    kind: (['user', 'bot', 'event', 'answer', 'divider'] as const).find((x) => x === k) ?? 'unknown',
    id: s(m.id),
    text: s(m.text) ?? '',
    time: ms(m.time),
    botId: s(m.botId),
    name: s(m.name),
    color: s(m.color),
    event: s(m.event),
    role: s(m.role),
    roomId: s(m.roomId),
    images: n(m.images) ?? 0,
    live: b(m.live) ?? false,
    whole: whole ? { length: n(whole.length) ?? 0, file: o(whole.file) } : undefined,
  };
};
export const sameItem = (a: Item, c: Item) => (a.id && c.id ? a.id === c.id : a.kind === c.kind && a.time === c.time && a.text === c.text);
const readNotice = (v: unknown): Notice => {
  const m = o(v);
  return { seq: n(m.seq) ?? 0, kind: s(m.kind) ?? '', botId: s(m.botId) ?? '', name: s(m.name) ?? '', roomId: s(m.roomId), title: s(m.title), text: s(m.text) ?? '', time: ms(m.time) };
};
const readTotals = (v: unknown): Totals => {
  const m = o(v);
  const r = (k: string) => Math.round(n(m[k]) ?? 0);
  return { input: r('input'), cacheRead: r('cacheRead'), cacheWrite: r('cacheWrite'), output: r('output'), calls: r('calls') };
};
const readMemory = (v: unknown): MemoryView => {
  const m = o(v);
  return {
    entries: (Array.isArray(m.entries) ? m.entries : []).map((e) => ({ scope: s(o(e).scope) ?? 'own', text: s(o(e).text) ?? '', topic: s(o(e).topic), added: s(o(e).added), by: s(o(e).by) })),
    summary: s(o(m.summary).text),
    summarizing: b(m.summarizing) ?? false,
    error: s(m.error),
  };
};

export function readState(v: unknown): { revision: number; live: Live; team?: Team } {
  const m = o(v);
  const work = o(m.work);
  const live: Live = {
    activity: Object.fromEntries(Object.entries(o(m.activity)).filter(([, x]) => typeof x === 'string')) as Record<string, string>,
    bots: Object.fromEntries(Object.entries(o(work.bots)).map(([k, x]) => [k, readWork(x, k)])),
    rooms: Object.fromEntries(Object.entries(o(work.rooms)).map(([k, x]) => [k, (Array.isArray(x) ? x : []).map((w) => readWork(w))])),
    approvals: (Array.isArray(work.approvals) ? work.approvals : []).map((a) => {
      const x = o(a);
      return { id: s(x.id) ?? '', sessionId: s(x.sessionId) ?? '', botId: s(x.botId) ?? '', roomId: s(x.roomId), tool: s(x.tool) ?? '', reason: s(x.reason) ?? '', at: ms(x.at), answerable: b(x.answerable) ?? false };
    }),
  };
  if (m.unchanged === true) return { revision: n(m.revision) ?? 0, live };
  const team: Team = {
    revision: n(m.revision) ?? 0,
    mainBotIds: sl(m.mainBotIds),
    bots: (Array.isArray(m.bots) ? m.bots : []).map(readBot),
    rooms: (Array.isArray(m.rooms) ? m.rooms : []).map(readRoom),
    questions: Object.fromEntries(
      Object.entries(o(m.questions)).map(([k, q]) => {
        const x = o(q);
        return [
          k,
          {
            id: s(x.id) ?? '',
            question: s(x.question) ?? '',
            detail: s(x.detail),
            options: (Array.isArray(x.options) ? x.options : []).filter((p) => s(o(p).label)).map((p) => ({ label: s(o(p).label)!, description: s(o(p).description) })),
            multiSelect: b(x.multiSelect) ?? false,
            allowCustom: b(x.allowCustom) ?? false,
          },
        ];
      }),
    ),
    views: Object.fromEntries(Object.entries(o(m.views)).map(([k, x]) => [k, { id: s(o(x).id) ?? '', title: s(o(x).title) ?? '', view: o(o(x).view) }])),
    models: (Array.isArray(m.models) ? m.models : []).map((x) => ({ ref: s(o(x).ref) ?? '', name: s(o(x).name) ?? s(o(x).id) ?? '', providerName: s(o(x).providerName) ?? '', needsKey: b(o(x).needsKey) ?? false })),
    defaultModel: s(m.defaultModel),
    modelsKey: s(m.modelsKey),
    memory: b(m.memory) ?? true,
    readOnly: s(m.readOnly),
  };
  return { revision: team.revision, live, team };
}

export const teamSessionIds = (t: Team) => new Set([...t.bots.flatMap((x) => [x.id, x.sessionId, ...x.parts]), ...t.rooms.flatMap((r) => [r.id, ...r.parts])]);
export const questionOf = (t: Team, bot: Bot) => t.questions[bot.sessionId] ?? t.questions[bot.id];
export const viewOf = (t: Team, bot: Bot) => t.views[bot.sessionId] ?? t.views[bot.id];

// ---------------------------------------------------------------- transport

export type FeedEvent =
  | { type: 'hello'; revision: number; api?: number; boot?: string; seq?: number }
  | { type: 'revision'; revision: number }
  | { type: 'live' }
  | { type: 'message'; botId: string; sessionId: string; item: Item }
  | { type: 'stream'; botId: string; sessionId: string; attemptId: string; phase?: string; text?: string }
  | { type: 'notice'; notice: Notice }
  | { type: 'room'; roomId: string }
  | { type: 'lost'; error?: unknown };

export function parseFeed(event: string, data: unknown): FeedEvent | null {
  const d = o(data);
  switch (event) {
    case 'hello':
      return { type: 'hello', revision: n(d.revision) ?? 0, api: n(d.api), boot: s(d.boot), seq: n(d.seq) };
    case 'revision':
      return { type: 'revision', revision: n(d.revision) ?? 0 };
    case 'live':
      return { type: 'live' };
    case 'message':
      return { type: 'message', botId: s(d.botId) ?? '', sessionId: s(d.sessionId) ?? '', item: readItem(d.item) };
    case 'stream':
      return { type: 'stream', botId: s(d.botId) ?? '', sessionId: s(d.sessionId) ?? '', attemptId: s(d.attemptId) ?? '', phase: s(d.phase), text: s(d.text) };
    case 'notice':
      return { type: 'notice', notice: readNotice(d) };
    case 'room':
      return { type: 'room', roomId: s(d.roomId) ?? '' };
  }
  return null;
}

export interface Transport {
  call(endpoint: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** One feed connection: events until it drops. Returns a closer. */
  openFeed(onEvent: (event: string, data: unknown) => void, onEnd: (error?: unknown) => void): () => void;
}

export class HttpTransport implements Transport {
  constructor(private base = '') {}
  async call(endpoint: string, payload: Record<string, unknown>, timeoutMs = 20000): Promise<unknown> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await fetch(`${this.base}/api/bot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, payload }), signal: ctl.signal, credentials: 'same-origin' });
    } catch {
      throw new DsBotError('engine unreachable', 'transport', 0);
    } finally {
      clearTimeout(t);
    }
    if (r.status !== 200) throw new DsBotError(`HTTP ${r.status}`, r.status === 404 ? 'bot/missing' : 'http', r.status);
    const j = o(await r.json().catch(() => null));
    if (typeof j.ok !== 'boolean') throw new DsBotError('not a DS Bot answer', 'protocol');
    if (j.ok) return j.value;
    throw new DsBotError(s(o(j.error).message) ?? 'failed', s(o(j.error).code) ?? 'bot/error');
  }
  openFeed(onEvent: (event: string, data: unknown) => void, onEnd: (error?: unknown) => void) {
    const ctl = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctl.abort(), 50_000); // the host sends a keepalive every 20 s
    };
    void (async () => {
      try {
        const r = await fetch(`${this.base}/api/bot/feed`, { headers: { Accept: 'text/event-stream' }, signal: ctl.signal, credentials: 'same-origin' });
        if (r.status !== 200 || !r.body) throw new DsBotError(`HTTP ${r.status}`, 'http', r.status);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        let ev = 'message';
        let data: string[] = [];
        kick();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          kick();
          buf += value;
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (!line) {
              if (data.length) {
                let parsed: unknown = null;
                try {
                  parsed = JSON.parse(data.join('\n'));
                } catch {
                  /* not JSON */
                }
                onEvent(ev, parsed);
              }
              ev = 'message';
              data = [];
            } else if (!line.startsWith(':')) {
              const c = line.indexOf(':');
              const field = c < 0 ? line : line.slice(0, c);
              let val = c < 0 ? '' : line.slice(c + 1);
              if (val.startsWith(' ')) val = val.slice(1);
              if (field === 'event') ev = val;
              if (field === 'data') data.push(val);
            }
          }
        }
        clearTimeout(idle);
        onEnd();
      } catch (e) {
        clearTimeout(idle);
        onEnd(ctl.signal.aborted ? undefined : e);
      }
    })();
    return () => {
      clearTimeout(idle);
      ctl.abort();
    };
  }
}

// ---------------------------------------------------------------- calls

export class DsBotApi {
  constructor(public transport: Transport) {}
  call = (endpoint: string, payload: Record<string, unknown> = {}, timeoutMs?: number) => this.transport.call(endpoint, payload, timeoutMs);

  async hello(version: string): Promise<Hello> {
    const m = o(await this.call('hello', { client: { name: 'api-demo', version, platform: 'android' }, api: [1] }));
    return {
      api: n(m.api),
      pluginVersion: s(o(m.plugin).version) ?? '',
      capabilities: new Set(sl(m.capabilities)),
      boot: s(m.boot) ?? '',
      seq: n(m.seq) ?? 0,
      revision: n(m.revision) ?? 0,
      readOnly: s(m.readOnly),
      memory: b(m.memory) ?? true,
    };
  }
  async state(since?: number, modelsKey?: string) {
    return readState(await this.call('state', { ...(since != null ? { since } : {}), ...(modelsKey ? { models: modelsKey } : {}), locale: 'zh-CN', avatars: 'ref' }));
  }
  async avatar(botId: string): Promise<string | undefined> {
    return s(o(await this.call('avatar', { botId })).image);
  }
  async chat(botId: string, cursor?: unknown) {
    const m = o(await this.call('chat', { botId, ...(cursor != null ? { cursor } : {}) }));
    return { sessionId: s(m.sessionId) ?? '', items: (Array.isArray(m.items) ? m.items : []).map(readItem), cursor: m.cursor ?? null };
  }
  async roomChat(roomId: string, cursor?: unknown) {
    const m = o(await this.call('room-chat', { roomId, ...(cursor != null ? { cursor } : {}) }));
    return { items: (Array.isArray(m.items) ? m.items : []).map(readItem), cursor: m.cursor ?? null, running: b(m.running) ?? false, speaking: s(m.speaking) };
  }
  send = (conversationId: string, text: string) => this.call('send', { sessionId: conversationId, text }, 40000);
  async fileText(file: Record<string, unknown>) {
    const v = await this.call('file-text', { file });
    return typeof v === 'string' ? { text: v } : { text: s(o(v).text) ?? '', whole: b(o(v).whole) };
  }
  duplicateBot = async (id: string) => readBot(await this.call('duplicate-bot', { id }));
  createBot = async (p: { name: string; role?: string; instructions?: string; color?: string; model?: string; effort?: string }) => readBot(await this.call('create-bot', clean(p)));
  updateBot = (id: string, p: Partial<{ name: string; role: string; instructions: string; color: string; model: string; effort: string; workDir: string }>) => this.call('update-bot', { id, ...clean(p) });
  async folders() {
    const m = o(await this.call('folders'));
    return { team: s(m.team), folders: (Array.isArray(m.folders) ? m.folders : []).map((f) => ({ path: s(o(f).path) ?? '', title: s(o(f).title) ?? s(o(f).path) ?? '' })).filter((f) => f.path) };
  }
  deleteBot = (id: string) => this.call('delete-bot', { id });
  setMain = (id: string, main: boolean) => this.call('set-main', { id, main });
  createRoom = async (members: string[], name?: string) => readRoom(await this.call('create-room', clean({ members, name, greet: true })));
  updateRoom = (id: string, p: Partial<{ name: string; notice: string; mode: string; admin: string; add: string[]; remove: string[]; workDir: string }>) => this.call('update-room', { id, ...clean(p) });
  /** null restores the server default (sent explicitly). */
  setRelayLimit = (id: string, limit: number | null) => this.call('update-room', { id, relayLimit: limit });
  deleteRoom = (id: string) => this.call('delete-room', { id });
  continueRoom = (roomId: string) => this.call('room-continue', { roomId });
  stopMemberWork = async (roomId: string, botId: string) => (await this.call('stop-member-work', { roomId, botId })) === true;
  answerApproval = (id: string, allow: boolean) => this.call('approval-answer', { id, choice: allow ? 'allow' : 'reject' });
  answerQuestion = (bot: Bot, q: Question, selected: string[], custom?: string) => this.call('answer-question', { sessionId: bot.sessionId, questionId: q.id, answer: { selected, ...(custom ? { custom } : {}) } });
  dismissQuestion = (bot: Bot) => this.call('dismiss-question', { sessionId: bot.sessionId });
  answerView = (bot: Bot, v: ViewCard, action: string, values: Record<string, unknown>) => this.call('view-reply', { sessionId: bot.sessionId, viewId: v.id, action, values });
  dismissView = (bot: Bot) => this.call('dismiss-view', { sessionId: bot.sessionId });
  memory = async (t: { botId?: string; roomId?: string }) => readMemory(await this.call('memory-view', target(t)));
  forgetMemory = async (e: MemoryEntry, t: { botId?: string; roomId?: string }) => readMemory(await this.call('memory-forget', { ...target(t), scope: e.scope, topic: e.topic, text: e.text }));
  editMemory = async (e: MemoryEntry, next: string, t: { botId?: string; roomId?: string }) => readMemory(await this.call('memory-edit', { ...target(t), scope: e.scope, topic: e.topic, text: e.text, next }));
  addMemory = async (text: string, t: { botId?: string; roomId?: string }) => readMemory(await this.call('memory-add', { ...target(t), text }));
  async usage(botId: string): Promise<Usage> {
    const m = o(await this.call('usage-summary', { botId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    return {
      scanning: b(m.scanning) ?? false,
      day: readTotals(m.day),
      week: readTotals(m.week),
      month: readTotals(m.month),
      models: (Array.isArray(m.models) ? m.models : []).map((x) => ({ key: s(o(x).key) ?? '', name: s(o(x).name) ?? '', totals: readTotals(x) })),
    };
  }
  async notices(boot?: string, since?: number) {
    const m = o(await this.call('notices', clean({ boot, since })));
    return { boot: s(m.boot) ?? '', seq: n(m.seq) ?? 0, reset: b(m.reset) ?? false, notices: (Array.isArray(m.notices) ? m.notices : []).map(readNotice) };
  }
}

const target = (t: { botId?: string; roomId?: string }) => (t.roomId ? { roomId: t.roomId } : { botId: t.botId ?? '' });
function clean<T extends object>(p: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------- colours (DS Bot src/client/inks.js)

export const INKS: Record<string, [string, string]> = {
  deepseek: ['#4D6BFE', '#6A84FF'],
  charcoal: ['#141416', '#F1F2F4'],
  graphite: ['#2D2D2D', '#D6D6DA'],
  rose: ['#EC2F6B', '#FF5A7A'],
  sky: ['#0AA8D6', '#2EE6E0'],
  tangerine: ['#FF6900', '#FF8A2E'],
  cobalt: ['#082DFF', '#5C78FF'],
  black: ['#000000', '#FFFFFF'],
  brown: ['#A27952', '#855C36'],
  red: ['#FF3E51', '#E02135'],
  orange: ['#FF781C', '#FF6700'],
  yellow: ['#FFAF38', '#FF9800'],
  green: ['#00C972', '#009957'],
  cyan: ['#1CC3B0', '#00A592'],
  blue: ['#2A92FE', '#0E74E0'],
  violet: ['#A97EFE', '#804EE0'],
  magenta: ['#FF5EB1', '#E02A88'],
  gray: ['#959595', '#777777'],
  aurora: ['#00B8D4', '#2EE6E0'],
};
export const PICKER_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray', 'deepseek'];
const LEGACY: Record<string, string> = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' };
const DEFAULTS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const current = (c: string) => LEGACY[c] ?? c;
export const isColor = (c?: string) => !!c && (HEX.test(c) || current(c) in INKS);

function fnv1a(text: string) {
  let v = 2166136261;
  for (let i = 0; i < text.length; i++) v = Math.imul(v ^ text.charCodeAt(i), 16777619) >>> 0;
  return v >>> 0;
}
/** The colour a Bot without a picked one shows in: the same on every device (DS Bot `defaultColor`). */
export function defaultColor(id: string) {
  const t = (fnv1a(id) + 1831565813) >>> 0;
  let x = Math.imul(t ^ (t >>> 15), 1 | t) >>> 0;
  x = ((x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x) >>> 0;
  const unit = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return DEFAULTS[Math.floor(unit * DEFAULTS.length)];
}
export const inkOf = (bot: { id: string; color?: string }) => (isColor(bot.color) ? current(bot.color!) : defaultColor(bot.id));
export function inkHex(color: string, dark: boolean) {
  if (HEX.test(color)) return color;
  const ink = INKS[current(color)] ?? INKS.gray;
  return dark ? ink[1] : ink[0];
}
