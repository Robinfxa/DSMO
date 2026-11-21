// A pretend `dsh web` for the interactive prototype and for tests. It speaks
// the same wire protocol as the real engine (RPC envelopes, mux frames,
// `$events` ready/emit/waterfall, follow snapshots, assistant-stream frames),
// so the prototype exercises the real client code end to end.

import { MockHost, UNHANDLED } from './host';
import type { MuxSocket, SocketFactory } from '../engine/mux';
import type { RpcTransport } from '../engine/rpc';
import { DshRemoteError } from '../engine/errors';
import { list, obj, str, uuid } from '../engine/json';
import { pickScript, type Script } from './scripts';
import { importedSessionId } from '../history/import-id';

type Ev = { type: string; seq: number; time: number; data: Record<string, unknown> };

interface MockSession {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  parentId?: string;
  log: Ev[];
  running: boolean;
  turn: number;
  permission: string;
  model: { provider: string; model: string; reasoningEffort: string };
  inbox: { 'next-turn': unknown[]; 'next-step': unknown[] };
  goal: null | { objective: string; phase: string; roundsStarted: number; maxGoalRounds: number };
  archived: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  partial?: { turn: number; step: number; text: string; reasoning: string; attemptId: string };
  waitingApproval?: { eventId: string; resume: (allowed: boolean) => void };
  waitingQuestion?: { eventId: string; resume: (answer: string | null) => void };
  /** The `agentTeam` projection of a Lead (experimental agent-team profile). */
  team?: { members: unknown[]; tasks: unknown[] };
}

interface Follower {
  sock: FakeSocket;
  streamId: string;
  sessionId: string;
  stream: boolean;
}

const HOME = '/home/user';
const WS = '/home/user/workspace';
const now = () => Date.now();

const FILES: Record<string, string> = {
  'README.md': '# 示例项目\n\n这是原型里的演示工作区。\n\n- 账单-10月.csv：本月账单\n- make_sheet.py：生成汇总表\n',
  '账单-10月.csv': '日期,类别,金额\n10-01,餐饮,36.5\n10-01,交通,4\n10-02,餐饮,52\n10-03,购物,199\n10-05,餐饮,41.2\n',
  'make_sheet.py': 'import csv, sys\nfrom collections import defaultdict\n\nsums = defaultdict(float)\nfor row in csv.DictReader(open(sys.argv[1])):\n    sums[row["类别"]] += float(row["金额"])\nfor k, v in sorted(sums.items()):\n    print(f"{k}\\t{v:.2f}")\n',
  '汇总-10月.csv': '类别,金额\n餐饮,129.70\n购物,199.00\n交通,4.00\n',
  'src/app.ts': 'export function hello(name: string) {\n  return `你好，${name}`;\n}\n',
};

export class MockEngine {
  sessions = new Map<string, MockSession>();
  private sockets = new Set<FakeSocket>();
  private followers = new Set<Follower>();
  private eventsStreams = new Map<FakeSocket, { streamId: string; clientId: string }>();
  private pendingWaterfalls = new Map<string, { sessionId: string; request: Record<string, unknown>; event: string }>();
  private credentials: Record<string, string> = {};
  private jobs = new Map<string, { id: string; label: string; status: string; startedAt: number; sessionId: string }>();
  private jobWatchers = new Set<{ sock: FakeSocket; streamId: string; sessionId: string }>();
  private pinned: string[] = [];
  private pinWatchers = new Set<{ sock: FakeSocket; streamId: string }>();
  private feedback = new Map<string, { rating: string; version: string }>();
  /** `/root/.dsh/skills/<name>/…` as the App writes it (no Remote for this; the bridge does it). */
  userSkills = new Map<string, Record<string, string>>();
  readonly host = new MockHost();
  private hostStreams = new Map<string, () => void>();
  private uplinks = new Map<string, (v: Record<string, unknown>) => void>();
  private schedules = new Map<string, Record<string, unknown>>();
  private scheduleRuns = new Map<string, Record<string, unknown>[]>();

