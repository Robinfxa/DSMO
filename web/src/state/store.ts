// App state (Preact signals) and the actions the UI calls. Engine state lives
// in the engine; this mirrors it: the session list from `session/list` +
// `$events`, the open conversation from `session/follow`, approvals from
// `$events` waterfalls.

import type { JSX } from 'preact';
import { list, obj, str } from '../engine/json';
import { addVersion, bumpedForkTitle, familyMembers, hiddenVersions, setActiveVersion, versionsVersion } from './versions';
import { batch, computed, signal } from '@preact/signals';
import { DshClient, type ModelCatalog, type PromptContent } from '../engine/client';
import { DshRemoteError } from '../engine/errors';
import type { ApprovalRequest, QuestionRequest, SessionSummary } from '../engine/events';
import type { ConnState } from '../engine/mux';
import { browserSocketFactory } from '../engine/mux';
import { HttpRpc } from '../engine/rpc';
import { Transcript, forkPointBeforePrompt } from '../engine/transcript';
import { native, setBrowserLocal, setBrowserSkillSink, speak, type NativeInfo, type PickedFile } from '../bridge/native';

// ------------------------------------------------------------------ prefs

export interface Prefs {
  theme: 'light' | 'dark' | 'system';
  advanced: boolean;
  think: boolean;
  search: boolean;
  locationOn: boolean;
  province: string;
  city: string;
  collapsed: boolean;
  voice: string;
  lang: 'zh' | 'en';
  cotTranslate: boolean;
  /** Thinking starts expanded in replies (off: the 已思考 row only, tap to open). */
  thinkExpanded: boolean;
  voiceInput: boolean;
  notifyDone: boolean;
  /** 字体大小: chat text scale (1 = 标准). */
  fontScale: number;
  fontFollowSystem: boolean;
  /** Top-bar speaker: read finished replies aloud. */
  autoRead: boolean;
  nickname: string;
  /** 全部功能 › 边栏功能区: rows the person took out of the sidebar's 功能 (ui/siderFeats.ts). */
  siderHidden: string[];
}
const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  advanced: false,
  think: false,
  search: false,
  locationOn: true,
  province: '',
  city: '',
  collapsed: false,
  voice: 'stella',
  lang: 'zh',
  cotTranslate: false,
  thinkExpanded: false,
  voiceInput: true,
  notifyDone: true,
  fontScale: 1,
  fontFollowSystem: true,
  autoRead: false,
  nickname: '',
  siderHidden: [],
};
function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem('api-demo:prefs') || '{}');
    const out = { ...DEFAULT_PREFS };
    for (const k of Object.keys(out) as (keyof Prefs)[]) if (k in saved && typeof saved[k] === typeof out[k] && Array.isArray(saved[k]) === Array.isArray(out[k])) (out as any)[k] = saved[k];
    return out;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
