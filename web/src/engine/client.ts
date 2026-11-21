// The engine client the UI talks to: unary RPC + the mux, and typed wrappers
// for the endpoints v1 uses. Endpoint names and argument shapes follow
// dsh-Go's packages/dsh_client (captured against dsh web 0.2.x).

import { DshClosedError, DshRemoteError } from './errors';
import {
  type FollowEvent,
  type HostEvent,
  type LogEvent,
  type SessionSummary,
  type TodoItem,
  parseFollowFrame,
  parseHostEvent,
  parseLogEvent,
  parseSessionSummary,
} from './events';
import { bool, int, list, obj, str, strList, uuid } from './json';
import { type ConnState, Mux, type MuxStream, RETRY_CAPS_S, type SocketFactory } from './mux';
import { type RpcTransport } from './rpc';

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
  efforts: { id: string; name: string; description?: string }[];
  defaultEffort?: string;
}
export interface ModelCatalog {
  defaultSelection?: { provider: string; model: string; reasoningEffort?: string };
  groups: { id: string; name: string; models: ModelInfo[] }[];
}
export interface SkillInfo {
  name: string;
  description: string;
  source?: string;
  /** Its SKILL.md on the host, when the engine says. */
  path?: string;
}
export interface JobInfo {
  jobId: string;
  command: string;
  status: string;
  startedAt?: number;
  exitCode?: number;
  detail?: string;
}
export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}
export interface GoalView {
  objective: string;
  status: string;
  rounds?: number;
  maxRounds?: number;
}

export type PromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'file'; receiptId: string };

export interface WatchHandle {
  stop(): void;
  /** Reopens the follow now (e.g. after the app was backgrounded). */
  refresh(): void;
}

export interface WorkspaceInfo {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
}

export class DshClient {
  readonly mux: Mux;
  private hostListeners = new Set<(e: HostEvent) => void>();

  constructor(
    readonly rpc: RpcTransport,
    socketFactory: SocketFactory,
  ) {
    this.mux = new Mux(socketFactory);
    this.mux.onHostEvent((item) => {
      const e = parseHostEvent(item);
      for (const fn of [...this.hostListeners]) fn(e);
    });
  }

  connect() {
    return this.mux.ready();
  }
  close() {
    this.mux.close();
  }
  onHostEvent(fn: (e: HostEvent) => void) {
    this.hostListeners.add(fn);
    return () => this.hostListeners.delete(fn);
  }
  onConnState(fn: (s: ConnState) => void) {
    return this.mux.onState(fn);
  }

  call(endpoint: string, args: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.rpc.call(endpoint, args, { timeoutMs });
  }

  // ---------- sessions ----------

