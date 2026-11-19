// Folds follow events into renderable chat items. A TypeScript port of
// dsh-Go's packages/dsh_client/lib/src/transcript.dart (AGPL-3.0):
//  - durable events merge by seq, so resync snapshots and older pages are idempotent;
//  - live assistant-stream frames become a draft that the durable
//    `assistant/message` replaces when it lands (same row key m<turn>.<step>);
//  - approvals from $events attach to the tool row of their callId.

import {
  type ApprovalRequest,
  type FollowEvent,
  type LogEvent,
  type Message,
  type Part,
  type StreamChunk,
  type TodoItem,
  type Usage,
  parseMessage,
  parseTodos,
  reasoningOf,
  textOf,
} from './events';
import { list, obj, str } from './json';

export type ToolStatus = 'streaming' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'denied' | 'cancelled';

export type ChatItem =
  | { kind: 'user'; key: string; seq: number; time: number; text: string; parts: Part[]; requestId?: string; sourceKind: string }
  | {
      kind: 'assistant';
      key: string;
      id: string;
      seq?: number;
      time?: number;
      text: string;
      reasoning: string;
      streaming: boolean;
      interrupted: boolean;
      usage?: Usage;
      model?: string;
      /** `deepseek-import` for replies brought in from an export (no timing, no feedback). */
      provider?: string;
      /** DSH `message.id` of the durable reply (feedback target). */
      messageId?: string;
      turn?: number;
    }
  | {
      kind: 'tool';
      key: string;
      callId: string;
      name: string;
      arguments: string;
      status: ToolStatus;
      seq?: number;
      resultText: string;
      approval?: ApprovalRequest;
      approvalOutcome?: string;
    }
  | { kind: 'notice'; key: string; seq: number; tone: 'error' | 'aborted' | 'retry' | 'info'; text: string };

export interface QueuedPrompt {
  text: string;
  steering: boolean;
}

class Draft {
  blocks = new Map<number, { type: string; text: string; toolId?: string; toolName?: string; finished?: Part }>();
  nextIndex = 0;
  streaming = true;
  constructor(
    readonly attemptId: string,
    readonly turn: number,
    readonly step: number,
    readonly startedAfterSeq: number,
  ) {}
  get rowKey() {
    return `m${this.turn}.${this.step}`;
  }
  apply(c: StreamChunk) {
    const get = (i: number, t: string) => {
      let b = this.blocks.get(i);
      if (!b) this.blocks.set(i, (b = { type: t, text: '' }));
      return b;
    };
    switch (c.type) {
      case 'block-start':
        this.blocks.set(c.index, { type: c.blockType, text: '' });
        break;
      case 'text-delta':
        get(c.index, 'text').text += c.text;
        break;
      case 'reasoning-delta':
        get(c.index, 'reasoning').text += c.text;
        break;
      case 'tool-call-delta': {
        const b = get(c.index, 'tool-call');
        b.toolId = c.id || b.toolId;
        b.toolName = c.name ?? b.toolName;
        b.text += c.argumentsDelta;
        break;
      }
      case 'block-end':
        get(c.index, 'unknown').finished = c.block;
        break;
      case 'finish':
        this.streaming = false;
        break;
    }
  }
  items(useRowKey: boolean): ChatItem[] {
    let text = '';
    let reasoning = '';
    const tools: ChatItem[] = [];
    for (const [, b] of [...this.blocks.entries()].sort((a, z) => a[0] - z[0])) {
      const f = b.finished;
      if (f?.type === 'text') text += f.text;
      else if (f?.type === 'reasoning') reasoning += f.text;
      else if (f?.type === 'tool-call')
        tools.push({ kind: 'tool', key: `t${f.id}`, callId: f.id, name: f.name, arguments: f.arguments, status: 'running', resultText: '' });
      else if (b.type === 'text') text += b.text;
      else if (b.type === 'reasoning') reasoning += b.text;
      else if (b.type === 'tool-call') {
        const callId = b.toolId || `${this.attemptId}#${tools.length}`;
        tools.push({ kind: 'tool', key: `t${callId}`, callId, name: b.toolName ?? '', arguments: b.text, status: 'streaming', resultText: '' });
      }
    }
    const out: ChatItem[] = [];
    if (text || reasoning)
      out.push({
        kind: 'assistant',
        key: useRowKey ? this.rowKey : `d${this.attemptId}`,
        id: `d${this.attemptId}`,
        text,
        reasoning,
        streaming: this.streaming,
        interrupted: false,
      });
    return [...out, ...tools];
  }
}

