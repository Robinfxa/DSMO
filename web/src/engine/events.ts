// Parsing of `session/follow` items and `$events` items into typed events.
// Unknown types survive as `raw` so newer engines don't break older pages.

import { bool, int, list, obj, objOrNull, str, strList, type Obj } from './json';

// ---------- message parts ----------

export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** In the log, `attachment` is a durable reference: bytes come from `session/attachment`. */
  | { type: 'image'; mimeType?: string; data?: string; receiptId?: string; name?: string; attachment?: Obj; width?: number; height?: number }
  | { type: 'file'; name?: string; path?: string; receiptId?: string; mimeType?: string; size?: number }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'unknown'; raw: Obj };

export function parsePart(v: unknown): Part {
  const m = obj(v);
  switch (m.type) {
    case 'text':
      return { type: 'text', text: str(m.text) ?? '' };
    case 'reasoning':
      return { type: 'reasoning', text: str(m.text) ?? '' };
    case 'image': {
      const a = objOrNull(m.attachment);
      return {
        type: 'image',
        mimeType: str(m.mediaType) ?? str(m.mimeType) ?? str(a?.mediaType),
        data: str(m.data),
        receiptId: str(m.receiptId),
        name: str(m.name) ?? str(a?.name),
        ...(a && str(a.attachmentId) ? { attachment: a, width: int(a.width), height: int(a.height) } : {}),
      };
    }
    case 'file': {
      const a = objOrNull(m.attachment) ?? {};
      return {
        type: 'file',
        name: str(m.name) ?? str(m.fileName) ?? str(a.name) ?? str(a.fileName),
        path: str(m.path) ?? str(a.path),
        receiptId: str(m.receiptId),
        mimeType: str(m.mimeType) ?? str(a.mediaType) ?? str(a.mimeType),
        size: int(m.size) ?? int(a.bytes) ?? int(a.size),
      };
    }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: str(m.id) ?? str(m.callId) ?? '',
        name: str(m.name) ?? '',
        arguments: typeof m.arguments === 'string' ? m.arguments : JSON.stringify(m.arguments ?? {}),
      };
    default:
      return { type: 'unknown', raw: m };
  }
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}
const parseUsage = (v: unknown): Usage | undefined => {
  const m = objOrNull(v);
  if (!m) return undefined;
  return { inputTokens: int(m.inputTokens), outputTokens: int(m.outputTokens), cacheReadTokens: int(m.cacheReadTokens), totalTokens: int(m.totalTokens) };
};

export interface Message {
  id?: string;
  role: string;
  parts: Part[];
  sourceKind: string;
  /** `rpcId` echoed from session/prompt's requestId. */
  requestId?: string;
  model?: string;
  provider?: string;
  isError?: boolean;
  toolCallId?: string;
}
export function parseMessage(v: unknown): Message {
  const m = obj(v);
  const src = obj(m.source);
  return {
    id: str(m.id),
    role: str(m.role) ?? 'user',
    parts: list(m.content).map(parsePart),
    sourceKind: str(src.kind) ?? 'unknown',
    requestId: str(src.rpcId),
    model: str(src.model),
    provider: str(src.provider),
    isError: bool(m.isError),
    toolCallId: str(m.toolCallId) ?? str(src.callId),
  };
}
export const textOf = (parts: Part[]) => parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
export const reasoningOf = (parts: Part[]) => parts.map((p) => (p.type === 'reasoning' ? p.text : '')).join('');

// ---------- durable session-log events ----------

export interface LogEventBase {
  seq: number;
  time: number;
  type: string;
  data: Obj;
}
export type LogEvent =
  | (LogEventBase & { kind: 'user'; message: Message; human: boolean })
  | (LogEventBase & { kind: 'assistant'; turn: number; step: number; message: Message; usage?: Usage; interrupted: boolean })
  | (LogEventBase & { kind: 'attempt'; turn: number; step: number })
  | (LogEventBase & { kind: 'tool-call'; turn: number; step: number; callId: string; name: string; arguments: string })
  | (LogEventBase & { kind: 'tool-result'; callId: string; message: Message; isError: boolean; meta?: unknown })
  | (LogEventBase & { kind: 'approval-asked'; approvalId: string; callId?: string; toolName: string; reason?: string })
  | (LogEventBase & { kind: 'approval-decided'; approvalId: string; outcome: string })
  | (LogEventBase & { kind: 'turn-start'; turn: number })
  | (LogEventBase & { kind: 'turn-end'; turn: number; reason: TurnEndReason })
  | (LogEventBase & { kind: 'title'; title: string })
  | (LogEventBase & { kind: 'inbox'; target: string; start: number; removedCount: number; inserted: Message[] })
  | (LogEventBase & { kind: 'retry'; retry: number; maxRetries?: number; failure?: string })
  | (LogEventBase & { kind: 'todo'; todos: TodoItem[] })
  | (LogEventBase & { kind: 'model'; provider?: string; model?: string; effort?: string })
  | (LogEventBase & { kind: 'other' });