  /** The bridge's skills.install / skills.remove, as the prototype pretends them. */
  skillFs(op: 'install' | 'remove', payload: unknown) {
    if (op === 'install') for (const sk of list(payload).map(obj)) this.userSkills.set(str(sk.name) ?? '', obj(sk.files) as Record<string, string>);
    else for (const n of list(payload)) this.userSkills.delete(String(n));
  }
  /** dsh-go-bridge's session import (`/dsh-go/v1/sessions/import`) as the prototype pretends it. */
  async importConversations(source: string, convs: unknown[]) {
    const results: Record<string, unknown>[] = [];
    for (const raw of convs) {
      const c = obj(raw);
      const sourceId = str(c.sourceId);
      const messages = list(c.messages).map(obj);
      if (!sourceId || !messages.some((m) => m.role === 'user')) {
        results.push({ sourceId: sourceId ?? null, status: 'failed', code: 'invalid' });
        continue;
      }
      const id = await importedSessionId(source, sourceId);
      if (this.sessions.has(id)) {
        results.push({ sourceId, status: 'skipped', sessionId: id });
        continue;
      }
      const createdAt = Number(c.createdAt) || now();
      const updatedAt = Math.max(Number(c.updatedAt) || createdAt, createdAt);
      const s = this.newSession(str(c.title) || str(messages[0].text)?.slice(0, 30) || '导入的对话');
      this.sessions.delete(s.id);
      Object.assign(s, { id, createdAt, updatedAt, log: [] as Ev[] });
      const push = (type: string, data: Record<string, unknown>, time: number) => s.log.push({ type, seq: s.log.length, time, data });
      push('plugin:dsh-go/import', { source, sourceId }, createdAt);
      let t = createdAt;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const reply = m.role === 'user' ? (messages[i + 1]?.role === 'assistant' ? messages[++i] : undefined) : m;
        t = Math.max(t, Number(m.time) || t);
        s.turn++;
        push('turn/start', { turn: s.turn }, t);
        if (m.role === 'user') push('user/message', { role: 'user', id: uuid(), content: [{ type: 'text', text: str(m.text) ?? '' }], source: { kind: 'user' } }, t);
        if (reply) {
          t = Math.max(t, Number(reply.time) || t);
          const content = [...(str(reply.think) ? [{ type: 'reasoning', text: str(reply.think) }] : []), { type: 'text', text: str(reply.text) ?? '' }];
          push('assistant/message', { turn: s.turn, step: 1, message: { role: 'assistant', id: uuid(), content, source: { kind: 'model', provider: 'deepseek-import', model: str(reply.model) ?? 'deepseek-chat' } } }, t);
        }
        push('turn/end', { turn: s.turn, reason: { kind: 'completed' } }, t);
      }
      push('session/title', { title: s.title, messageSeqs: [], source: { kind: 'user' } }, t);
      s.updatedAt = t;
      this.sessions.set(id, s);
      this.emit('api-session/added', [this.summary(s)]);
      results.push({ sourceId, status: 'imported', sessionId: id });
    }
    return results;
  }
  /** Milliseconds multiplier: tests set 0 to run scripts instantly. */
  speed = 1;

  constructor(seed = true) {
    if (seed) this.seed();
  }

  // ------------------------------------------------------------------ wiring

  readonly rpc: RpcTransport = {
    call: async (endpoint, args = {}) => {
      await new Promise((r) => setTimeout(r, this.speed * (60 + Math.random() * 80)));
      // a host takes a while to install a package; tests set window.__mockInstallMs to see the queue
      const slow = /^pluginManager\/(installBundle|updateBundle)$/.test(endpoint) ? Number((globalThis as { __mockInstallMs?: number }).__mockInstallMs) || 0 : 0;
      if (slow) await new Promise((r) => setTimeout(r, slow));
      return this.handle(endpoint, args);
    },
  };

  readonly socketFactory: SocketFactory = () => {
    const s = new FakeSocket(this);
    this.sockets.add(s);
    setTimeout(() => s.onopen?.(), this.speed ? 30 : 0);
    return s;
  };

  onClientFrame(sock: FakeSocket, frame: Record<string, unknown>) {
    const streamId = str(frame.streamId) ?? '';
    if (frame.type === 'item' && this.uplinks.has(streamId)) {
      this.uplinks.get(streamId)!(obj(frame.value));
      return;
    }
    if (frame.type === 'cancel') {
      this.hostStreams.get(streamId)?.();
      this.hostStreams.delete(streamId);
      this.uplinks.delete(streamId);
      for (const f of this.followers) if (f.sock === sock && f.streamId === streamId) this.followers.delete(f);
      for (const w of this.jobWatchers) if (w.sock === sock && w.streamId === streamId) this.jobWatchers.delete(w);
      for (const w of this.pinWatchers) if (w.sock === sock && w.streamId === streamId) this.pinWatchers.delete(w);
      return;
    }
    if (frame.type !== 'open') return;
    const endpoint = str(frame.endpoint);
    const args = obj(obj(frame.payload).args);
    if (endpoint === '$events') {
      const clientId = uuid();
      this.eventsStreams.set(sock, { streamId, clientId });
      sock.deliver({ type: 'item', streamId, value: { type: 'ready', clientId, host: { home: HOME } } });
      for (const s of this.sessions.values()) if (!s.archived) sock.deliver({ type: 'item', streamId, value: { type: 'emit', event: 'api-session/added', args: [this.summary(s)] } });
      for (const [eventId, w] of this.pendingWaterfalls) sock.deliver({ type: 'item', streamId, value: { type: 'waterfall', event: w.event, eventId, agentId: w.sessionId, request: w.request } });
      return;
    }
    if (endpoint === 'session/follow') {
      const req = obj(args.request);
      const sessionId = str(obj(req.address).sessionId) ?? '';
      const s = this.sessions.get(sessionId);
      if (!s) return sock.deliver({ type: 'error', streamId, error: { code: 'session/not-found', message: `no session ${sessionId}` } });
      const f: Follower = { sock, streamId, sessionId, stream: req.assistantStream === true };
      this.followers.add(f);
      sock.deliver({ type: 'item', streamId, value: this.snapshot(s, f.stream) });
      return;
    }
    if (endpoint === 'workspace/follow') {
      this.pinWatchers.add({ sock, streamId });
      this.hostStreams.set(streamId, this.host.watchWorkspaces((value) => sock.deliver({ type: 'item', streamId, value })) as unknown as () => void);
      sock.deliver({ type: 'item', streamId, value: { type: 'baseline', value: { items: this.host.baselineItems(), archivedSessionIds: this.archivedIds(), pinnedSessionIds: this.pinned } } });
      return;
    }
    if (endpoint === 'account/watch') {
      this.hostStreams.set(streamId, this.host.watchAccount((value) => sock.deliver({ type: 'item', streamId, value })));
      return;
    }
    if (endpoint === 'terminal/attach') {
      const deliver = (value: unknown) => sock.deliver({ type: 'item', streamId, value });
      const id = str(args.id) ?? '';
      const r = this.host.attachTerminal(str(args.agentId) ?? '', id, deliver);
      if (typeof r === 'string') return sock.deliver({ type: 'error', streamId, error: { code: r, message: '这个终端已经关了' } });
      this.hostStreams.set(streamId, r);
      this.uplinks.set(streamId, (v) => this.host.terminalUplink(id, v, deliver));
      return;
    }
    if (endpoint === 'job/list') {
      const sessionId = str(obj(args.request).sessionId) ?? '';
      const w = { sock, streamId, sessionId };
      this.jobWatchers.add(w);
      this.pushJobs(sessionId);
      return;
    }
    sock.deliver({ type: 'error', streamId, error: { code: 'gateway/unknown-endpoint', message: `mock has no stream ${endpoint}` } });
  }

  dropSocket(sock: FakeSocket) {
    this.sockets.delete(sock);
    this.eventsStreams.delete(sock);
    for (const f of this.followers) if (f.sock === sock) this.followers.delete(f);
    for (const w of this.jobWatchers) if (w.sock === sock) this.jobWatchers.delete(w);
    for (const w of this.pinWatchers) if (w.sock === sock) this.pinWatchers.delete(w);
  }

  private pushPins() {
    for (const w of this.pinWatchers) w.sock.deliver({ type: 'item', streamId: w.streamId, value: { type: 'pinned', pinnedSessionIds: this.pinned } });
  }
  private archivedIds() {
    return [...this.sessions.values()].filter((x) => x.archived).map((x) => x.id);
  }

  /** workspace/follow's `archived` frame: the full set, as DSH sends it. */
  private pushArchived() {
    for (const w of this.pinWatchers) w.sock.deliver({ type: 'item', streamId: w.streamId, value: { type: 'archived', archivedSessionIds: this.archivedIds() } });
  }


  /** Simulates a network blip: every socket closes; clients reconnect and resync. */
  blip() {
    for (const s of [...this.sockets]) s.serverClose();
  }

  // ------------------------------------------------------------------ host events

  private emit(event: string, args: unknown[]) {
    for (const [sock, e] of this.eventsStreams) sock.deliver({ type: 'item', streamId: e.streamId, value: { type: 'emit', event, args } });
  }
  private waterfall(eventId: string, sessionId: string, request: Record<string, unknown>, event = 'approval/request') {
    this.pendingWaterfalls.set(eventId, { sessionId, request, event });
    for (const [sock, e] of this.eventsStreams) sock.deliver({ type: 'item', streamId: e.streamId, value: { type: 'waterfall', event, eventId, agentId: sessionId, request } });
  }
  private cancelWaterfall(eventId: string, except?: string) {
    this.pendingWaterfalls.delete(eventId);
    for (const [sock, e] of this.eventsStreams) if (e.clientId !== except) sock.deliver({ type: 'item', streamId: e.streamId, value: { type: 'cancel', eventId } });
  }

  // ------------------------------------------------------------------ sessions

  private newSession(title: string | null, cwd = WS, id = `session-${uuid()}`): MockSession {
    const t = now();
    const s: MockSession = {
      id,
      title,
      createdAt: t,
      updatedAt: t,
      cwd,
      log: [],
      running: false,
      turn: 0,
      permission: 'workspace-write',
      model: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      inbox: { 'next-turn': [], 'next-step': [] },
      goal: null,
      archived: false,
      timers: new Set(),
    };
    this.sessions.set(s.id, s);
    this.append(s, 'permission/preset', { preset: s.permission });
    return s;
  }

  private summary(s: MockSession) {
    return {
      sessionId: s.id,
      updatedAt: s.updatedAt,
      agentAvailable: true,
      running: s.running,
      blank: s.turn === 0,
      cwd: s.cwd,
      parentSessionId: s.parentId,
      origin: s.parentId ? 'subagent' : undefined,
      projections: { kind: 'sequenced', asOfSeq: s.log.length - 1, values: this.projections(s) },
    };
  }

  private projections(s: MockSession) {
    let todos: unknown = null;
    for (const e of s.log) {
      if (e.type === 'turn/start') todos = null;
      if (e.type === 'todo/write') todos = e.data.todos;
    }
    return {
      title: s.title,
      goal: s.goal,
      inbox: s.inbox,
      permissions: { currentValue: s.permission },
      todos,
      modelSelection: { lastUsed: s.model, next: s.model },
      sessionListMetadata: { blank: s.turn === 0, lastPromptAt: s.updatedAt },
      agentPreset: 'standard',
      ...(s.team ? { agentTeam: s.team } : {}),
    };
  }

  private snapshot(s: MockSession, withStream: boolean) {
    const records = s.log.slice(-400).map((event) => ({ type: 'event', event }));
    const p = s.partial;
    return {
      type: 'snapshot',
      header: { version: 4, id: s.id, createdAt: s.createdAt, cwd: s.cwd },
      cursor: s.log.length - 1,
      records,
      hasMore: s.log.length > 400,
      projections: { asOfSeq: s.log.length - 1, values: this.projections(s) },
      assistantStream:
        withStream && p
          ? {
              revision: 1,
              activeAttempt: {
                attemptId: p.attemptId,
                startedAfterSeq: s.log.length - 1,
                turn: p.turn,
                step: p.step,
                nextIndex: 9999,
                stream: [
                  ...(p.reasoning ? [{ type: 'chunk', time: now(), chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }, { type: 'reasoning-chunks', time0: now(), index: 0, dt: [], texts: [p.reasoning] }] : []),
                  ...(p.text ? [{ type: 'chunk', time: now(), chunk: { type: 'block-start', index: 1, blockType: 'text' } }, { type: 'text-chunks', time0: now(), index: 1, dt: [], texts: [p.text] }] : []),
                ],
              },
            }
          : { revision: 0 },
    };
  }

  private append(s: MockSession, type: string, data: Record<string, unknown>) {
    const e: Ev = { type, seq: s.log.length, time: now(), data };
    s.log.push(e);
    s.updatedAt = e.time;
    for (const f of this.followers) if (f.sessionId === s.id) f.sock.deliver({ type: 'item', streamId: f.streamId, value: { type: 'event', event: e } });
    return e;
  }
  private streamFrame(s: MockSession, frame: Record<string, unknown>) {
    for (const f of this.followers) if (f.sessionId === s.id && f.stream) f.sock.deliver({ type: 'item', streamId: f.streamId, value: { type: 'assistant-stream', frame } });
  }
  private setRunning(s: MockSession, running: boolean) {
    s.running = running;
    this.emit('api-session/status', [s.id, running]);
  }
  private later(s: MockSession, ms: number, fn: () => void) {
    const t = setTimeout(() => {
      s.timers.delete(t);
      fn();
    }, ms * this.speed);
    s.timers.add(t);
  }

  // ------------------------------------------------------------------ turns

  private userMessage(text: string, requestId: string, images: unknown[] = []) {
    return { role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...images], source: { kind: 'user', rpcId: requestId, clientTimeZone: 'Asia/Shanghai' }, id: uuid() };
  }

  /** Bytes behind the log's image references (`session/attachment`), as the engine keeps them. */
  private readonly attachments = new Map<string, { mediaType: string; data: string }>();

  /** Prompt images as the log records them: a durable reference, no bytes. */
  private storeImages(content: unknown): unknown[] {
    return list(content)
      .map(obj)
      .filter((p) => p.type === 'image' && typeof p.data === 'string')
      .map((p) => {
        const attachmentId = `att-${uuid()}`;
        const mediaType = str(p.mediaType) ?? 'image/png';
        this.attachments.set(attachmentId, { mediaType, data: p.data as string });
        return { type: 'image', attachment: { attachmentId, mediaType, bytes: Math.floor(((p.data as string).length * 3) / 4), ...(str(p.name) ? { name: str(p.name) } : {}) } };
      });
  }

  private startTurn(s: MockSession, text: string, requestId: string, images: unknown[] = []) {
    s.turn++;
    const turn = s.turn;
    this.setRunning(s, true);
    this.append(s, 'turn/start', { turn });
    this.append(s, 'step/start', { turn, step: 1 });
    this.append(s, 'user/message', this.userMessage(text, requestId, images));
    if (!s.title) {
      s.title = text.length > 16 ? text.slice(0, 16) + '…' : text;
      this.append(s, 'session/title', { title: s.title, messageSeqs: [s.log.length - 1], source: { kind: 'fallback' } });
      this.emit('api-session/added', [this.summary(s)]);
    }
    const script = pickScript(text, { effort: s.model.reasoningEffort, permission: s.permission });
    this.runScript(s, turn, 1, script, 0);
  }

  /** Streams one assistant step, then follows the script's tool calls. */
  private runScript(s: MockSession, turn: number, step: number, script: Script, at: number) {
    const part = script.steps[at];
    if (!part) return this.endTurn(s, turn, 'completed');
    if (part.ask && !part.text && !part.tool) {
      const eventId = uuid();
      const ask = part.ask;
      // Set before anything streams, so the sub-script's end doesn't end the turn.
      s.waitingQuestion = {
        eventId,
        resume: (answer) => {
          s.waitingQuestion = undefined;
          const rest = script.steps.slice(at + 1).map((x) => (x.text ? { ...x, text: x.text.replace('{answer}', answer ?? '随意') } : x));
          this.runScript(s, turn, step + 1, { steps: answer === null ? [{ text: '好的，那我按默认方式来。' }] : rest }, 0);
        },
      };
      const go = () => this.waterfall(eventId, s.id, { questions: ask }, 'user-questions/request');
      if (part.reasoning) {
        // Show the reasoning as its own committed step first.
        const thinking = { steps: [{ reasoning: part.reasoning, text: '我先确认一下你的偏好。' }] };
        this.runScript(s, turn, step, thinking, 0);
        const wait = setInterval(() => {
          if (!s.running) return clearInterval(wait);
          if (!s.partial && s.log.at(-1)?.type === 'step/end') {
            clearInterval(wait);
            go();
          }
        }, 50 * (this.speed || 0.02));
        return;
      }
      return go();
    }
    const attemptId = `${s.id}:${turn}.${step}`;
    s.partial = { turn, step, text: '', reasoning: '', attemptId };
    let idx = 0;
    const frame = (chunk: Record<string, unknown>) => this.streamFrame(s, { type: 'chunk', attemptId, revision: idx + 1, index: idx++, time: now(), chunk });
    this.streamFrame(s, { type: 'start', attemptId, revision: 0, turn, step, startedAfterSeq: s.log.length - 1 });
    const chunks: Array<() => void> = [];
    if (part.reasoning) {
      chunks.push(() => frame({ type: 'block-start', index: 0, blockType: 'reasoning' }));
      for (const piece of split(part.reasoning)) chunks.push(() => ((s.partial!.reasoning += piece), frame({ type: 'reasoning-delta', index: 0, text: piece })));
      chunks.push(() => frame({ type: 'block-end', index: 0, block: { type: 'reasoning', text: part.reasoning } }));
    }
    if (part.text) {
      chunks.push(() => frame({ type: 'block-start', index: 1, blockType: 'text' }));
      for (const piece of split(part.text)) chunks.push(() => ((s.partial!.text += piece), frame({ type: 'text-delta', index: 1, text: piece })));
      chunks.push(() => frame({ type: 'block-end', index: 1, block: { type: 'text', text: part.text } }));
    }
    const callId = part.tool ? `call_${uuid().slice(0, 8)}` : undefined;
    if (part.tool) {
      const args = JSON.stringify(part.tool.args);
      chunks.push(() => frame({ type: 'block-start', index: 2, blockType: 'tool-call' }));
      chunks.push(() => frame({ type: 'tool-call-delta', index: 2, id: callId, name: part.tool!.name, argumentsDelta: args }));
      chunks.push(() => frame({ type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: part.tool!.name, arguments: args } }));
    }
    chunks.push(() => frame({ type: 'finish', reason: { kind: part.tool ? 'tool-calls' : 'stop' } }));
    const tick = (i: number) => {
      if (!s.running) return;
      if (i >= chunks.length) return this.commitStep(s, turn, step, part, callId, attemptId, script, at);
      chunks[i]();
      this.later(s, i === 0 ? 350 : 38, () => tick(i + 1));
    };
    this.later(s, 240, () => tick(0));
  }

  private commitStep(s: MockSession, turn: number, step: number, part: Script['steps'][number], callId: string | undefined, attemptId: string, script: Script, at: number) {
    const content: unknown[] = [];
    if (part.reasoning) content.push({ type: 'reasoning', text: part.reasoning });
    if (part.text) content.push({ type: 'text', text: part.text });
    if (part.tool && callId) content.push({ type: 'tool-call', id: callId, name: part.tool.name, arguments: JSON.stringify(part.tool.args) });
    const msg = this.append(s, 'assistant/message', {
      turn,
      step,
      message: { role: 'assistant', content, source: { kind: 'model', provider: s.model.provider, model: s.model.model }, id: uuid() },
      usage: { inputTokens: 1200 + step * 300, outputTokens: (part.text?.length ?? 0) + (part.reasoning?.length ?? 0), totalTokens: 1500 },
    });
    s.partial = undefined;
    this.streamFrame(s, { type: 'end', attemptId, revision: 9999, index: 9999, outcome: { kind: 'committed', eventType: 'assistant/message', seq: msg.seq } });
    if (part.todos) this.append(s, 'todo/write', { turn, step, todos: part.todos });
    if (!part.tool || !callId) {
      this.append(s, 'step/end', { turn, step });
      return this.runScript(s, turn, step + 1, script, at + 1);
    }
    const tool = part.tool;
    this.append(s, 'tool/call', { turn, step, callId, name: tool.name, arguments: JSON.stringify(tool.args) });
    const finish = (allowed: boolean, outcome?: string, approvalId?: string) => {
      if (!s.running) return;
      if (approvalId) this.append(s, 'approval/decided', { id: approvalId, outcome: outcome ?? (allowed ? 'allowed-once' : 'rejected') });
      const job = tool.job && allowed ? this.startJob(s, tool.job) : null;
      this.later(s, allowed ? tool.ms ?? 700 : 150, () => {
        if (!s.running) return;
        this.append(s, 'tool/result', {
          turn,
          step,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            content: [{ type: 'text', text: allowed ? (job ? `已在后台启动：${job.label}（${job.id}）` : tool.result) : 'The user rejected this tool call.' }],
            isError: !allowed,
            id: uuid(),
          },
          sourceEventSeqs: [msg.seq],
        });
        if (allowed && tool.presents) this.append(s, 'deliverables/presented', { turn, callId, files: tool.presents });
        this.append(s, 'step/end', { turn, step });
        const next = allowed ? script : { steps: [{ text: tool.deniedText ?? '好的，这一步没有执行。需要的话可以换个方式，或者在权限里放宽后再试。' }] };
        this.runScript(s, turn, step + 1, next, allowed ? at + 1 : 0);
      });
    };
    const needsApproval = tool.risky && s.permission !== 'danger-full-access';
    if (!needsApproval) return finish(true);
    const approvalId = uuid();
    const eventId = uuid();
    const reason = tool.reason ?? 'escalate sandbox to danger-full-access';
    this.append(s, 'approval/asked', { id: approvalId, toolName: tool.name, callId, reason });
    s.waitingApproval = {
      eventId,
      resume: (allowed) => {
        s.waitingApproval = undefined;
        finish(allowed, allowed ? 'allowed-once' : 'rejected', approvalId);
      },
    };
    this.waterfall(eventId, s.id, {
      toolName: tool.name,
      callId,
      reason,
      displayReason: { en: `Allow this operation: ${reason}`, zh: tool.zhReason ?? `允许这次操作：${reason}` },
    });
  }

  private endTurn(s: MockSession, turn: number, kind: 'completed' | 'aborted') {
    if (kind === 'completed' && s.waitingQuestion) return;
    s.partial = undefined;
    this.append(s, 'turn/end', { turn, reason: kind === 'aborted' ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } });
    this.setRunning(s, false);
    this.emit('api-session/added', [this.summary(s)]);
    const queued = s.inbox['next-turn'].shift() as { text: string; requestId: string; images?: unknown[] } | undefined;
    if (queued) {
      this.append(s, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
      this.later(s, 300, () => this.startTurn(s, queued.text, queued.requestId, queued.images));
    }
  }

  private cancelTurn(s: MockSession) {
    if (!s.running) return;
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
    const p = s.partial;
    if (p) {
      const content: unknown[] = [];
      if (p.reasoning) content.push({ type: 'reasoning', text: p.reasoning });
      if (p.text) content.push({ type: 'text', text: p.text });
      const m = this.append(s, 'assistant/message', { turn: p.turn, step: p.step, message: { role: 'assistant', content, source: { kind: 'model', provider: s.model.provider, model: s.model.model }, id: uuid() }, interrupted: true });
      this.streamFrame(s, { type: 'end', attemptId: p.attemptId, revision: 9999, index: 9999, outcome: { kind: 'committed', eventType: 'assistant/message', seq: m.seq } });
    }
    if (s.waitingApproval) {
      this.cancelWaterfall(s.waitingApproval.eventId);
      s.waitingApproval = undefined;
    }
    if (s.waitingQuestion) {
      this.cancelWaterfall(s.waitingQuestion.eventId);
      s.waitingQuestion = undefined;
    }
    s.running = true; // so endTurn's setRunning(false) emits a status change
    this.endTurn(s, s.turn, 'aborted');
  }

  private startJob(s: MockSession, label: string) {
    const id = `job-${uuid().slice(0, 6)}`;
    const job = { id, label, status: 'running', startedAt: now(), sessionId: s.id };
    this.jobs.set(id, job);
    this.pushJobs(s.id);
    setTimeout(() => {
      if (job.status !== 'running') return;
      job.status = 'succeeded';
      this.pushJobs(s.id);
    }, 20_000 * (this.speed || 0.001));
    return job;
  }
  private pushJobs(sessionId: string) {
    const jobs = [...this.jobs.values()].filter((j) => j.sessionId === sessionId).map((j) => ({ id: j.id, kind: 'bash', label: j.label, status: j.status, startedAt: j.startedAt }));
    for (const w of this.jobWatchers) if (w.sessionId === sessionId) w.sock.deliver({ type: 'item', streamId: w.streamId, value: { jobs } });
  }

  // ------------------------------------------------------------------ RPC

  private need(sessionId: unknown) {
    const s = this.sessions.get(str(sessionId) ?? '');
    if (!s) throw new DshRemoteError('session/not-found', `no session ${String(sessionId)}`);
    return s;
  }

  handle(endpoint: string, args: Record<string, unknown>): unknown {
    const req = obj(args.request);
    switch (endpoint) {
      case 'session/list':
        // like DSH: every stored session, archived ones included (the page filters with workspace/follow's archived set)
        return { items: [...this.sessions.values()].map((s) => this.summary(s)) };
      case 'session/create': {
        const s = this.newSession(null, str(req.cwd) ?? WS);
        if (str(req.workspaceId)) this.host.addSession(str(req.workspaceId)!, s.id);
        this.emit('api-session/added', [this.summary(s)]);
        return { sessionId: s.id, agentPreset: 'standard' };
      }
      case 'session/rename': {
        const s = this.need(req.sessionId);
        s.title = str(req.title) ?? s.title;
        this.append(s, 'session/title', { title: s.title, messageSeqs: [], source: { kind: 'user' } });
        this.emit('api-session/added', [this.summary(s)]);
        return { title: s.title };
      }
      case 'workspace/archiveSession': {
        const s = this.need(req.sessionId);
        this.cancelTurn(s);
        s.archived = true;
        if (this.pinned.includes(s.id)) {
          this.pinned = this.pinned.filter((x) => x !== s.id);
          this.pushPins();
        }
        this.pushArchived();
        return { archivedSessionIds: this.archivedIds() };
      }
      case 'workspace/unarchiveSession': {
        const s = this.need(req.sessionId);
        s.archived = false;
        this.pushArchived();
        return { archivedSessionIds: this.archivedIds() };
      }
      case 'session/fork': {
        const src = this.need(req.sessionId);
        const at = typeof req.atSeq === 'number' ? req.atSeq : src.log.length - 1;
        const s = this.newSession(src.title, src.cwd);
        s.log = src.log.filter((e) => e.seq <= at).map((e) => ({ ...e }));
        s.turn = s.log.filter((e) => e.type === 'turn/start').length;
        this.emit('api-session/added', [this.summary(s)]);
        return { sessionId: s.id };
      }
      case 'session/search': {
        const q = (str(req.query) ?? '').toLowerCase();
        const items = [];
        for (const s of this.sessions.values()) {
          if (s.archived) continue;
          const hay = [s.title ?? '', ...s.log.flatMap((e) => list(obj(e.data.message ?? e.data).content).map((p) => str(obj(p).text) ?? ''))].join('\n');
          const i = hay.toLowerCase().indexOf(q);
          if (q && i >= 0) items.push({ sessionId: s.id, snippet: hay.slice(Math.max(0, i - 12), i + 40).replace(/\n/g, ' ') });
        }
        return { items, hasMore: false };
      }
      case 'session/prompt': {
        const s = this.need(req.sessionId);
        const text = list(req.content).map((p) => str(obj(p).text) ?? '').join('');
        const requestId = str(req.requestId) ?? uuid();
        const images = this.storeImages(req.content);
        if (s.running) {
          const target = req.mode === 'steer' ? 'next-step' : 'next-turn';
          const msg = { ...this.userMessage(text, requestId, images), text, requestId, images };
          (s.inbox[target] as unknown[]).push(msg);
          this.append(s, 'agent/inbox/spliced', { target, start: s.inbox[target].length - 1, removedCount: 0, inserted: [this.userMessage(text, requestId, images)] });
          if (target === 'next-step') {
            // Picked up at the next step boundary: echo it into the log soon.
            this.later(s, 900, () => {
              const i = s.inbox['next-step'].indexOf(msg);
              if (i < 0) return;
              s.inbox['next-step'].splice(i, 1);
              this.append(s, 'agent/inbox/spliced', { target: 'next-step', start: i, removedCount: 1, inserted: [] });
              this.append(s, 'user/message', this.userMessage(text, requestId, images));
            });
          }
          return null;
        }
        this.startTurn(s, text, requestId, images);
        return null;
      }
      case 'session/attachment': {
        this.need(req.sessionId);
        const id = str(obj(req.attachment).attachmentId) ?? str(req.attachmentId) ?? '';
        const a = this.attachments.get(id);
        if (!a) throw new DshRemoteError('session/attachment-invalid', 'No such attachment in this session.');
        return { attachment: { attachmentId: id, mediaType: a.mediaType }, data: a.data };
      }
      case 'session/cancel':
        this.cancelTurn(this.need(req.sessionId));
        return null;
      case 'session/projections': {
        const s = this.need(req.sessionId);
        return { kind: 'sequenced', asOfSeq: s.log.length - 1, values: this.projections(s) };
      }
      case 'session/page': {
        const s = this.need(obj(req.address).sessionId);
        const before = typeof req.beforeSeq === 'number' ? req.beforeSeq : s.log.length;
        const events = s.log.filter((e) => e.seq < before).slice(-200);
        return { records: events.map((event) => ({ type: 'event', event })), hasMore: (events[0]?.seq ?? 0) > 0 };
      }
      case 'session/modelCatalog': {
        // routes added under 模型提供方 join the catalog, like the real adapter registers them
        const routes = this.host.piAiRoutes();
        const own = Object.entries(routes).map(([id, v]) => ({
          id,
          name: str(obj(v).displayName) ?? id,
          models: list(obj(v).models).map((m) => ({ id: str(obj(m).id) ?? '', name: str(obj(m).name) ?? str(obj(m).id) ?? '' })),
        }));
        const d = this.host.defaultModel();
        const def = str(d.provider) && str(d.model) ? { provider: str(d.provider), model: str(d.model), ...(str(d.reasoningEffort) ? { reasoningEffort: str(d.reasoningEffort) } : {}) } : MODEL_CATALOG.default;
        return { ...MODEL_CATALOG, default: def, routableProviders: [...MODEL_CATALOG.routableProviders, ...own.map((g) => g.id)], groups: [...MODEL_CATALOG.groups, ...own] };
      }
      case 'session/selectModel': {
        const s = this.need(req.sessionId);
        s.model = { provider: str(req.provider) ?? s.model.provider, model: str(req.model) ?? s.model.model, reasoningEffort: str(req.reasoningEffort) ?? s.model.reasoningEffort };
        this.append(s, 'model/selection', { ...s.model });
        return { selected: s.model };
      }
      case 'credentials/describe':
        return Object.fromEntries(list(args.refs).map((r) => [String(r), this.credentials[String(r)] ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }]));
      case 'credentials/set':
        if (!str(args.value)?.trim()) throw new DshRemoteError('credential/invalid', 'empty value');
        this.credentials[str(args.ref) ?? ''] = str(args.value)!;
        this.emit('credentials/reference-updated', [args.ref]);
        return null;
      case 'credentials/unset':
        delete this.credentials[str(args.ref) ?? ''];
        this.emit('credentials/reference-updated', [args.ref]);
        return null;
      case 'permissionPresets/catalog':
        return {
          options: [
            { value: 'read-only', name: '只读', description: '只能查看，不能改文件' },
            { value: 'workspace-write', name: '工作区可写', description: '可以改工作区里的文件，越界操作先问你' },
            { value: 'danger-full-access', name: '完全访问', description: '不再询问，直接执行' },
          ],
          defaultPreset: 'workspace-write',
        };
      case 'commands/execute': {
        const s = this.need(args.agentId);
        const line = str(args.line) ?? '';
        const m = line.match(/^\/permission\s+(\S+)/);
        if (m) {
          s.permission = m[1];
          this.append(s, 'permission/preset', { preset: s.permission });
          return { kind: 'ok', message: `权限已切换为 ${m[1]}` };
        }
        if (/^\/compact/.test(line)) return { kind: 'ok', message: '已压缩上下文' };
        if (/^\/clear/.test(line)) return { kind: 'ok', message: '已开始新的上下文' };
        throw new DshRemoteError('command/unknown', `未知命令 ${line.split(/\s/)[0]}`);
      }
      case '$events/result': {
        const eventId = str(args.eventId) ?? '';
        const w = this.pendingWaterfalls.get(eventId);
        if (!w) throw new DshRemoteError('events/unknown-event', `no pending event ${eventId}`);
        const outcome = obj(args.outcome);
        if (outcome.kind === 'next') return null;
        this.cancelWaterfall(eventId, str(args.clientId));
        const s = this.sessions.get(w.sessionId);
        if (w.event === 'user-questions/request') {
          const answers = list(obj(outcome.value).answers).map(obj);
          const a = answers[0];
          const text = a ? [...list(a.selected).map(String), ...(str(a.custom) ? [str(a.custom)!] : [])].join('、') : '';
          s?.waitingQuestion?.eventId === eventId && s.waitingQuestion.resume(outcome.kind === 'rejected' ? null : text);
          return null;
        }
        s?.waitingApproval?.eventId === eventId && s.waitingApproval.resume(outcome.value === 'allowed-once');
        return null;
      }
      case 'skills/list':
        return {
          skills: [
            ...SKILLS,
            ...[...this.userSkills].map(([name, files]) => ({
              name,
              description: /^description:\s*(.+)$/m.exec(files['SKILL.md'] ?? '')?.[1]?.trim() ?? '',
              source: 'user',
              path: `/root/.dsh/skills/${name}/SKILL.md`,
            })),
          ],
        };
      case 'schedule/catalog':
        return [...this.schedules.values()];
      case 'schedule/create': {
        const timing = obj(req.timing);
        const kind = str(timing.kind) ?? 'every';
        const sel = obj(timing[kind === 'every' ? 'every_seconds' : kind]);
        const now = new Date().toISOString();
        const rec: Record<string, unknown> = {
          id: `sch-${uuid().slice(0, 8)}`,
          title: str(req.title) ?? '',
          prompt: str(req.prompt) ?? '',
          kind,
          ...(kind === 'every' ? { everySeconds: timing.every_seconds } : { time: str(sel.time), timeZone: str(sel.time_zone), weekdays: list(sel.weekdays) }),
          target: obj(req.target),
          status: 'active',
          updatedAt: now,
        };
        this.schedules.set(String(rec.id), rec);
        return rec;
      }
      case 'schedule/edit': {
        const id = str(req.id) ?? '';
        const rec = this.schedules.get(id);
        if (!rec) return { code: 'schedule_not_found' };
        if (str(req.expectedUpdatedAt) && req.expectedUpdatedAt !== rec.updatedAt) return { code: 'schedule_conflict' };
        if (req.action === 'delete') {
          this.schedules.delete(id);
          return { id, deleted: true };
        }
        const patch = obj(req.patch);
        const t = obj(patch.timing);
        if (t.kind) {
          const sel = obj(t[str(t.kind) === 'every' ? 'every_seconds' : String(t.kind)]);
          Object.assign(rec, { kind: t.kind, time: str(sel.time) ?? rec.time, timeZone: str(sel.time_zone) ?? rec.timeZone, weekdays: sel.weekdays ?? rec.weekdays });
        }
        if (patch.title) rec.title = patch.title;
        if (patch.prompt) rec.prompt = patch.prompt;
        rec.updatedAt = new Date(Date.now() + 1).toISOString();
        return rec;
      }
      case 'schedule/run': {
        const rec = this.schedules.get(str(req.id) ?? '');
        if (!rec) return { code: 'schedule_not_found' };
        const s = this.newSession(String(rec.title));
        this.emit('api-session/added', [this.summary(s)]);
        this.startTurn(s, String(rec.prompt), uuid());
        const runs = (this.scheduleRuns.get(String(rec.id)) ?? []);
        runs.unshift({ scheduledAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), prompt: rec.prompt, targetSessionId: s.id });
        this.scheduleRuns.set(String(rec.id), runs);
        return {};
      }
      case 'schedule/history': {
        if (!this.schedules.has(str(req.id) ?? '')) return { code: 'schedule_not_found' };
        return { records: (this.scheduleRuns.get(str(req.id) ?? '') ?? []).slice(0, Number(req.limit) || 20), retention: { days: 30, records: 100 } };
      }
      case 'workspaceFiles/list': {
        const path = str(args.path) === '.' ? '' : str(args.path) ?? '';
        const prefix = path ? path + '/' : '';
        const names = new Map<string, 'file' | 'directory'>();
        for (const f of Object.keys(FILES)) {
          if (!f.startsWith(prefix)) continue;
          const rest = f.slice(prefix.length);
          const [head, ...tail] = rest.split('/');
          names.set(head, tail.length ? 'directory' : 'file');
        }
        return { path, entries: [...names].map(([name, type]) => ({ name, type, size: type === 'file' ? FILES[prefix + name].length : undefined })), truncated: false };
      }
      case 'workspaceFiles/read': {
        const path = str(args.path) ?? '';
        const text = FILES[path];
        if (text === undefined) throw new DshRemoteError('workspace-file/not-found', `${path} 不存在`);
        return { text: text.replace(/\n$/, ''), lines: text.split('\n').length, eof: true, offset: 1 };
      }
      case 'fileReferences/list': {
        const q = (str(args.query) ?? '').toLowerCase();
        return Object.keys(FILES)
          .filter((f) => f.toLowerCase().includes(q))
          .map((path) => ({ path, kind: 'file' }));
      }
      case 'goals/get': {
        const s = this.need(args.agentId);
        return s.goal ? { id: 'g1', revision: 1, ...s.goal, activation: { kind: 'idle' } } : null;
      }
      case 'goals/create': {
        const s = this.need(args.agentId);
        if (s.goal && s.goal.phase !== 'complete') throw new DshRemoteError('GOAL_ALREADY_EXISTS', '已有一个进行中的目标');
        s.goal = { objective: str(req.objective) ?? '', phase: 'active', roundsStarted: 0, maxGoalRounds: 20 };
        this.append(s, 'goal/change', { goal: s.goal });
        return { ref: { id: 'g1', revision: 1 } };
      }
      case 'goals/pause':
      case 'goals/resume':
      case 'goals/complete':
      case 'goals/clear': {
        const s = this.need(args.agentId);
        const verb = endpoint.split('/')[1];
        if (verb === 'clear') s.goal = null;
        else if (s.goal) s.goal.phase = verb === 'pause' ? 'paused' : verb === 'resume' ? 'active' : 'complete';
        this.append(s, 'goal/change', { goal: s.goal });
        return { ref: { id: 'g1', revision: 2 } };
      }
      case 'job/kill': {
        const j = this.jobs.get(str(req.jobId) ?? '');
        if (!j) throw new DshRemoteError('job/not-found', 'no such job');
        const was = j.status === 'running';
        j.status = 'killed';
        this.pushJobs(j.sessionId);
        return { outcome: was ? 'requested' : 'already-finished' };
      }
      case 'workspace/pinSession':
      case 'workspace/unpinSession': {
        const id = str(req.sessionId) ?? '';
        this.need(id);
        this.pinned = this.pinned.filter((x) => x !== id);
        if (endpoint === 'workspace/pinSession') this.pinned.unshift(id);
        this.pushPins();
        return { pinnedSessionIds: this.pinned };
      }
      case 'messageFeedback/list':
        return { ok: true, value: { items: [...this.feedback].map(([messageId, f]) => ({ messageId, ...f })) } };
      case 'messageFeedback/put': {
        const id = str(req.messageId) ?? '';
        const f = { rating: str(req.rating) ?? 'positive', version: uuid().slice(0, 8) };
        this.feedback.set(id, f);
        return { ok: true, value: { messageId: id, ...f } };
      }
      case 'messageFeedback/delete':
        this.feedback.delete(str(req.messageId) ?? '');
        return { ok: true, value: null };
      case 'cotTranslation/limits':
        return { provider: 'deepseek-official', targetLanguage: 'zh' };
      case 'cotTranslation/translate':
        return `（译文）${str(req.text) ?? ''}`;
      default: {
        const r = this.host.handle(endpoint, args);
        if (r !== UNHANDLED) return r;
      }
        throw new DshRemoteError('gateway/unknown-endpoint', `原型里的模拟引擎还没有 ${endpoint}`);
    }
  }

  // ------------------------------------------------------------------ seed

  private seed() {
    const ago = (min: number) => now() - min * 60_000;
    // the same ids on every load, so a reload (an interface update) can come back to one
    let seeded = 0;
    const mk = (title: string, minutesAgo: number, turns: Array<[string, string, string?]>) => {
      const s = this.newSession(title, WS, `session-demo-${++seeded}`);
      for (const [u, a, r] of turns) {
        s.turn++;
        this.append(s, 'turn/start', { turn: s.turn });
        this.append(s, 'user/message', this.userMessage(u, uuid()));
        const content: unknown[] = [];
        if (r) content.push({ type: 'reasoning', text: r });
        content.push({ type: 'text', text: a });
        this.append(s, 'assistant/message', { turn: s.turn, step: 1, message: { role: 'assistant', content, source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' }, id: uuid() } });
        this.append(s, 'turn/end', { turn: s.turn, reason: { kind: 'completed' } });
      }
      this.append(s, 'session/title', { title, messageSeqs: [], source: { kind: 'fallback' } });
      s.createdAt = s.updatedAt = ago(minutesAgo);
      return s;
    };
    mk('柠檬芝士搭配', 60 * 24 * 50, [['柠檬和芝士能一起用吗？', '能。柠檬的酸能提亮芝士的奶香，常见做法是柠檬芝士蛋糕、柠檬奶油意面。注意别把大量柠檬汁直接倒进热的奶油酱里，容易结块。']]);
    mk('腌肉酒和淀粉的顺序', 60 * 24 * 40, [['腌肉的时候料酒和淀粉可以一起放吗？', '可以，但推荐顺序是：先放料酒、盐、生抽抓匀，再放淀粉，最后封一层油。这样调料先入味，淀粉再把水分锁住。']]);
    mk('周报草稿', 60 * 24 * 3, [['帮我把这周做的事整理成一段周报。', '这是原型里的示例对话。接上引擎之后，这里会是模型写好的周报。']]);
    mk('SSH 隧道是什么', 90, [
      ['SSH 隧道是什么？用两句话讲清楚。', 'SSH 隧道是借助一条已经建立的 SSH 加密连接，把原本到不了的端口流量转发过去的做法。\n\n最常见的用途，是在自己的设备上安全地访问另一台机器上只对本机开放的服务。', '用户要一个简短的解释。先说它是什么，再给一个最常见的用途，两句话就够。'],
    ]);
    mk('10 月花销表', 30, [['把这个月的花销做成表，按类别汇总。', '做好了。表格按类别汇总，都在工作区里：\n\n| 类别 | 金额 |\n|---|---|\n| 餐饮 | 129.70 |\n| 交通 | 4.00 |\n| 购物 | 199.00 |']]);
    if (typeof location !== 'undefined' && location.hash.includes('team')) this.seedTeam(mk, ago);
  }

  /** `#team`: a Lead with two teammates, a task board and team messages. */
  private seedTeam(mk: (title: string, minutesAgo: number, turns: Array<[string, string, string?]>) => MockSession, ago: (min: number) => number) {
    const lead = mk('重构登录模块', 12, [['把登录模块拆成表单、校验和接口三部分，开个团队分头做。', '好。我开了一个团队：「前端」改表单和校验，「测试」补单元测试。任务板上能看到进度。']]);
    const member = (name: string, said: string) => {
      const s = mk(name, 10, [['（团队成员）', '收到，开始做。']]);
      s.parentId = lead.id;
      this.append(s, 'user/message', {
        role: 'user',
        id: uuid(),
        content: [{ type: 'text', text: `Team message from 负责人:` }, { type: 'text', text: said }],
        source: { kind: 'team-message', senderName: '负责人', senderSessionId: lead.id },
      });
      s.log[s.log.length - 1].time = ago(8);
      return s;
    };
    const fe = member('前端', '先把登录表单的校验从提交时改成失焦时，错误提示放在输入框下面。');
    const qa = member('测试', '表单改完后补校验的单元测试，覆盖空值、格式错误和超长输入。');
    lead.team = {
      members: [
        { id: lead.id, name: '负责人', role: 'lead', phase: 'active' },
        { id: fe.id, name: '前端', role: 'member', phase: 'active' },
        { id: qa.id, name: '测试', role: 'member', phase: 'failed', error: '模型额度用完了' },
      ],
      tasks: [
        { id: 't1', subject: '表单校验改成失焦触发', status: 'in_progress', ownerName: '前端', description: '提交前不再一次性报错；错误提示放在输入框下方。', writeScopes: ['src/login/form.tsx'] },
        { id: 't2', subject: '补校验单元测试', status: 'pending', ownerName: '测试', blockedBy: ['t1'] },
        { id: 't3', subject: '拆出登录接口', status: 'completed', ownerName: '负责人', writeScopes: ['src/login/api.ts'] },
      ],
    };
  }
}

class FakeSocket implements MuxSocket {
  onopen: (() => void) | null = null;
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  private open = true;
  constructor(private readonly engine: MockEngine) {}
  send(text: string) {
    if (!this.open) return;
    const frame = obj(JSON.parse(text));
    queueMicrotask(() => this.engine.onClientFrame(this, frame));
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.engine.dropSocket(this);
  }
  serverClose() {
    if (!this.open) return;
    this.open = false;
    this.engine.dropSocket(this);
    setTimeout(() => this.onclose?.(1006, 'mock blip'), 0);
  }
  deliver(frame: Record<string, unknown>) {
    if (!this.open) return;
    const text = JSON.stringify(frame);
    queueMicrotask(() => this.open && this.onmessage?.(text));
  }
}

function split(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = 2 + Math.floor(Math.random() * 4);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

const MODEL_CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  routableProviders: ['deepseek-official'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-pro', name: 'V4 Pro', description: '能力最强，适合复杂任务', reasoning: { efforts: EFFORTS(), defaultEffort: 'high' } },
        { id: 'deepseek-flash', name: 'V4 Flash', description: '更快更省，适合日常问答', reasoning: { efforts: EFFORTS(), defaultEffort: 'high' } },
      ],
    },
  ],
  failures: [],
};
function EFFORTS() {
  return [
    { id: 'off', name: '关', description: '简单任务，不用思考' },
    { id: 'low', name: '低', description: '日常任务，回得更快' },
    { id: 'high', name: '高', description: '大多数任务的默认' },
    { id: 'max', name: '最高', description: '最难的任务' },
  ];
}
const SKILLS = [
  { name: 'pdf', description: '读取、合并、拆分 PDF', source: 'bundled' },
  { name: 'xlsx', description: '生成和整理表格', source: 'bundled' },
  {
    name: 'docx',
    description:
      '创建、读取和修改 Word 文档（.docx）：从零写报告和信件，按模板填内容，修改已有文档时保留原来的格式，处理修订和批注，插入表格、图片、页眉页脚和目录。用户提到 Word、.docx、合同、报告排版，或者要一份可以打印、发给别人改的文档时使用；只要 PDF 或纯文本时不要用。',
    source: 'bundled',
    path: '/root/.dsh/engine/skills/docx/SKILL.md',
  },
  { name: 'weekly-report', description: '把一周的提交整理成周报', source: 'project' },
];