export const prefs = signal<Prefs>(loadPrefs());
export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  prefs.value = { ...prefs.value, [k]: v };
  try {
    localStorage.setItem('api-demo:prefs', JSON.stringify(prefs.value));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ state

export type Overlay =
  | { kind: 'settings'; tab?: 'general' | 'data' }
  | { kind: 'model' }
  | { kind: 'chat' }
  | { kind: 'host' }
  | { kind: 'login' }
  | { kind: 'search' }
  | { kind: 'confirm'; title: string; body: string; ok: string; danger?: boolean; onOk: () => void; onCancel?: () => void; answered?: boolean }
  | { kind: 'input'; title: string; value: string; placeholder?: string; ok: string; allowEmpty?: boolean; onOk: (v: string) => void }
  | { kind: 'file'; path: string }
  | { kind: 'plugin'; id: string }
  | { kind: 'panel'; pluginId: string; panel: string }
  | { kind: 'dshgo'; pkg: string; id: string }
  | { kind: 'text'; title: string; body: string; mono?: boolean }
  | { kind: 'image'; src: string; alt: string }
  /** A small panel of choices: a bottom sheet on the phone, a dialog on the computer. */
  | { kind: 'sheet'; title: string; body: () => JSX.Element };

export interface Toast {
  id: number;
  text: string;
  action?: string;
  onAction?: () => void;
}

export interface Optimistic {
  requestId: string;
  sessionId: string;
  text: string;
  steer: boolean;
}

export const conn = signal<ConnState>('idle');
export const connError = signal<string | null>(null);
export const sessions = signal<SessionSummary[]>([]);
/** The engine has answered `session/list` since the page started; until then the list is the saved copy. */
export const sessionsLive = signal(false);
export const currentId = signal<string | null>(null);
export const txVersion = signal(0);
export const followState = signal<'opening' | 'live' | 'retrying'>('opening');
export const approvals = signal<ApprovalRequest[]>([]);
export const questions = signal<QuestionRequest[]>([]);
export const pages = signal<string[]>([]);
export const overlays = signal<Overlay[]>([]);
export const toast = signal<Toast | null>(null);
/** A newer page downloaded by the hot update (web_update.dart), not yet in use. */
export const webUpdateReady = signal<string | null>(null);
export const renaming = signal<string | null>(null);
export const drawerOpen = signal(false);
export const draft = signal('');
export const attachments = signal<PickedFile[]>([]);
export const optimistic = signal<Optimistic[]>([]);
export const catalog = signal<ModelCatalog | null>(null);
/** Selection for the next new conversation (advanced mode picker without an open conversation). */
export const nextSelection = signal<{ provider: string; model: string; effort: string } | null>(null);
export const credential = signal<{ configured: boolean; source?: string; writable: boolean } | null>(null);
export const nativeInfo = signal<NativeInfo | null>(null);
export const archivedUndo = signal<string | null>(null);
export const home = signal('');
/** Phone-sized screen: the app-style (DeepSeek mobile) layout. */
const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 767px)') : null;
export const isMobile = signal(!!mq?.matches);
mq?.addEventListener('change', (e) => (isMobile.value = e.matches));
export const pinned = signal<string[]>([]);
/**
 * Archived (deleted) conversations: `session/list` still returns them, so the list leaves these
 * out. From workspace/follow (baseline + `archived` frames) and each archive call's answer.
 */
export const archived = signal<Set<string>>(new Set());
/** messageId → feedback of the open conversation. */
export const feedback = signal<Record<string, { rating: 'positive' | 'negative'; version: string }>>({});
/** 修改输入: rewriting the prompt at [seq] of the open conversation. */
export const editing = signal<{ seq: number; original: string } | null>(null);

let client: DshClient;
let transcript: Transcript | null = null;
let watch: { stop(): void; refresh(): void } | null = null;
let engineForProto: { blip(): void } | null = null;

export const getClient = () => client;
export const getTranscript = () => transcript;
export const protoEngine = () => engineForProto;

export const current = computed(() => sessions.value.find((s) => s.sessionId === currentId.value) ?? null);
export const topSessions = computed(() => {
  const gone = archived.value;
  return sessions.value.filter((s) => !s.parentSessionId && s.origin !== 'subagent' && !gone.has(s.sessionId));
});
/** The sidebar list: other versions of an edited / regenerated conversation stay out (see versions.ts). */
/** Sessions another feature shows in its own place (DS Bot's team): kept out of the list. */
export const ownedElsewhere = signal<Set<string>>(new Set());
export const visibleSessions = computed(() => {
  versionsVersion.value;
  const owned = ownedElsewhere.value;
  const all = owned.size ? topSessions.value.filter((s) => !owned.has(s.sessionId)) : topSessions.value;
  const ids = new Set(all.map((s) => s.sessionId));
  const hidden = hiddenVersions((id) => ids.has(id));
  return hidden.size ? all.filter((s) => !hidden.has(s.sessionId)) : all;
});
export const running = computed(() => {
  txVersion.value;
  return !!transcript?.running;
});

// ------------------------------------------------------------------ boot

/** Re-reads the app's host list and capabilities (after hosts change). */
export async function refreshNativeInfo() {
  nativeInfo.value = await native.info();
  restoreSessionCache();
}

// ------------------------------------------------------------------ saved conversation list
// The phone's engine starts cold whenever Android has stopped the app (Samsung's power
// management does that minutes after it leaves the screen): about 15 s with an empty list.
// The last list this host gave is kept on the device and shown meanwhile.

const CACHE_MAX = 200;
const cacheKey = () => `api-demo:sessions:${nativeInfo.value?.hosts.find((h) => h.current)?.id ?? 'local'}`;