const TURN_NOTICE: Record<string, (r: { message?: string }) => { tone: 'error' | 'aborted' | 'info'; text: string } | null> = {
  completed: () => null,
  aborted: () => ({ tone: 'aborted', text: '已停止' }),
  error: (r) => ({ tone: 'error', text: r.message ?? '这一轮出错了' }),
  'max-tokens': () => ({ tone: 'info', text: '已达到输出长度上限' }),
  blocked: () => ({ tone: 'error', text: '这一轮被拦下了' }),
  interrupted: () => ({ tone: 'info', text: '已中断（引擎重启过）' }),
};

export class Transcript {
  private log = new Map<number, LogEvent>();
  private drafts = new Map<string, Draft>();
  private approvals = new Map<string, ApprovalRequest>();
  private inboxLists: Record<string, Message[]> = { 'next-turn': [], 'next-step': [] };
  private cache: ChatItem[] | null = null;
  private runningOverride: boolean | null = null;
  header: Record<string, unknown> = {};
  projections: Record<string, unknown> = {};
  cursor = -1;
  hasMoreHistory = false;
  /** Bumped on every visible change; cheap change detection for the UI. */
  version = 0;

  constructor(readonly showSynthetic = false) {}

  get title(): string | undefined {
    let t: string | undefined;
    for (const e of this.sorted()) if (e.kind === 'title') t = e.title;
    return t ?? str(this.projections.title);
  }
  /** Set for a chat written by dsh-go-bridge's session import (its first record). */
  get importedFrom(): { source: string; time: number } | undefined {
    const e = this.log.get(0);
    if (e?.type !== 'plugin:dsh-go/import') return undefined;
    return { source: str(e.data.source) ?? 'other', time: e.time };
  }
  get oldestSeq() {
    const keys = [...this.log.keys()];
    return keys.length ? Math.min(...keys) : undefined;
  }
  get running(): boolean {
    if (this.runningOverride !== null) return this.runningOverride;
    let start = -1;
    let end = -1;
    for (const e of this.log.values()) {
      if (e.kind === 'turn-start') start = Math.max(start, e.seq);
      if (e.kind === 'turn-end') end = Math.max(end, e.seq);
    }
    return start >= 0 && end < start;
  }
  get pendingApprovals() {
    return [...this.approvals.values()];
  }
  get inbox(): QueuedPrompt[] {
    return [
      ...(this.inboxLists['next-step'] ?? []).map((m) => ({ text: textOf(m.parts), steering: true })),
      ...(this.inboxLists['next-turn'] ?? []).map((m) => ({ text: textOf(m.parts), steering: false })),
    ];
  }
  /** Latest todo/write since the last turn start, else the projection. */
  get todos(): TodoItem[] | null {
    let todos: TodoItem[] | null = null;
    let seen = false;
    for (const e of this.sorted()) {
      if (e.kind === 'turn-start') todos = null;
      if (e.kind === 'todo') {
        todos = e.todos;
        seen = true;
      }
    }
    if (seen || this.log.size) return todos;
    const p = this.projections.todos;
    return Array.isArray(p) ? parseTodos(p) : null;
  }
  get permissionPreset(): string | undefined {
    return str(obj(this.projections.permissions).currentValue);
  }
  get events() {
    return this.sorted();
  }

  private sorted() {
    return [...this.log.values()].sort((a, b) => a.seq - b.seq);
  }
  private changed() {
    this.cache = null;
    this.version++;
  }