export interface TurnEndReason {
  kind: string;
  message?: string;
  byUser?: boolean;
}
export interface TodoItem {
  content: string;
  status: string;
  activeForm?: string;
}

export function parseLogEvent(v: unknown): LogEvent {
  const m = obj(v);
  const data = obj(m.data);
  const base: LogEventBase = { seq: int(m.seq) ?? -1, time: int(m.time) ?? 0, type: str(m.type) ?? '', data };
  const turn = int(data.turn) ?? 0;
  const step = int(data.step) ?? 0;
  switch (base.type) {
    case 'user/message': {
      const message = parseMessage(data);
      return { ...base, kind: 'user', message, human: message.sourceKind === 'user' };
    }
    case 'assistant/message': {
      const message = parseMessage(data.message);
      return { ...base, kind: 'assistant', turn, step, message, usage: parseUsage(data.usage), interrupted: data.interrupted === true };
    }
    case 'assistant/attempt':
      return { ...base, kind: 'attempt', turn, step };
    case 'tool/call':
      return {
        ...base,
        kind: 'tool-call',
        turn,
        step,
        callId: str(data.callId) ?? '',
        name: str(data.name) ?? 'tool',
        arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
      };
    case 'tool/result': {
      const message = parseMessage(data.message);
      return { ...base, kind: 'tool-result', callId: message.toolCallId ?? str(data.callId) ?? '', message, isError: message.isError === true, meta: data.meta };
    }
    case 'approval/asked':
      return { ...base, kind: 'approval-asked', approvalId: str(data.id) ?? '', callId: str(data.callId), toolName: str(data.toolName) ?? 'tool', reason: str(data.reason) };
    case 'approval/decided':
      return { ...base, kind: 'approval-decided', approvalId: str(data.id) ?? '', outcome: str(data.outcome) ?? 'unknown' };
    case 'turn/start':
      return { ...base, kind: 'turn-start', turn };
    case 'turn/end': {
      const r = obj(data.reason);
      const inner = obj(r.reason);
      const err = obj(r.error);
      return { ...base, kind: 'turn-end', turn, reason: { kind: str(r.kind) ?? 'completed', message: str(err.message), byUser: inner.kind === 'user' } };
    }
    case 'session/title':
      return { ...base, kind: 'title', title: str(data.title) ?? '' };
    case 'agent/inbox/spliced':
      return {
        ...base,
        kind: 'inbox',
        target: str(data.target) ?? 'next-turn',
        start: int(data.start) ?? 0,
        removedCount: int(data.removedCount) ?? 0,
        inserted: list(data.inserted).map(parseMessage),
      };
    case 'llm/retry':
      return { ...base, kind: 'retry', retry: int(data.retry) ?? int(data.attempt) ?? 1, maxRetries: int(data.maxRetries), failure: str(obj(data.failure).message) };
    case 'todo/write':
      return { ...base, kind: 'todo', todos: parseTodos(data.todos) };
    case 'model/selection': {
      const sel = obj(data.selection ?? data);
      return { ...base, kind: 'model', provider: str(sel.provider), model: str(sel.model), effort: str(sel.reasoningEffort) };
    }
    default:
      return { ...base, kind: 'other' };
  }
}

export const parseTodos = (v: unknown): TodoItem[] =>
  list(v).map((t) => {
    const m = obj(t);
    return { content: str(m.content) ?? '', status: str(m.status) ?? 'pending', activeForm: str(m.activeForm) };
  });

// ---------- assistant stream ----------

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: Part }
  | { type: 'usage'; usage?: Usage }
  | { type: 'finish' }
  | { type: 'other' };