function restoreSessionCache() {
  if (sessionsLive.value || sessions.value.length) return;
  try {
    const saved = JSON.parse(localStorage.getItem(cacheKey()) || 'null') as { list?: SessionSummary[] } | null;
    if (Array.isArray(saved?.list)) sessions.value = saved.list.map((s) => ({ ...s, running: false, projections: s.projections ?? {} }));
  } catch {
    /* no storage, or an old shape: start empty */
  }
}

function saveSessionCache(list: SessionSummary[]) {
  try {
    const slim = list.slice(0, CACHE_MAX).map((s) => {
      const projections = JSON.stringify(s.projections ?? {}).length <= 2048 ? s.projections : {};
      return { sessionId: s.sessionId, updatedAt: s.updatedAt, running: false, blank: s.blank, agentAvailable: s.agentAvailable, cwd: s.cwd, parentSessionId: s.parentSessionId, origin: s.origin, title: s.title, projections };
    });
    localStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), list: slim }));
  } catch {
    /* private mode / full: the list just isn't kept */
  }
}

export async function boot() {
  if (__PROTOTYPE__) {
    const { MockEngine } = await import('../mock/engine');
    const engine = new MockEngine();
    engineForProto = engine;
    // e2e: the prototype's engine, for tests that mirror its workspaces into a stand-in host
    (window as { __mockEngine?: unknown }).__mockEngine = engine;
    setBrowserSkillSink((op, payload) => engine.skillFs(op, payload));
    (await import('../mock/dshgo')).setMockSessionImport((source, convs) => engine.importConversations(source, convs));
    setBrowserLocal((await import('../mock/local')).createMockLocal(engine.userSkills));
    (await import('../bots/store')).setBotTransport((await import('../mock/dsbot')).createMockDsBot());
    client = new DshClient(engine.rpc, engine.socketFactory);
  } else {
    client = new DshClient(new HttpRpc(''), browserSocketFactory());
  }
  void refreshNativeInfo();
  client.onConnState((s) => {
    conn.value = s;
    connError.value = s === 'retrying' ? client.mux.lastError?.message ?? null : null;
  });
  client.onHostEvent((e) => {
    switch (e.kind) {
      case 'ready':
        home.value = e.home;
        void import('../bots/store').then((m) => m.startDsBot());
        // Pending waterfalls are redelivered to every new connection.
        approvals.value = [];
        questions.value = [];
        transcript?.clearApprovals();
        void refreshSessions();
        break;
      case 'session-added':
        upsertSession(e.session);
        break;
      case 'session-removed':
        sessions.value = sessions.value.filter((s) => s.sessionId !== e.sessionId);
        break;
      case 'session-status': {
        const s = sessions.value.find((x) => x.sessionId === e.sessionId);
        if (s && s.running && !e.running && prefs.value.notifyDone && (document.visibilityState !== 'visible' || e.sessionId !== currentId.value))
          void native.notify('回复好了', s.title ?? '对话', s.sessionId);
        if (s) upsertSession({ ...s, running: e.running });
        if (e.sessionId === currentId.value && transcript) {
          const wasRunning = transcript.running;
          transcript.setRunning(e.running);
          bump();
          // Top-bar speaker on: read the finished reply aloud.
          if (wasRunning && !e.running && prefs.value.autoRead) {
            const t = transcript;
            setTimeout(() => {
              const last = [...t.items].reverse().find((i) => i.kind === 'assistant' && i.text.trim());
              if (last && last.kind === 'assistant') speak(last.text.replace(LOCATION_TAG, ''));
            }, 400);
          }
        }
        break;
      }
      case 'session-activity': {
        const s = sessions.value.find((x) => x.sessionId === e.sessionId);
        if (s) upsertSession({ ...s, updatedAt: e.at });
        break;
      }
      case 'approval':
        if (!approvals.value.some((a) => a.eventId === e.request.eventId)) approvals.value = [...approvals.value, e.request];
        if (e.request.sessionId === currentId.value) {
          transcript?.addApproval(e.request);
          bump();
          // Hard rule: nothing a plugin shows may sit over an approval card.
          if (overlays.value.some((o) => o.kind === 'panel' || o.kind === 'dshgo')) {
            overlays.value = overlays.value.filter((o) => o.kind !== 'panel' && o.kind !== 'dshgo');
            showToast('有操作需要你确认');
          }
        } else void native.notify('需要你确认', approvalTitle(e.request), e.request.sessionId);
        break;
      case 'question':
        questions.value = [...questions.value.filter((q) => q.eventId !== e.request.eventId), e.request];
        break;
      case 'cancel':
        dropRequest(e.eventId);
        break;
    }
  });
  try {
    await client.connect();
  } catch {
    /* state listener shows the error; the mux keeps retrying */
  }
  client.watchPins(
    (ids) => (pinned.value = ids),
    (ids) => (archived.value = new Set(ids)),
  );
  void loadAccount();
  void refreshCatalog();
}

