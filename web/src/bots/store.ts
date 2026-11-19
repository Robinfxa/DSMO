// The DS Bot team of the active host (dsh-Go state/bots_state.dart): hello,
// the team (`state`, re-read on `revision` / `live`), the live feed with
// reconnects, an inbox of notices (latest line and unread count per Bot or
// group), and the team's Sessions, which the conversation list leaves out.

import { computed, signal } from '@preact/signals';
import { getClient, nativeInfo, ownedElsewhere } from '../state/store';
import { DsBotApi, DsBotError, HttpTransport, parseFeed, describeError, teamSessionIds, type FeedEvent, type Hello, type Live, type Notice, type Team, type Transport } from './api';

export type Availability = 'connecting' | 'missing' | 'outdated' | 'ready' | 'failed';
export interface BotStatus {
  availability: Availability;
  hello?: Hello;
  team?: Team;
  live: Live;
  error?: string;
  feed: boolean;
}

const EMPTY_LIVE: Live = { activity: {}, bots: {}, rooms: {}, approvals: [] };
export const dsBot = signal<BotStatus>({ availability: 'connecting', live: EMPTY_LIVE, feed: false });
export const inbox = signal<{ latest: Record<string, Notice>; read: Record<string, number> }>({ latest: {}, read: {} });
/** The Bot or group on screen (its notices count as read). */
export const viewing = signal<string | null>(null);

const ATTENTION = new Set(['message', 'group', 'done', 'question', 'view', 'approval']);
export const unreadOf = (id: string) => {
  const n = inbox.value.latest[id];
  const read = inbox.value.read[id] ?? 0;
  return n && n.seq > read && viewing.value !== id ? countSince(id, read) : 0;
};
export const totalUnread = computed(() => Object.keys(inbox.value.latest).reduce((t, id) => t + unreadOf(id), 0));
export const anyWorking = computed(() => Object.keys(dsBot.value.live.bots).length > 0);

let api: DsBotApi | null = null;
export const botApi = () => api;
let generation = 0;
let closeFeed: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let stateTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let boot: string | undefined;
const listeners = new Set<(e: FeedEvent) => void>();
const noticeLog = new Map<string, Notice[]>();

export const onBotFeed = (fn: (e: FeedEvent) => void) => (listeners.add(fn), () => void listeners.delete(fn));
const emit = (e: FeedEvent) => listeners.forEach((fn) => fn(e));

let transportFactory: () => Transport = () => new HttpTransport();
export const setBotTransport = (f: () => Transport) => (transportFactory = f);

const hostKey = () => nativeInfo.value?.hosts.find((h) => h.current)?.id ?? 'local';
const readKey = () => `api-demo:dsbot-read:${hostKey()}`;
function loadRead(b: string): Record<string, number> {
  try {
    const j = JSON.parse(localStorage.getItem(readKey()) ?? 'null');
    return j && j.boot === b ? j.seqs : {};
  } catch {
    return {};
  }
}
function saveRead() {
  try {
    localStorage.setItem(readKey(), JSON.stringify({ boot, seqs: inbox.value.read }));
  } catch {
    /* private mode */
  }
}
function countSince(id: string, read: number) {
  return (noticeLog.get(id) ?? []).filter((n) => n.seq > read && (n.kind === 'message' || n.kind === 'group')).length || 1;
}

export function markRead(id: string) {
  const n = inbox.value.latest[id];
  if (!n || (inbox.value.read[id] ?? 0) >= n.seq) return;
  inbox.value = { ...inbox.value, read: { ...inbox.value.read, [id]: n.seq } };
  saveRead();
}

function acceptNotice(n: Notice) {
  if (!ATTENTION.has(n.kind) || n.seq <= 0) return;
  const id = n.roomId ?? n.botId;
  const log = noticeLog.get(id) ?? [];
  if (log.some((x) => x.seq === n.seq)) return;
  log.push(n);
  noticeLog.set(id, log.slice(-50));
  const prev = inbox.value.latest[id];
  const latest = !prev || n.seq > prev.seq ? { ...inbox.value.latest, [id]: n } : inbox.value.latest;
  const read = viewing.value === id ? { ...inbox.value.read, [id]: Math.max(n.seq, inbox.value.read[id] ?? 0) } : inbox.value.read;
  inbox.value = { latest, read };
  if (viewing.value === id) saveRead();
}