export function parseChunk(v: unknown): StreamChunk {
  const m = obj(v);
  const index = int(m.index) ?? 0;
  switch (m.type) {
    case 'block-start':
      return { type: 'block-start', index, blockType: str(m.blockType) ?? 'text' };
    case 'text-delta':
      return { type: 'text-delta', index, text: str(m.text) ?? str(m.delta) ?? '' };
    case 'reasoning-delta':
      return { type: 'reasoning-delta', index, text: str(m.text) ?? str(m.delta) ?? '' };
    case 'tool-call-delta':
      return { type: 'tool-call-delta', index, id: str(m.id), name: str(m.name), argumentsDelta: str(m.argumentsDelta) ?? str(m.delta) ?? '' };
    case 'block-end':
      return { type: 'block-end', index, block: parsePart(m.block) };
    case 'usage':
      return { type: 'usage', usage: parseUsage(m.usage) };
    case 'finish':
      return { type: 'finish' };
    default:
      return { type: 'other' };
  }
}

/** Expands the compact stream records of an active attempt (or an
 * `assistant/message.stream`) into the exact chunk sequence. */
export function expandCompactStream(records: unknown): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (const r of list(records)) {
    const m = obj(r);
    if (m.type === 'chunk') {
      out.push(parseChunk(m.chunk));
      continue;
    }
    if (m.type !== 'text-chunks' && m.type !== 'reasoning-chunks' && m.type !== 'tool-call-chunks') continue;
    const index = int(m.index) ?? 0;
    for (const t of strList(m.type === 'tool-call-chunks' ? m.args : m.texts)) {
      if (m.type === 'text-chunks') out.push({ type: 'text-delta', index, text: t });
      else if (m.type === 'reasoning-chunks') out.push({ type: 'reasoning-delta', index, text: t });
      else out.push({ type: 'tool-call-delta', index, id: str(m.id), name: str(m.name), argumentsDelta: t });
    }
  }
  return out;
}

export interface ActiveAttempt {
  attemptId: string;
  startedAfterSeq: number;
  turn: number;
  step: number;
  nextIndex: number;
  chunks: StreamChunk[];
}

// ---------- follow frames ----------

export interface Snapshot {
  kind: 'snapshot';
  header: Obj;
  cursor: number;
  events: LogEvent[];
  hasMore: boolean;
  projections: Obj;
  activeAttempt?: ActiveAttempt;
  isResync: boolean;
}

export type FollowEvent =
  | Snapshot
  | { kind: 'log'; event: LogEvent }
  | { kind: 'stream-start'; attemptId: string; turn: number; step: number; startedAfterSeq: number }
  | { kind: 'stream-chunk'; attemptId: string; index: number; chunk: StreamChunk }
  | { kind: 'stream-end'; attemptId: string; committed: boolean; committedSeq?: number }
  | { kind: 'unknown'; raw: unknown };

export function parseFollowFrame(v: unknown, isResync = false): FollowEvent {
  const m = obj(v);
  switch (m.type) {
    case 'snapshot': {
      const stream = obj(m.assistantStream);
      const a = objOrNull(stream.activeAttempt);
      return {
        kind: 'snapshot',
        header: obj(m.header),
        cursor: int(m.cursor) ?? -1,
        events: list(m.records).map((r) => parseLogEvent(obj(r).event)),
        hasMore: m.hasMore === true,
        projections: obj(obj(m.projections).values ?? m.projections),
        isResync,
        activeAttempt: a
          ? {
              attemptId: str(a.attemptId) ?? '',
              startedAfterSeq: int(a.startedAfterSeq) ?? -1,
              turn: int(a.turn) ?? 0,
              step: int(a.step) ?? 0,
              nextIndex: int(a.nextIndex) ?? 0,
              chunks: expandCompactStream(a.stream ?? a.chunks),
            }
          : undefined,
      };
    }
    case 'event':
      return { kind: 'log', event: parseLogEvent(m.event) };
    case 'assistant-stream': {
      const f = obj(m.frame);
      const attemptId = str(f.attemptId) ?? '';
      if (f.type === 'start') return { kind: 'stream-start', attemptId, turn: int(f.turn) ?? 0, step: int(f.step) ?? 0, startedAfterSeq: int(f.startedAfterSeq) ?? -1 };
      if (f.type === 'chunk') return { kind: 'stream-chunk', attemptId, index: int(f.index) ?? 0, chunk: parseChunk(f.chunk) };
      if (f.type === 'end') {
        const o = obj(f.outcome);
        return { kind: 'stream-end', attemptId, committed: o.kind === 'committed', committedSeq: int(o.seq) };
      }
      return { kind: 'unknown', raw: v };
    }
    default:
      return { kind: 'unknown', raw: v };
  }
}