  apply(ev: FollowEvent): boolean {
    switch (ev.kind) {
      case 'snapshot': {
        if (!ev.isResync) this.log.clear();
        this.header = ev.header;
        this.projections = ev.projections;
        const inbox = obj(ev.projections.inbox);
        this.inboxLists = { 'next-turn': list(inbox['next-turn']).map(parseMessage), 'next-step': list(inbox['next-step']).map(parseMessage) };
        this.cursor = ev.cursor;
        if (!ev.isResync) this.hasMoreHistory = ev.hasMore;
        this.drafts.clear();
        this.runningOverride = null;
        for (const e of ev.events) this.log.set(e.seq, e);
        const a = ev.activeAttempt;
        if (a && !this.committed(a.turn, a.step, a.startedAfterSeq)) {
          const d = new Draft(a.attemptId, a.turn, a.step, a.startedAfterSeq);
          for (const c of a.chunks) d.apply(c);
          d.nextIndex = a.nextIndex;
          this.drafts.set(a.attemptId, d);
        }
        this.changed();
        return true;
      }
      case 'log': {
        const e = ev.event;
        const fresh = e.seq > this.cursor;
        this.log.set(e.seq, e);
        if (fresh) this.cursor = e.seq;
        if (e.kind === 'inbox' && fresh) this.splice(e.target, e.start, e.removedCount, e.inserted);
        if (e.kind === 'turn-start') this.runningOverride = true;
        if (e.kind === 'turn-end') this.runningOverride = false;
        if (e.kind === 'assistant' || e.kind === 'attempt') {
          for (const [id, d] of this.drafts) if (d.turn === e.turn && d.step === e.step && d.startedAfterSeq < e.seq) this.drafts.delete(id);
        }
        this.changed();
        return true;
      }
      case 'stream-start':
        this.drafts.set(ev.attemptId, new Draft(ev.attemptId, ev.turn, ev.step, ev.startedAfterSeq));
        this.changed();
        return true;
      case 'stream-chunk': {
        const d = this.drafts.get(ev.attemptId);
        if (!d || ev.index < d.nextIndex) return false;
        d.apply(ev.chunk);
        d.nextIndex = ev.index + 1;
        this.changed();
        return true;
      }
      case 'stream-end': {
        const d = this.drafts.get(ev.attemptId);
        if (!d) return false;
        if (!ev.committed || (ev.committedSeq !== undefined && this.log.has(ev.committedSeq))) this.drafts.delete(ev.attemptId);
        else d.streaming = false;
        this.changed();
        return true;
      }
      default:
        return false;
    }
  }

  private committed(turn: number, step: number, after: number) {
    for (const e of this.log.values()) if ((e.kind === 'assistant' || e.kind === 'attempt') && e.turn === turn && e.step === step && e.seq > after) return true;
    return false;
  }

  private splice(target: string, start: number, removed: number, inserted: Message[]) {
    const l = [...(this.inboxLists[target] ?? [])];
    const s = Math.max(0, Math.min(start, l.length));
    l.splice(s, Math.max(0, Math.min(removed, l.length - s)), ...inserted);
    this.inboxLists = { ...this.inboxLists, [target]: l };
  }

  addApproval(r: ApprovalRequest) {
    this.approvals.set(r.eventId, r);
    this.changed();
  }
  removeRequest(eventId: string) {
    if (this.approvals.delete(eventId)) this.changed();
  }
  clearApprovals() {
    if (this.approvals.size) {
      this.approvals.clear();
      this.changed();
    }
  }
  setRunning(running: boolean) {
    this.runningOverride = running;
    this.changed();
  }
  prependHistory(events: LogEvent[], hasMore: boolean) {
    for (const e of events) this.log.set(e.seq, e);
    this.hasMoreHistory = hasMore;
    this.changed();
  }

  get items(): ChatItem[] {
    if (this.cache) return this.cache;
    const durable = this.build();
    const used = new Set(durable.map((i) => i.key));
    const latest = new Map<string, Draft>();
    for (const d of this.drafts.values()) latest.set(d.rowKey, d);
    const drafts = [...this.drafts.values()].flatMap((d) => d.items(!used.has(d.rowKey) && latest.get(d.rowKey) === d));
    // A draft tool row whose durable row already exists is dropped.
    const out = [...durable];
    for (const it of drafts) if (!used.has(it.key)) out.push(it);
    return (this.cache = out);
  }