const current = (g: number) => g === generation;
const set = (p: Partial<BotStatus>) => (dsBot.value = { ...dsBot.value, ...p });

/** (Re)connects to the active host's DS Bot. Called when the engine connection is ready. */
export async function startDsBot() {
  const g = ++generation;
  closeFeed?.();
  closeFeed = null;
  clearTimeout(retryTimer);
  api = new DsBotApi(transportFactory());
  set({ availability: 'connecting', error: undefined });
  let hello: Hello;
  try {
    hello = await api.hello(nativeInfo.value?.appVersion ?? 'web');
  } catch (e) {
    if (!current(g)) return;
    const availability: Availability =
      e instanceof DsBotError && e.status === 404 ? 'missing' : e instanceof DsBotError && (e.code === 'bot/not-found' || e.code === 'bot/read-only') ? 'outdated' : 'failed';
    set({ availability, error: describeError(e), team: undefined });
    ownedElsewhere.value = new Set();
    return;
  }
  if (!current(g)) return;
  if (hello.api == null) return set({ availability: 'outdated', hello });
  set({ hello });
  if (boot !== hello.boot) {
    boot = hello.boot;
    noticeLog.clear();
    inbox.value = { latest: {}, read: loadRead(hello.boot) };
  }
  await loadState(g, true);
  if (!current(g)) return;
  void api.notices(hello.boot).then(
    (r) => current(g) && r.boot === boot && r.notices.forEach(acceptNotice),
    () => {},
  );
  connect(g);
}

let stateBusy = false;
let stateAgain = false;
async function loadState(g: number, full = false) {
  if (!api) return;
  if (stateBusy) {
    stateAgain = true;
    return;
  }
  stateBusy = true;
  try {
    const team = dsBot.value.team;
    const r = await api.state(full ? undefined : team?.revision, full ? undefined : team?.modelsKey);
    if (!current(g)) return;
    const next = r.team ?? team;
    set({ availability: 'ready', team: next, live: r.live, error: undefined });
    if (next) ownedElsewhere.value = teamSessionIds(next);
  } catch (e) {
    if (current(g) && !dsBot.value.team) set({ availability: 'failed', error: describeError(e) });
  } finally {
    stateBusy = false;
    if (stateAgain && current(g)) {
      stateAgain = false;
      void loadState(g);
    }
  }
}
const scheduleState = (g: number, delay = 150) => {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    if (current(g)) void loadState(g);
  }, delay);
};
/** Reads the team again now (after a change made here). */
export const refreshTeam = () => loadState(generation);

function connect(g: number) {
  if (!api || !current(g)) return;
  let said = false;
  closeFeed = api.transport.openFeed(
    (event, data) => {
      if (!current(g)) return;
      const e = parseFeed(event, data);
      if (!e) return;
      if (e.type === 'hello') {
        if (e.boot && boot && e.boot !== boot) return void startDsBot();
        said = true;
        failures = 0;
        set({ feed: true });
        scheduleState(g, 0);
      } else if (e.type === 'revision' || e.type === 'live') scheduleState(g);
      else if (e.type === 'notice') acceptNotice(e.notice);
      emit(e);
    },
    (error) => {
      if (!current(g)) return;
      closeFeed = null;
      set({ feed: false });
      if (said || error) emit({ type: 'lost', error });
      if (error instanceof DsBotError && error.status === 404) return set({ availability: 'outdated' });
      const delay = [500, 1000, 2000, 5000, 10000][Math.min(failures++, 4)];
      retryTimer = setTimeout(() => connect(g), delay);
    },
  );
}

/** Connect again now (the app came back), unless a feed is open. */
export function kickDsBot() {
  if (closeFeed || !api) return;
  clearTimeout(retryTimer);
  failures = 0;
  connect(generation);
}

/** Installs (or updates) the `ds-bot` engine plugin, then asks again. */
export async function installDsBot() {
  if (dsBot.value.availability === 'outdated') await getClient().removeBundle('ds-bot').catch(() => {});
  await getClient().installBundle('ds-bot', { enabled: true });
  await startDsBot();
}