/** Re-reads the model catalog (after a provider is added or removed). */
export const refreshCatalog = () =>
  getClient()
    .modelCatalog()
    .then((c) => (catalog.value = c))
    .catch(() => {});

function approvalTitle(r: ApprovalRequest) {
  return sessions.value.find((s) => s.sessionId === r.sessionId)?.title ?? r.toolName;
}

function dropRequest(eventId: string) {
  approvals.value = approvals.value.filter((a) => a.eventId !== eventId);
  questions.value = questions.value.filter((q) => q.eventId !== eventId);
  if (transcript) {
    transcript.removeRequest(eventId);
    bump();
  }
}

function upsertSession(s: SessionSummary) {
  const rest = sessions.value.filter((x) => x.sessionId !== s.sessionId);
  sessions.value = [s, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Re-reads the list. A just-started engine can answer with only the conversations it has
 * open (users saw one left, the rest back a while later), so an answer that leaves out
 * conversations we knew is not believed at once: those stay listed and the engine is asked
 * again a few times; only an answer still short after ~40 s drops them (and is saved).
 * Deleting goes through `archived`, so it never waits on this.
 */
const RELIST_MS = [3_000, 10_000, 30_000];
let listRound = 0;
export async function refreshSessions() {
  const round = ++listRound;
  const known = sessions.value;
  for (let i = 0; i <= RELIST_MS.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, RELIST_MS[i - 1]));
    if (round !== listRound) return;
    let list: SessionSummary[];
    try {
      list = await client.listSessions();
    } catch (e) {
      connError.value = (e as Error).message;
      continue;
    }
    if (round !== listRound) return;
    const ids = new Set(list.map((s) => s.sessionId));
    // Ones that came in since (session-added) are in `list` or still in sessions.value.
    const now = new Map(sessions.value.map((s) => [s.sessionId, s]));
    const missing = known.filter((s) => !ids.has(s.sessionId) && now.has(s.sessionId));
    const last = i === RELIST_MS.length;
    sessions.value = (last ? list : [...list, ...missing]).sort((a, b) => b.updatedAt - a.updatedAt);
    sessionsLive.value = true;
    if (!missing.length || last) {
      saveSessionCache(sessions.value);
      return;
    }
  }
}

export async function loadAccount() {
  try {
    const d = await client.describeCredentials(['DEEPSEEK_API_KEY']);
    credential.value = d.DEEPSEEK_API_KEY ?? { configured: false, writable: true };
  } catch {
    credential.value = null;
  }
}

const bump = () => (txVersion.value = txVersion.value + 1);

// ------------------------------------------------------------------ conversations

/**
 * Unsent text and files belong to the conversation they were typed in ('' = the
 * new-chat screen): switching parks them and brings back the other one's, so a
 * draft (or the old chat 「接着聊」 put in the box) is never sent somewhere else.
 * A half-done 修改 is dropped, not parked: it only makes sense on its own message.
 */
const parked = new Map<string, { text: string; files: PickedFile[] }>();
function swapDraft(from: string | null, to: string | null) {
  if (from === to) return;
  if (!editing.value && (draft.value || attachments.value.length)) parked.set(from ?? '', { text: draft.value, files: attachments.value });
  else parked.delete(from ?? '');
  const next = parked.get(to ?? '');
  parked.delete(to ?? '');
  draft.value = next?.text ?? '';
  attachments.value = next?.files ?? [];
}