  async listSessions(): Promise<SessionSummary[]> {
    const v = obj(await this.call('session/list', { _request: {} }));
    return list(v.items).map(parseSessionSummary);
  }
  async createSession(opts: { cwd?: string; workspaceId?: string; agentPreset?: string } = {}) {
    const v = obj(await this.call('session/create', { request: clean(opts) }));
    return { sessionId: str(v.sessionId) ?? '', agentPreset: str(v.agentPreset) };
  }
  async renameSession(sessionId: string, title: string) {
    const v = obj(await this.call('session/rename', { request: { sessionId, title } }));
    return str(v.title) ?? title;
  }
  async archiveSession(sessionId: string, stopActivity = true) {
    const v = obj(await this.call('workspace/archiveSession', { request: { sessionId, stopActivity } }));
    return strList(v.archivedSessionIds);
  }
  async unarchiveSession(sessionId: string) {
    const v = obj(await this.call('workspace/unarchiveSession', { request: { sessionId } }));
    return strList(v.archivedSessionIds);
  }
  async forkSession(sessionId: string, atSeq?: number) {
    const v = obj(await this.call('session/fork', { request: clean({ sessionId, atSeq }) }));
    return str(v.sessionId) ?? '';
  }
  async searchSessions(query: string) {
    const v = obj(await this.call('session/search', { request: { query } }));
    return { items: list(v.items).map((i) => ({ sessionId: str(obj(i).sessionId) ?? '', snippet: str(obj(i).snippet) ?? '' })), hasMore: v.hasMore === true };
  }
  /** Returns the requestId; the user/message echoes it as source.rpcId. */
  async prompt(sessionId: string, content: PromptContent[], mode: 'queue' | 'steer' = 'queue') {
    const requestId = `req-${uuid()}`;
    let tz: string | undefined;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      /* optional */
    }
    await this.call('session/prompt', { request: clean({ requestId, sessionId, mode, content, clientTimeZone: tz }) });
    return requestId;
  }
  cancel(sessionId: string) {
    return this.call('session/cancel', { request: { sessionId } });
  }
  async history(sessionId: string, throughSeq: number, beforeSeq?: number, maxMessages = 40) {
    const v = obj(
      await this.call('session/page', {
        request: clean({ address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages }),
      }),
    );
    return { events: list(v.records).map((r) => parseLogEvent(obj(r).event)), hasMore: v.hasMore === true };
  }

  /**
   * Follows one session. The first item of every open is a snapshot; later
   * opens (after a dropped connection) are resyncs merged by seq. Reopens
   * with the Mux's backoff until stopped.
   */
  watchSession(sessionId: string, onEvent: (e: FollowEvent) => void, onState?: (s: 'opening' | 'live' | 'retrying', err?: Error) => void): WatchHandle {
    let stopped = false;
    let stream: MuxStream | null = null;
    let lastSeq = -1;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (stopped || this.mux.state === 'closed') return;
      onState?.('opening');
      let opened = false;
      stream = this.mux.open(
        'session/follow',
        { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 60 } },
        {
          onItem: (item) => {
            if (stopped) return;
            const e = parseFollowFrame(item, !opened && lastSeq >= 0);
            if (!opened) {
              if (e.kind !== 'snapshot') return retry(new Error('follow opened without snapshot'));
              opened = true;
              attempt = 0;
              onState?.('live');
            }
            if (e.kind === 'snapshot') lastSeq = Math.max(lastSeq, e.cursor);
            if (e.kind === 'log') lastSeq = Math.max(lastSeq, e.event.seq);
            onEvent(e);
          },
          onEnd: () => retry(),
          onError: (err) => retry(err),
        },
      );
    };
    const retry = (err?: Error) => {
      if (stopped || err instanceof DshClosedError) return;
      stream?.cancel();
      stream = null;
      onState?.('retrying', err);
      if (err instanceof DshRemoteError && /not-found|unknown-session/.test(err.code)) return;
      const cap = RETRY_CAPS_S[Math.min(attempt++, RETRY_CAPS_S.length - 1)];
      timer = setTimeout(open, cap * 1000 * (0.5 + Math.random() * 0.5));
    };
    open();
    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        stream?.cancel();
      },
      refresh: () => {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        stream?.cancel();
        open();
      },
    };
  }

  // ---------- pins (workspace registry) ----------

  /**
   * `workspace/follow`: calls [onPinned] with the full pin set (most recent first) and
   * [onArchived] with the full archived set on every change. `session/list` includes archived
   * sessions; this set is how a client leaves them out (dsh-Go's sessions_state does the same).
   */
  watchPins(onPinned: (ids: string[]) => void, onArchived?: (ids: string[]) => void): () => void {
    let stopped = false;
    let stream: MuxStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (stopped || this.mux.state === 'closed') return;
      stream = this.mux.open('workspace/follow', {}, {
        onItem: (item) => {
          const m = obj(item);
          if (m.type === 'baseline') {
            onPinned(strList(obj(m.value).pinnedSessionIds));
            onArchived?.(strList(obj(m.value).archivedSessionIds));
          } else if (m.type === 'pinned') onPinned(strList(m.pinnedSessionIds));
          else if (m.type === 'archived') onArchived?.(strList(m.archivedSessionIds));
        },
        onEnd: () => retry(),
        onError: (e) => (e instanceof DshClosedError ? undefined : retry()),
      });
    };
    const retry = () => {
      if (stopped) return;
      timer = setTimeout(open, 2000);
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.cancel();
    };
  }
  async pinSession(sessionId: string) {
    return strList(obj(await this.call('workspace/pinSession', { request: { sessionId } })).pinnedSessionIds);
  }
  async unpinSession(sessionId: string) {
    return strList(obj(await this.call('workspace/unpinSession', { request: { sessionId } })).pinnedSessionIds);
  }

  // ---------- reply feedback ----------

  async listFeedback(sessionId: string): Promise<Record<string, { rating: 'positive' | 'negative'; version: string }>> {
    const v = obj(unwrapFeedback(await this.call('messageFeedback/list', { request: { sessionId } })));
    const out: Record<string, { rating: 'positive' | 'negative'; version: string }> = {};
    for (const it of list(v.items).map(obj)) {
      const id = str(it.messageId);
      const r = str(it.rating);
      if (id && (r === 'positive' || r === 'negative')) out[id] = { rating: r, version: str(it.version) ?? '' };
    }
    return out;
  }
  async putFeedback(sessionId: string, messageId: string, rating: 'positive' | 'negative', ifVersion: string | null) {
    const it = obj(unwrapFeedback(await this.call('messageFeedback/put', { request: { sessionId, messageId, rating, ifVersion } })));
    return { rating, version: str(it.version) ?? '' };
  }
  async deleteFeedback(sessionId: string, messageId: string, ifVersion: string) {
    unwrapFeedback(await this.call('messageFeedback/delete', { request: { sessionId, messageId, ifVersion } }));
  }

  /** A new conversation with everything through [atSeq] (edit-and-resend, regenerate). */
  // ---------- workspaces ----------

  /** `workspace/follow`: baseline then upserts / removals / order; the callback gets the whole list each time. */
  watchWorkspaces(onChange: (items: WorkspaceInfo[]) => void): () => void {
    let items: WorkspaceInfo[] = [];
    let stopped = false;
    let stream: MuxStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const parse = (v: unknown): WorkspaceInfo => {
      const m = obj(v);
      return { workspaceId: str(m.workspaceId) ?? '', path: str(m.path) ?? '', title: str(m.title) ?? '', sessionIds: strList(m.sessionIds) };
    };
    const open = () => {
      if (stopped || this.mux.state === 'closed') return;
      stream = this.mux.open('workspace/follow', {}, {
        onItem: (item) => {
          const m = obj(item);
          if (m.type === 'baseline') items = list(obj(m.value).items).map(parse);
          else if (m.type === 'upsert') {
            const w = parse(m.workspace);
            const i = items.findIndex((x) => x.workspaceId === w.workspaceId);
            items = i < 0 ? [...items, w] : items.map((x, j) => (j === i ? w : x));
          } else if (m.type === 'remove') items = items.filter((x) => x.workspaceId !== str(m.workspaceId));
          else if (m.type === 'order') {
            const order = strList(m.workspaceIds);
            items = [...items].sort((a, b) => order.indexOf(a.workspaceId) - order.indexOf(b.workspaceId));
          } else return;
          onChange(items);
        },
        onEnd: () => retry(),
        onError: (e) => (e instanceof DshClosedError ? undefined : retry()),
      });
    };
    const retry = () => {
      if (!stopped) timer = setTimeout(open, 2000);
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.cancel();
    };
  }
  // ---------- DeepSeek account (account/*, the on-device engine only) ----------
  watchAccount(onView: (view: Record<string, unknown>) => void): () => void {
    let stopped = false;
    let stream: MuxStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (stopped || this.mux.state === 'closed') return;
      stream = this.mux.open('account/watch', {}, {
        onItem: (item) => onView(obj(item)),
        onEnd: () => retry(),
        onError: (e) => (e instanceof DshClosedError ? undefined : retry()),
      });
    };
    const retry = () => {
      if (!stopped) timer = setTimeout(open, 2000);
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.cancel();
    };
  }
  private accountClient() {
    return { version: 'api-demo', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
  }
  async accountState() {
    return obj(await this.call('account/getState', {}));
  }
  async startSignIn(callbackOrigin: string) {
    return obj(await this.call('account/startSignIn', { client: this.accountClient(), callbackOrigin, loginSource: 'web' }));
  }
  async cancelSignIn(attemptId: string) {
    return obj(await this.call('account/cancelSignIn', { attemptId }));
  }
  async signOut() {
    return obj(await this.call('account/signOut', { client: this.accountClient() }));
  }
  async accountProfile() {
    const v = await this.call('account/getProfile', { client: this.accountClient() });
    return v == null ? null : obj(v);
  }
  async accountBalance() {
    const v = await this.call('account/getBalance', { client: this.accountClient() });
    return v == null ? null : obj(v);
  }
  async hasRunningAccountTasks() {
    return (await this.call('account/hasRunningAccountTasks', {})) === true;
  }
  initializeDefaultModel() {
    return this.call('session/initializeDefaultModel', {});
  }

  async createWorkspace(path: string) {
    return obj(await this.call('workspace/create', { request: { path } }));
  }
  renameWorkspace(workspaceId: string, title: string) {
    return this.call('workspace/rename', { request: { workspaceId, title } });
  }
  deleteWorkspace(workspaceId: string) {
    return this.call('workspace/delete', { request: { workspaceId } });
  }
  moveWorkspace(workspaceId: string, beforeWorkspaceId?: string) {
    return this.call('workspace/insertBefore', { request: clean({ workspaceId, beforeWorkspaceId }) });
  }
  /** `directoryPicker/list`: one level (home when [path] is omitted). */
  async listDirectory(path?: string) {
    const v = obj(await this.call('directoryPicker/list', clean({ path })));
    return {
      path: str(v.path) ?? '',
      home: str(v.home) ?? '',
      entries: list(v.entries).map((e) => ({ name: str(obj(e).name) ?? '', path: str(obj(e).path) ?? '', hidden: obj(e).hidden === true })),
      truncated: v.truncated === true,
    };
  }
  async createDirectory(parent: string, name: string) {
    return obj(await this.call('directoryPicker/createDirectory', { path: parent, name }));
  }

  // ---------- engine settings (settings/describe + settings/mutate) ----------

  async describeSettings() {
    return obj(await this.call('settings/describe', {}));
  }
  async mutateSettings(ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[], expectedRevision?: number) {
    return obj(await this.call('settings/mutate', clean({ ns, ops: ops.map((o) => (o.op === 'set' ? o : { op: o.op, path: o.path })), expectedRevision })));
  }
  async listConfigurableProviders() {
    return list(await this.call('llm/listConfigurableProviders', {})).map(obj);
  }
  async discoverModels(request: Record<string, unknown>, settingsNs = 'llm-pi-ai') {
    return list(await this.call('llm/discoverModels', { settingsNs, request })).map(obj);
  }

  // ---------- plugin manager (the engine's own plugins) ----------

  async listBundles() {
    return list(await this.call('pluginManager/listBundles', {})).map(obj);
  }
  setBundleEnabled(name: string, enabled: boolean) {
    return this.call('pluginManager/setBundleEnabled', { name, enabled });
  }
  async inspectBundle(spec: string) {
    return obj(await this.call('pluginManager/inspect', { spec }));
  }
  async installBundle(spec: string, options?: { enabled?: boolean; saveExact?: boolean; requestId?: string }) {
    return obj(await this.call('pluginManager/installBundle', options ? { spec, options } : { spec }, 30 * 60_000));
  }
  async listAgentPresets() {
    return list(obj(await this.call('agentPresets/list', {})).presets).map(obj);
  }
  /**
   * pluginManager/updateBundle: replaces an installed third-party bundle with an exact newer version
   * (remove, then install; the plugin's data stays). Answers {from, to, step, result: ChangeResult}:
   * `from` is '' when this profile doesn't have the package, and a version that isn't newer is
   * refused at step 'check'.
   */
  async updateBundle(name: string, version: string) {
    return obj(await this.call('pluginManager/updateBundle', { name, version }, 30 * 60_000));
  }
  async removeBundle(name: string) {
    return obj(await this.call('pluginManager/removeBundle', { name }));
  }
  /** `agentPresets/read`: the preset's YAML as the Host resolves it. */
  async readAgentPreset(id: string) {
    const v = obj(await this.call('agentPresets/read', { agentPreset: id }));
    return { id: str(v.agentPreset) ?? id, content: str(v.content) ?? '', name: str(v.name), description: str(v.description) };
  }
  /** New conversations' preset, as the official settings page sets it (`agent-preset-registry`). */
  async setDefaultAgentPreset(id: string) {
    const ns = list(obj(await this.call('settings/describe', {})).namespaces)
      .map(obj)
      .find((n) => n.ns === 'agent-preset-registry');
    await this.call('settings/update', clean({ ns: 'agent-preset-registry', patch: { selectedDefault: id }, expectedRevision: typeof ns?.revision === 'number' ? ns.revision : undefined }));
  }
  /** The newest record's seq (`session/projections` asOfSeq); -1 for an empty session. */
  async lastSeq(sessionId: string) {
    const p = obj(await this.call('session/projections', { request: { sessionId } }));
    return typeof p.asOfSeq === 'number' ? p.asOfSeq : -1;
  }
  /** The last [max] raw records of a session (`session/projections` for the cut, then `session/page`). */
  async latestRecords(sessionId: string, max = 200) {
    const p = obj(await this.call('session/projections', { request: { sessionId } }));
    const through = typeof p.asOfSeq === 'number' ? p.asOfSeq : -1;
    if (through < 0) return [];
    const v = obj(await this.call('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: through, maxMessages: max } }));
    return list(v.records).map((r) => obj(obj(r).event));
  }

  // ---------- terminals ----------

  async terminalShells(sessionId: string) {
    return list(await this.call('terminal/shells', { agentId: sessionId })).map(obj);
  }
  async listTerminals(sessionId: string) {
    return list(await this.call('terminal/list', { sessionId })).map(obj);
  }
  async createTerminal(sessionId: string, id: string, cols: number, rows: number, shellPath?: string) {
    return obj(await this.call('terminal/create', { agentId: sessionId, request: clean({ id, cols, rows, shellPath }) }));
  }
  closeTerminal(sessionId: string, id: string) {
    return this.call('terminal/close', { agentId: sessionId, id });
  }
  renameTerminal(sessionId: string, id: string, title: string) {
    return this.call('terminal/rename', { agentId: sessionId, id, title });
  }
  /** `terminal/attach`: a duplex stream; downlink snapshot / output / state / ack, uplink write / resize. */
  attachTerminal(sessionId: string, id: string, handlers: { onItem: (v: Record<string, unknown>) => void; onEnd?: () => void; onError?: (e: Error) => void }) {
    return this.mux.open('terminal/attach', { agentId: sessionId, id }, { onItem: (v) => handlers.onItem(obj(v)), onEnd: handlers.onEnd, onError: handlers.onError });
  }

  // ---------- schedules: history ----------

  async scheduleHistory(id: string, limit = 20) {
    return obj(await this.call('schedule/history', { request: { id, limit } }));
  }

  // ---------- automation tasks (schedule/*, DSH 0.2.2 target protocol) ----------

  /** `schedule/catalog`: every stored task on this Host. */
  async scheduleCatalog(): Promise<Record<string, unknown>[]> {
    return list(await this.call('schedule/catalog', {})).map(obj);
  }
  /** `schedule/create`: timing is `{kind, <selector>}` (e.g. `{kind:'daily', daily:{time, time_zone}}`). */
  async createSchedule(request: { title: string; prompt: string; timing: Record<string, unknown>; target: Record<string, unknown> }) {
    const v = obj(await this.call('schedule/create', { request }));
    const code = str(v.code);
    if (code) throw new DshRemoteError(code, str(v.message) ?? code);
    return v;
  }
  /** `schedule/edit`: `update` (with a patch) or `delete`, against the task's `updatedAt`. */
  async editSchedule(id: string, action: 'update' | 'delete', expectedUpdatedAt: string | undefined, patch?: Record<string, unknown>) {
    const v = obj(await this.call('schedule/edit', { request: clean({ id, action, patch, expectedUpdatedAt }) }));
    const code = str(v.code);
    if (code && !(action === 'delete' && code === 'schedule_not_found')) throw new DshRemoteError(code, str(v.message) ?? code);
    return v;
  }
  async runSchedule(id: string) {
    const v = obj(await this.call('schedule/run', { request: { id } }));
    const code = str(v.code);
    if (code) throw new DshRemoteError(code, code);
  }

  /** `session/projections`: non-activating read (title, inbox, …). */
  async projections(sessionId: string) {
    const v = obj(await this.call('session/projections', { request: { sessionId } }));
    return obj(v.values ?? v);
  }
  /** Removes a still-queued prompt (`session/updateQueue`). */
  async removeQueued(sessionId: string, itemId: string) {
    await this.call('session/updateQueue', { request: { sessionId, itemId, action: { kind: 'remove' } } });
  }
  /** Omit [atSeq] to fork at the latest completed turn. */
  async forkAt(sessionId: string, atSeq?: number) {
    return this.forkSession(sessionId, atSeq);
  }

  // ---------- approvals & questions ($events/result) ----------

  async respondHostEvent(eventId: string, outcome: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      const g = await this.mux.ready();
      try {
        await this.call('$events/result', { clientId: g.clientId, eventId, outcome });
        return;
      } catch (e) {
        const stale = e instanceof DshRemoteError && e.message.includes('identifies no active event stream');
        if (!stale || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  /** Engine vocabulary: `allowed-once` | `rejected`; `pass` lets another client answer. */
  respondApproval(eventId: string, decision: 'allowed-once' | 'rejected' | 'pass') {
    return this.respondHostEvent(eventId, decision === 'pass' ? { kind: 'next' } : { kind: 'result', value: decision });
  }
  /** Engine shape: `{id, selected: [labels], custom?}` per question. */
  answerQuestion(eventId: string, answers: { id: string; selected: string[]; custom?: string }[]) {
    return this.respondHostEvent(eventId, { kind: 'result', value: { answers } });
  }
  rejectQuestion(eventId: string, message = 'declined') {
    return this.respondHostEvent(eventId, { kind: 'rejected', error: { name: 'UserQuestionError', message } });
  }

  // ---------- models, keys, permissions, commands ----------

  async modelCatalog(): Promise<ModelCatalog> {
    const v = obj(await this.call('session/modelCatalog'));
    const def = obj(v.default);
    return {
      defaultSelection: str(def.provider) ? { provider: str(def.provider)!, model: str(def.model) ?? '', reasoningEffort: str(def.reasoningEffort) } : undefined,
      groups: list(v.groups).map((g) => {
        const gm = obj(g);
        const pid = str(gm.id) ?? '';
        return {
          id: pid,
          name: str(gm.name) ?? pid,
          models: list(gm.models).map((m) => {
            const mm = obj(m);
            const r = obj(mm.reasoning);
            return {
              provider: pid,
              id: str(mm.id) ?? '',
              name: str(mm.name) ?? str(mm.id) ?? '',
              description: str(mm.description),
              efforts: list(r.efforts).map((e) => ({ id: str(obj(e).id) ?? '', name: str(obj(e).name) ?? str(obj(e).id) ?? '', description: str(obj(e).description) })),
              defaultEffort: str(r.defaultEffort),
            };
          }),
        };
      }),
    };
  }
  selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string) {
    return this.call('session/selectModel', { request: clean({ sessionId, provider, model, reasoningEffort }) });
  }
  async describeCredentials(refs: string[]) {
    const v = obj(await this.call('credentials/describe', { refs }));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { configured: bool(obj(x).configured) ?? false, source: str(obj(x).source), writable: bool(obj(x).writable) ?? false }]));
  }
  setProviderKey(apiKey: string, ref = 'DEEPSEEK_API_KEY') {
    if (!apiKey.trim()) throw new Error('empty key');
    return this.call('credentials/set', { ref, value: apiKey.trim() });
  }
  clearProviderKey(ref = 'DEEPSEEK_API_KEY') {
    return this.call('credentials/unset', { ref });
  }
  async permissionPresets() {
    const v = obj(await this.call('permissionPresets/catalog'));
    const opts = (x: unknown) => list(x).map((o) => ({ value: str(obj(o).value) ?? '', name: str(obj(o).name) ?? '', description: str(obj(o).description) }));
    return { options: opts(v.options), defaultPreset: str(v.defaultPreset) ?? '' };
  }
  setPermissionPreset(sessionId: string, preset: string) {
    return this.executeCommand(sessionId, `/permission ${preset}`);
  }
  async executeCommand(sessionId: string, line: string) {
    const compact = /^\/compact(\s|$)/.test(line.trim());
    return obj(await this.call('commands/execute', { agentId: sessionId, line, submittedAttachments: [] }, compact ? 30 * 60_000 : undefined));
  }

  // ---------- session-scoped pages ----------

  async listSkills(sessionId: string): Promise<SkillInfo[]> {
    const v = obj(await this.call('skills/list', { request: { sessionId } }));
    return list(v.skills)
      .map((s) => obj(s))
      .filter((s) => str(s.name))
      .map((s) => ({ name: str(s.name)!, description: str(s.description) ?? '', source: str(s.source) ?? str(s.scope), path: str(s.path) }));
  }
  watchJobs(sessionId: string, onJobs: (jobs: JobInfo[]) => void): () => void {
    const s = this.mux.open(
      'job/list',
      { request: { sessionId } },
      {
        onItem: (item) =>
          onJobs(
            list(obj(item).jobs).map((j) => {
              const m = obj(j);
              return { jobId: str(m.id) ?? '', command: str(m.label) ?? str(m.id) ?? '', status: str(m.status) ?? 'running', startedAt: int(m.startedAt), exitCode: int(m.exitCode), detail: str(m.detail) ?? str(m.progress) };
            }),
          ),
      },
    );
    return () => s.cancel();
  }
  async killJob(sessionId: string, jobId: string) {
    const v = obj(await this.call('job/kill', { request: { sessionId, jobId } }));
    return v.outcome === 'requested';
  }
  async listFiles(sessionId: string, path: string): Promise<FileEntry[]> {
    const v = obj(await this.call('workspaceFiles/list', { workspaceFileScopeId: sessionId, path: path || '.' }));
    return list(v.entries)
      .map((e) => obj(e))
      .filter((m) => str(m.name))
      .map((m) => {
        const name = str(m.name)!;
        return { name, path: path ? `${path}/${name}` : name, kind: m.type === 'directory' ? ('directory' as const) : ('file' as const), size: int(m.size) };
      });
  }
  async readFile(sessionId: string, path: string, offset = 1, limit = 500) {
    const v = obj(await this.call('workspaceFiles/read', { workspaceFileScopeId: sessionId, path, range: { offset, limit } }));
    return { text: str(v.text) ?? '', lines: int(v.lines) ?? 0, eof: v.eof === true };
  }
  async goal(sessionId: string): Promise<GoalView | null> {
    const m = obj(await this.call('goals/get', { agentId: sessionId }));
    if (!str(m.objective)) return null;
    return { objective: str(m.objective)!, status: str(m.phase) ?? 'active', rounds: int(m.roundsStarted), maxRounds: int(m.maxGoalRounds) };
  }
  createGoal(sessionId: string, objective: string) {
    return this.call('goals/create', { agentId: sessionId, request: { objective: objective.trim() } });
  }
  goalAction(sessionId: string, action: 'pause' | 'resume' | 'complete' | 'clear') {
    return this.call(`goals/${action}`, { agentId: sessionId });
  }
  async fileReferences(sessionId: string, query: string) {
    const v = await this.call('fileReferences/list', { agentId: sessionId, query });
    return list(v)
      .map((x) => obj(x))
      .filter((m) => str(m.path))
      .map((m) => ({ path: str(m.path)!, directory: m.kind === 'directory' }));
  }

  /** The raw session log as a downloadable JSON file. */
  /**
   * An image from the conversation's log (`session/attachment`). Hosts from before
   * whole-reference reads refuse `attachment` as invalid input; they take the id.
   */
  async attachment(sessionId: string, ref: Record<string, unknown>): Promise<{ mediaType: string; data: string }> {
    const read = async (whole: boolean) => obj(await this.call('session/attachment', { request: whole ? { sessionId, attachment: ref } : { sessionId, attachmentId: ref.attachmentId } }));
    let v: Record<string, unknown>;
    try {
      v = await read(this.wholeAttachmentRefs !== false);
    } catch (e) {
      if (this.wholeAttachmentRefs !== undefined || !(e instanceof DshRemoteError) || !['gateway/arguments-invalid', 'gateway/input-invalid'].includes(e.code)) throw e;
      v = await read(false);
      this.wholeAttachmentRefs = false;
    }
    this.wholeAttachmentRefs ??= true;
    return { mediaType: str(obj(v.attachment).mediaType) ?? str(ref.mediaType) ?? 'image/png', data: str(v.data) ?? '' };
  }
  private wholeAttachmentRefs: boolean | undefined;

  async exportLog(sessionId: string): Promise<Blob> {
    const res = await fetch(`/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  // ---------- reasoning translation (optional engine bundle) ----------

  async cotLimits() {
    const v = obj(await this.call('cotTranslation/limits'));
    return { provider: str(v.provider) ?? str(obj(v.accepted).provider), targetLanguage: str(v.targetLanguage) ?? str(obj(v.accepted).targetLanguage) ?? 'zh' };
  }
  async translateReasoning(text: string, sessionId?: string) {
    const l = await this.cotLimits();
    if (!l.provider) throw new Error('没有可用的翻译服务');
    return str(await this.call('cotTranslation/translate', { request: clean({ text, targetLanguage: l.targetLanguage, provider: l.provider, sessionId }) })) ?? '';
  }

  // ---------- plugins (engine half of dsh-Go plugins) ----------

  pluginManager(method: string, args: Record<string, unknown> = {}) {
    return this.call(`pluginManager/${method}`, args);
  }
}

export type { TodoItem, LogEvent };

function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** `@path` mention as the engine's file-reference grammar writes it. */
export function formatFileMention(path: string, directory = false): string | null {
  const text = directory ? `${path}/` : path;
  if (/["\n\r\t\0]/.test(text)) return null;
  if (!/\s/.test(text)) return `@${text}`;
  return directory ? `@"${text}` : `@"${text}"`;
}

/** messageFeedback/* carry their own `{ok, value | error}` inside the RPC value. */
function unwrapFeedback(v: unknown): unknown {
  const m = obj(v);
  if (m.ok === true) return m.value;
  if (m.ok === false) throw DshRemoteError.fromJson(m.error);
  return v;
}