  private build(): ChatItem[] {
    type ToolB = {
      callId: string;
      name: string;
      args: string;
      seq: number;
      result?: Extract<LogEvent, { kind: 'tool-result' }>;
      asked: boolean;
      turnEnded: boolean;
      outcome?: string;
    };
    const items: Array<ChatItem | ToolB> = [];
    const tools = new Map<string, ToolB>();
    const approvalCalls = new Map<string, string>();
    const rowKeys = new Set<string>();
    const unresolved = new Set<ToolB>();
    const tool = (callId: string, name: string, args: string, seq: number) => {
      let b = tools.get(callId);
      if (!b) {
        b = { callId, name, args, seq, asked: false, turnEnded: false };
        tools.set(callId, b);
        items.push(b);
        unresolved.add(b);
      }
      return b;
    };
    for (const e of this.sorted()) {
      switch (e.kind) {
        case 'user':
          if (!e.human && !this.showSynthetic) break;
          items.push({ kind: 'user', key: `u${e.seq}`, seq: e.seq, time: e.time, text: textOf(e.message.parts), parts: e.message.parts, requestId: e.message.requestId, sourceKind: e.message.sourceKind });
          break;
        case 'assistant': {
          const text = textOf(e.message.parts);
          const reasoning = reasoningOf(e.message.parts);
          if (text.trim() || reasoning.trim() || e.interrupted) {
            const rk = `m${e.turn}.${e.step}`;
            const fresh = !rowKeys.has(rk);
            rowKeys.add(rk);
            items.push({ kind: 'assistant', key: fresh ? rk : `a${e.seq}`, id: `a${e.seq}`, seq: e.seq, time: e.time, text, reasoning, streaming: false, interrupted: e.interrupted, usage: e.usage, model: e.message.model, provider: e.message.provider, messageId: e.message.id, turn: e.turn });
          }
          for (const p of e.message.parts) if (p.type === 'tool-call') tool(p.id, p.name, p.arguments, e.seq);
          break;
        }
        case 'tool-call':
          tool(e.callId, e.name, e.arguments, e.seq);
          break;
        case 'tool-result': {
          const b = tool(e.callId, 'tool', '', e.seq);
          unresolved.delete(b);
          b.result = e;
          break;
        }
        case 'approval-asked':
          if (e.callId) {
            approvalCalls.set(e.approvalId, e.callId);
            const b = tools.get(e.callId);
            if (b) b.asked = true;
          }
          break;
        case 'approval-decided': {
          const c = approvalCalls.get(e.approvalId);
          const b = c ? tools.get(c) : undefined;
          if (b) b.outcome = e.outcome;
          break;
        }
        case 'turn-end': {
          for (const b of unresolved) b.turnEnded = true;
          unresolved.clear();
          const n = (TURN_NOTICE[e.reason.kind] ?? (() => null))(e.reason);
          if (n) items.push({ kind: 'notice', key: `n${e.seq}`, seq: e.seq, ...n });
          break;
        }
        case 'retry':
          items.push({ kind: 'notice', key: `n${e.seq}`, seq: e.seq, tone: 'retry', text: `正在重试模型请求（${e.retry}${e.maxRetries ? '/' + e.maxRetries : ''}）${e.failure ? '：' + e.failure : ''}` });
          break;
      }
    }
    const pendingByCall = new Map<string, ApprovalRequest>();
    for (const r of this.approvals.values()) if (r.callId) pendingByCall.set(r.callId, r);
    return items.map((it): ChatItem => {
      if ('kind' in it) return it;
      const pending = pendingByCall.get(it.callId);
      let status: ToolStatus;
      if (it.result) {
        const denied = it.outcome !== undefined && it.outcome !== 'allowed-once';
        status = denied ? 'denied' : it.result.isError ? 'failed' : 'succeeded';
      } else if (pending || (it.asked && it.outcome === undefined && !it.turnEnded)) status = 'awaiting-approval';
      else if (it.outcome !== undefined && it.outcome !== 'allowed-once') status = 'denied';
      else if (it.turnEnded) status = 'cancelled';
      else status = 'running';
      return {
        kind: 'tool',
        key: `t${it.callId}`,
        callId: it.callId,
        name: it.name,
        arguments: it.args,
        status,
        seq: it.seq,
        resultText: it.result ? textOf(it.result.message.parts) : '',
        approval: pending,
        approvalOutcome: it.outcome,
      };
    });
  }
}

/** Event types that are part of delivering a prompt (not a fork point). */
const DELIVERS_PROMPT = new Set(['agent/inbox/spliced', 'turn/start', 'step/start', 'system/message']);

/**
 * Where "edit this prompt and resend" cuts: the last event before the prompt at
 * [promptSeq] that is not part of how it got delivered — usually the previous
 * `turn/end`. Null when the loaded window has a gap. Port of dsh-Go
 * `forkPointBeforePrompt` (messages_api.dart).
 */
export function forkPointBeforePrompt(events: LogEvent[], promptSeq: number): number | null {
  const before = events.filter((e) => e.seq < promptSeq).sort((a, b) => a.seq - b.seq);
  let expected = promptSeq - 1;
  for (let i = before.length - 1; i >= 0; i--) {
    const e = before[i];
    if (e.seq !== expected) return null;
    expected--;
    if (!DELIVERS_PROMPT.has(e.type)) return e.seq;
  }
  return null;
}