export function openSession(id: string | null) {
  native.reportSession(id);
  watch?.stop();
  watch = null;
  transcript = null;
  batch(() => {
    swapDraft(currentId.value, id);
    currentId.value = id;
    renaming.value = null;
    pages.value = [];
    drawerOpen.value = false;
    bump();
  });
  editing.value = null;
  if (!id) return;
  feedback.value = {};
  client.listFeedback(id).then((f) => currentId.value === id && (feedback.value = f), () => {});
  const t = new Transcript();
  transcript = t;
  for (const a of approvals.value) if (a.sessionId === id) t.addApproval(a);
  followState.value = 'opening';
  watch = client.watchSession(
    id,
    (e) => {
      if (transcript !== t) return;
      t.apply(e);
      settleOptimistic(t);
      bump();
    },
    (s) => (followState.value = s),
  );
}

export const newChat = () => openSession(null);

function settleOptimistic(t: Transcript) {
  if (!optimistic.value.length) return;
  const seen = new Set<string>();
  for (const it of t.items) if (it.kind === 'user' && it.requestId) seen.add(it.requestId);
  const inbox = t.inbox.map((q) => q.text);
  const keep = optimistic.value.filter((o) => !seen.has(o.requestId) && !inbox.includes(o.text));
  if (keep.length !== optimistic.value.length) optimistic.value = keep;
}

/** The effort the basic-mode 深度思考 toggle maps to. */
const basicEffort = () => (prefs.value.think ? 'high' : 'off');

export async function send(textIn?: string) {
  const text = (textIn ?? draft.value).trim();
  const files = attachments.value;
  if (!text && !files.length) return;
  const adv = prefs.value.advanced;
  // Slash commands the engine executes itself (advanced mode).
  if (adv && /^\/(compact|clear|permission)\b/.test(text) && currentId.value) {
    draft.value = '';
    try {
      const r = await client.executeCommand(currentId.value, text);
      showToast(String((r as any).message ?? '已执行'));
    } catch (e) {
      showToast(errText(e));
    }
    return;
  }
  if (editing.value && currentId.value) {
    const e = editing.value;
    draft.value = '';
    editing.value = null;
    return resendFrom(e.seq, text, 'edit');
  }
  const isRunning = running.value;
  if (isRunning && !adv) return;
  draft.value = '';
  attachments.value = [];
  let sid = currentId.value;
  try {
    if (!sid) {
      const created = await client.createSession();
      sid = created.sessionId;
      const sel = nextSelection.value;
      if (adv && sel) await client.selectModel(sid, sel.provider, sel.model, sel.effort).catch(() => {});
      openSession(sid);
    }
    if (!adv) await applyBasicEffort(sid);
    const content: PromptContent[] = [];
    if (text) content.push({ type: 'text', text });
    const loc = text && !isRunning ? locationPart() : null;
    if (loc) content.push(loc);
    // Basic mode 智能搜索: a visible-to-model preference, stripped from the shown message.
    if (text && !adv && prefs.value.search) content.push({ type: 'text', text: '\n<search-preference>需要最新信息时，请先用联网搜索工具查证再回答。</search-preference>' });
    for (const f of files) content.push(f.kind === 'image' ? { type: 'image', mediaType: f.mimeType, data: f.data } : { type: 'file', receiptId: f.receiptId });
    const requestId = await client.prompt(sid, content, isRunning ? 'steer' : 'queue');
    optimistic.value = [...optimistic.value, { requestId, sessionId: sid, text, steer: isRunning }];
    if (transcript) settleOptimistic(transcript);
  } catch (e) {
    draft.value = text;
    showToast(errText(e));
  }
}

const appliedEffort = new Map<string, string>();
async function applyBasicEffort(sid: string) {
  const want = basicEffort();
  if (appliedEffort.get(sid) === want) return;
  const cat = catalog.value;
  const sel = currentSelection();
  const provider = sel?.provider ?? cat?.defaultSelection?.provider;
  const model = sel?.model ?? cat?.defaultSelection?.model;
  if (!provider || !model) return;
  try {
    await client.selectModel(sid, provider, model, want);
    appliedEffort.set(sid, want);
  } catch {
    /* the model may not support "off"; keep its default */
  }
}

/** Location travels as its own text part, only when the user turned it on
 * and picked a place; the UI strips it from the shown message. */
export const LOCATION_TAG = /\n?<(user-location|search-preference)>[^<]*<\/(user-location|search-preference)>/g;
function locationPart(): PromptContent | null {
  const p = prefs.value;
  if (!p.locationOn || !p.province) return null;
  return { type: 'text', text: `\n<user-location>用户所在地：${p.province}${p.city && p.city !== p.province ? ' ' + p.city : ''}</user-location>` };
}