// ---------- host events ($events) ----------

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  agentAvailable: boolean;
  cwd?: string;
  parentSessionId?: string;
  origin?: string;
  title?: string;
  projections: Obj;
}
export function parseSessionSummary(v: unknown): SessionSummary {
  const m = obj(v);
  const p = obj(obj(m.projections).values);
  return {
    sessionId: str(m.sessionId) ?? '',
    updatedAt: int(m.updatedAt) ?? 0,
    running: m.running === true,
    blank: m.blank === true,
    agentAvailable: m.agentAvailable === true,
    cwd: str(m.cwd),
    parentSessionId: str(m.parentSessionId),
    origin: str(m.origin),
    title: str(p.title) ?? str(m.title),
    projections: p,
  };
}

export interface ApprovalRequest {
  eventId: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  displayReason: Record<string, string>;
  raw: Obj;
}
export const describeApproval = (r: ApprovalRequest, locale = 'zh') =>
  r.displayReason[locale] ?? r.displayReason.en ?? r.reason ?? `允许 ${r.toolName}？`;

export interface QuestionRequest {
  eventId: string;
  sessionId: string;
  questions: { id: string; question: string; detail?: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }[];
  raw: Obj;
}

export type HostEvent =
  | { kind: 'ready'; clientId: string; home: string }
  | { kind: 'session-added'; session: SessionSummary }
  | { kind: 'session-removed'; sessionId: string }
  | { kind: 'session-status'; sessionId: string; running: boolean }
  | { kind: 'session-activity'; sessionId: string; at: number }
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'cancel'; eventId: string }
  | { kind: 'emit'; event: string; args: unknown[] }
  | { kind: 'unknown'; raw: unknown };

export function parseHostEvent(v: unknown): HostEvent {
  const m = obj(v);
  switch (m.type) {
    case 'ready':
      return { kind: 'ready', clientId: str(m.clientId) ?? '', home: str(obj(m.host).home) ?? '' };
    case 'emit': {
      const event = str(m.event) ?? '';
      const args = list(m.args);
      switch (event) {
        case 'api-session/added':
          return { kind: 'session-added', session: parseSessionSummary(args[0]) };
        case 'api-session/removed':
          return { kind: 'session-removed', sessionId: str(args[0]) ?? '' };
        case 'api-session/status':
          return { kind: 'session-status', sessionId: str(args[0]) ?? '', running: args[1] === true };
        case 'api-session/activity':
          return { kind: 'session-activity', sessionId: str(args[0]) ?? '', at: int(args[1]) ?? 0 };
        default:
          return { kind: 'emit', event, args };
      }
    }
    case 'waterfall': {
      const event = str(m.event);
      const eventId = str(m.eventId) ?? '';
      const sessionId = str(m.agentId) ?? '';
      const req = obj(m.request);
      if (event === 'approval/request') {
        const disp = obj(req.displayReason);
        return {
          kind: 'approval',
          request: {
            eventId,
            sessionId,
            toolName: str(req.toolName) ?? 'tool',
            callId: str(req.callId),
            reason: str(req.reason),
            displayReason: Object.fromEntries(Object.entries(disp).filter(([, x]) => typeof x === 'string')) as Record<string, string>,
            raw: req,
          },
        };
      }
      if (event === 'user-questions/request') {
        return {
          kind: 'question',
          request: {
            eventId,
            sessionId,
            raw: req,
            questions: list(req.questions).map((q) => {
              const qm = obj(q);
              return {
                id: str(qm.id) ?? '',
                question: str(qm.question) ?? '',
                detail: str(qm.detail),
                header: str(qm.header),
                multiSelect: qm.multiSelect === true,
                options: list(qm.options).map((o) => ({ label: str(obj(o).label) ?? '', description: str(obj(o).description) })),
              };
            }),
          },
        };
      }
      return { kind: 'unknown', raw: v };
    }
    case 'cancel':
      return { kind: 'cancel', eventId: str(m.eventId) ?? '' };
    default:
      return { kind: 'unknown', raw: v };
  }
}

export const stringList = strList;