/**
 * Edit-and-resend / regenerate: a new conversation forked just before the
 * prompt at [promptSeq], where [text] is sent again (the original stays as it was).
 */
/**
 * 修改 / 重新生成: DSH can only branch, so the new version is a fork before the
 * prompt with the prompt sent again; it stays the same conversation in the UI.
 */
export async function resendFrom(promptSeq: number, text: string, kind: 'edit' | 'regen' = 'regen') {
  const sid = currentId.value;
  const t = transcript;
  if (!sid || !t) return;
  const cut = forkPointBeforePrompt(t.events, promptSeq);
  try {
    let target: string;
    if (cut === null) {
      // Nothing usable before the prompt (or a gap in the loaded window): start fresh.
      target = (await client.createSession()).sessionId;
    } else target = await client.forkAt(sid, cut);
    const wasPinned = pinned.value.includes(sid);
    addVersion(target, sid, cut ?? -1, kind);
    if (wasPinned) void movePin(sid, target);
    openSession(target);
    if (!prefs.value.advanced) await applyBasicEffort(target);
    const requestId = await client.prompt(target, [{ type: 'text', text }]);
    optimistic.value = [...optimistic.value, { requestId, sessionId: target, text, steer: false }];
  } catch (e) {
    showToast(errText(e));
  }
}

async function movePin(from: string, to: string) {
  try {
    await client.unpinSession(from);
    pinned.value = await client.pinSession(to);
  } catch {
    /* the pin stays where it was */
  }
}

/** Shows another version of the conversation on screen (and in the sidebar). */
export function switchVersion(id: string) {
  const cur = currentId.value;
  if (!cur || cur === id) return;
  if (pinned.value.includes(cur) && !pinned.value.includes(id)) void movePin(cur, id);
  setActiveVersion(id);
  openSession(id);
}

/** 分叉: everything up to [atSeq] (or the latest finished turn) into a new, separate conversation. */
export async function forkConversation(sessionId: string, atSeq?: number) {
  const src = sessions.value.find((x) => x.sessionId === sessionId);
  try {
    const child = await client.forkAt(sessionId, atSeq);
    // Prompts still queued in the source belong after the cut, not in the fork.
    try {
      const inbox = obj((await client.projections(child)).inbox);
      for (const q of [...list(inbox['next-step']), ...list(inbox['next-turn'])]) {
        const id = str(obj(q).id);
        if (id) await client.removeQueued(child, id).catch(() => {});
      }
    } catch {
      /* best effort */
    }
    const title = src?.title?.trim();
    if (title) {
      const t = bumpedForkTitle(title);
      await client.renameSession(child, t).catch(() => {});
      const s = sessions.value.find((x) => x.sessionId === child);
      if (s) upsertSession({ ...s, title: t });
    }
    openSession(child);
    showToast('已分叉到新对话');
  } catch (e) {
    showToast(errText(e));
  }
}

export async function togglePin(id: string) {
  try {
    pinned.value = pinned.value.includes(id) ? await client.unpinSession(id) : await client.pinSession(id);
  } catch (e) {
    showToast(errText(e));
  }
}

export async function rate(messageId: string, rating: 'positive' | 'negative') {
  const sid = currentId.value;
  if (!sid) return;
  const cur = feedback.value[messageId];
  try {
    if (cur?.rating === rating) {
      await client.deleteFeedback(sid, messageId, cur.version);
      const { [messageId]: _, ...rest } = feedback.value;
      feedback.value = rest;
    } else {
      const f = await client.putFeedback(sid, messageId, rating, cur?.version ?? null);
      feedback.value = { ...feedback.value, [messageId]: f };
      showToast(rating === 'positive' ? '感谢你的反馈' : '已记录，我们会改进');
    }
  } catch (e) {
    showToast(errText(e));
  }
}

export async function stop() {
  const sid = currentId.value;
  if (!sid) return;
  try {
    await client.cancel(sid);
  } catch (e) {
    showToast(errText(e));
  }
}

export async function answerApproval(r: ApprovalRequest, decision: 'allowed-once' | 'rejected') {
  try {
    await client.respondApproval(r.eventId, decision);
    dropRequest(r.eventId); // the Host only sends cancel to the other clients
  } catch (e) {
    if (e instanceof DshRemoteError && /unknown|no pending/.test(e.message)) dropRequest(r.eventId);
    showToast(errText(e));
  }
}

export async function answerQuestion(q: QuestionRequest, answers: { id: string; selected: string[]; custom?: string }[] | null) {
  try {
    if (answers) await client.answerQuestion(q.eventId, answers);
    else await client.rejectQuestion(q.eventId);
    dropRequest(q.eventId);
  } catch (e) {
    showToast(errText(e));
  }
}

export async function renameSession(id: string, title: string) {
  renaming.value = null;
  const t = title.trim();
  if (!t) return;
  const s = sessions.value.find((x) => x.sessionId === id);
  if (s) upsertSession({ ...s, title: t });
  try {
    await client.renameSession(id, t);
  } catch (e) {
    showToast(errText(e));
  }
}

/** Deletes the conversation with all its versions (edits and regenerations). */
export async function deleteSession(id: string) {
  const ids = new Set(familyMembers(id).filter((x) => sessions.value.some((s) => s.sessionId === x)));
  ids.add(id);
  const gone = sessions.value.filter((x) => ids.has(x.sessionId));
  sessions.value = sessions.value.filter((x) => !ids.has(x.sessionId));
  if (currentId.value && ids.has(currentId.value)) openSession(null);
  // out of the list at once; the engine's answers (the whole archived set) confirm it
  const pending = new Set(ids);
  archived.value = new Set([...archived.value, ...ids]);
  try {
    for (const x of ids) {
      const set = await client.archiveSession(x);
      pending.delete(x);
      archived.value = new Set([...set, ...pending]);
    }
    showToast('已删除对话', '撤销', async () => {
      for (const x of ids) await client.unarchiveSession(x).then((left) => (archived.value = new Set(left)), () => {});
      for (const g of gone) upsertSession(g);
    });
  } catch (e) {
    archived.value = new Set([...archived.value].filter((x) => !ids.has(x)));
    for (const g of gone) upsertSession(g);
    showToast(errText(e));
  }
}

export async function deleteAll() {
  const ids = topSessions.value.map((s) => s.sessionId);
  openSession(null);
  const pending = new Set(ids);
  archived.value = new Set([...archived.value, ...ids]);
  let failed = 0;
  let engine: string[] = [...archived.value];
  for (const id of ids) {
    try {
      engine = await client.archiveSession(id);
    } catch {
      failed++;
      engine = engine.filter((x) => x !== id);
    }
    pending.delete(id);
    archived.value = new Set([...engine, ...pending]);
  }
  await refreshSessions();
  showToast(failed ? `有 ${failed} 个对话没删掉，再试一次` : '已删除全部对话');
}

// ------------------------------------------------------------------ model / permission

export function currentSelection(): { provider: string; model: string; effort?: string } | null {
  txVersion.value;
  // The latest model/selection in the log first: the projections come with the
  // snapshot and go stale after a switch (dsh-Go's chat_state._trackModel, same order).
  for (const e of [...(transcript?.events ?? [])].reverse()) if (e.kind === 'model' && e.provider) return { provider: e.provider, model: e.model ?? '', effort: e.effort };
  const p = transcript?.projections as any;
  const sel = p?.modelSelection?.next ?? p?.modelSelection?.lastUsed;
  if (sel?.provider) return { provider: sel.provider, model: sel.model, effort: sel.reasoningEffort };
  const n = nextSelection.value;
  if (n) return n;
  const d = catalog.value?.defaultSelection;
  return d ? { provider: d.provider, model: d.model, effort: d.reasoningEffort } : null;
}

export async function pickModel(provider: string, model: string, effort?: string) {
  const sid = currentId.value;
  if (!sid) {
    nextSelection.value = { provider, model, effort: effort ?? 'high' };
    return;
  }
  try {
    await client.selectModel(sid, provider, model, effort);
  } catch (e) {
    showToast(errText(e));
  }
}

export async function setPermission(preset: string) {
  const sid = currentId.value;
  if (!sid) return showToast('先打开一个对话');
  try {
    await client.setPermissionPreset(sid, preset);
  } catch (e) {
    showToast(errText(e));
  }
}

// ------------------------------------------------------------------ account (hard-rule zone)

export async function saveApiKey(key: string) {
  await client.setProviderKey(key);
  await loadAccount();
}
export async function clearApiKey() {
  await client.clearProviderKey();
  await loadAccount();
}

// ------------------------------------------------------------------ UI helpers

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(text: string, action?: string, onAction?: () => void) {
  if (toastTimer) clearTimeout(toastTimer);
  const t = { id: ++toastSeq, text, action, onAction };
  toast.value = t;
  toastTimer = setTimeout(() => {
    if (toast.value?.id === t.id) toast.value = null;
  }, action ? 8000 : 1800); // time to read it and reach the button
}

/** Phone layout: full-screen pages (设置 and its sub-pages, 搜索, 账号). */
export const screens = signal<string[]>([]);
export function pushScreen(id: string) {
  drawerOpen.value = false;
  if (screens.value[screens.value.length - 1] !== id) screens.value = [...screens.value, id];
}
export function popScreen() {
  screens.value = screens.value.slice(0, -1);
}

export interface PopoverItem {
  icon: string;
  label: string;
  danger?: boolean;
  run: () => void;
}
/** Phone layout: a long-press / ··· menu anchored at a point. */
export const popover = signal<{ x: number; y: number; items: PopoverItem[] } | null>(null);
export function openPopover(anchor: Element | { x: number; y: number }, items: PopoverItem[]) {
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, bottom: anchor.y, top: anchor.y };
  popover.value = { x: r.right, y: r.bottom, items };
}

export function openOverlay(o: Overlay) {
  // On a phone, settings / login / search are full pages, like a native app.
  if (isMobile.value) {
    if (o.kind === 'settings') return pushScreen(o.tab === 'data' ? 'data' : 'settings');
    if (o.kind === 'login') return pushScreen('account');
    if (o.kind === 'search') return pushScreen('search');
  }
  overlays.value = [...overlays.value, o];
}
export function closeOverlay() {
  const top = overlays.value[overlays.value.length - 1];
  overlays.value = overlays.value.slice(0, -1);
  // A confirm closed any way but its OK button (cancel, back, backdrop) is a no.
  if (top?.kind === 'confirm' && !top.answered) top.onCancel?.();
}
export function closeAllOverlays() {
  overlays.value = [];
}
/** A one-line text prompt in the app's own dialog (WebView has no window.prompt). */
export function askText(title: string, value: string, onOk: (v: string) => void, opts: { placeholder?: string; ok?: string; allowEmpty?: boolean } = {}) {
  openOverlay({ kind: 'input', title, value, placeholder: opts.placeholder, ok: opts.ok ?? '确定', allowEmpty: opts.allowEmpty, onOk });
}

export function confirm(title: string, body: string, ok: string, onOk: () => void, danger = true, onCancel?: () => void) {
  const o: Extract<Overlay, { kind: 'confirm' }> = { kind: 'confirm', title, body, ok, danger, onCancel, onOk: () => ((o.answered = true), onOk()) };
  openOverlay(o);
}

export function openPage(id: string, root = false) {
  drawerOpen.value = false;
  if (root || !pages.value.length) pages.value = [id];
  else if (pages.value[pages.value.length - 1] !== id) pages.value = [...pages.value, id];
}
export function backPage() {
  pages.value = pages.value.slice(0, -1);
}

/** Android back: closes the top layer; false when there is nothing to close. */
export function handleBack(): boolean {
  if (popover.value) return (popover.value = null), true;
  if (overlays.value.length) return closeOverlay(), true;
  if (screens.value.length) return popScreen(), true;
  if (editing.value) return (editing.value = null), (draft.value = ''), true;
  if (drawerOpen.value) return (drawerOpen.value = false), true;
  if (pages.value.length) return backPage(), true;
  return false;
}

export function errText(e: unknown): string {
  if (e instanceof DshRemoteError) {
    if (e.code === 'credential/rejected') return 'API Key 由启动环境提供，这里改不了';
    if (e.code.startsWith('llm/') || /api key|unauthorized/i.test(e.message)) return '模型请求失败：请检查 API Key';
    return e.message;
  }
  return (e as Error)?.message || '出错了';
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制');
  } catch {
    showToast('复制失败，请手动选择文字复制');
  }
}

export function refreshFollow() {
  watch?.refresh();
}
