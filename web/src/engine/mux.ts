// /api/remote.mux: many logical streams over one WebSocket, one JSON text
// frame per message.
//   out {type:'open', streamId, endpoint, payload:{args}}   in {type:'item', streamId, value}
//   out {type:'item'|'end'|'cancel', streamId, ...}         in {type:'end'|'error', streamId, error?}
//
// Every connection opens the Gateway-internal `$events` stream first; its
// first item is `{type:'ready', clientId, host:{home}}`. A connection is only
// usable ("a generation") after ready. When `$events` ends or the socket
// drops, every stream of that generation fails and the Mux reconnects with
// capped, jittered backoff; callers (session watchers) reopen their streams.

import { DshClosedError, DshRemoteError, DshTransportError } from './errors';
import { obj, str, uuid } from './json';

export const REMOTE_MUX_PATH = '/api/remote.mux';
export const HOST_EVENTS_ENDPOINT = '$events';
export const RETRY_CAPS_S = [0.5, 1, 2, 4, 8, 10];

export interface MuxSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((text: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
}
export type SocketFactory = () => MuxSocket;

/** Browser WebSocket → MuxSocket. `url` defaults to the page's own origin. */
export function browserSocketFactory(url?: string): SocketFactory {
  return () => {
    const loc = globalThis.location;
    const target = url ?? `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${REMOTE_MUX_PATH}`;
    const ws = new WebSocket(target);
    const s: MuxSocket = {
      send: (t) => ws.send(t),
      close: (c, r) => ws.close(c, r),
      onopen: null,
      onmessage: null,
      onclose: null,
    };
    ws.onopen = () => s.onopen?.();
    ws.onmessage = (e) => s.onmessage?.(typeof e.data === 'string' ? e.data : '');
    ws.onclose = (e) => s.onclose?.(e.code, e.reason);
    return s;
  };
}

export type ConnState = 'idle' | 'connecting' | 'connected' | 'retrying' | 'closed';

export interface Generation {
  readonly n: number;
  readonly clientId: string;
  readonly home: string;
}

export interface StreamHandlers {
  onItem(value: unknown): void;
  onEnd?(): void;
  onError?(error: Error): void;
}

export class MuxStream {
  terminal = false;
  sent = false;
  constructor(
    private readonly mux: Mux,
    readonly streamId: string,
    readonly endpoint: string,
    readonly args: Record<string, unknown>,
    readonly handlers: StreamHandlers,
  ) {}
  /** Uplink item (bidirectional endpoints such as terminal/attach). */
  sendItem(value: unknown) {
    this.mux.sendFrame({ type: 'item', streamId: this.streamId, value });
  }
  endUplink() {
    this.mux.sendFrame({ type: 'end', streamId: this.streamId });
  }
  cancel() {
    if (this.terminal) return;
    this.terminal = true;
    this.mux.forget(this, true);
  }
  deliver(frame: Record<string, unknown>) {
    if (this.terminal) return;
    switch (frame.type) {
      case 'item':
        this.handlers.onItem(frame.value);
        break;
      case 'end':
        this.terminal = true;
        this.mux.forget(this, false);
        this.handlers.onEnd?.();
        break;
      case 'error':
        this.terminal = true;
        this.mux.forget(this, false);
        this.handlers.onError?.(DshRemoteError.fromJson(frame.error));
        break;
    }
  }
  fail(error: Error) {
    if (this.terminal) return;
    this.terminal = true;
    this.handlers.onError?.(error);
  }
}

export interface MuxOptions {
  readyTimeoutMs?: number;
  /** Override for tests: () => 0..1 */
  random?: () => number;
  /** Override for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Mux {
  private socket: MuxSocket | null = null;
  private streams = new Map<string, MuxStream>();
  private pending: MuxStream[] = [];
  private eventsId: string | null = null;
  private gen: Generation | null = null;
  private genCount = 0;
  private attempt = 0;
  private retryTimer: unknown = null;
  private readyTimer: unknown = null;
  private readyWaiters: Array<{ resolve: (g: Generation) => void; reject: (e: Error) => void }> = [];
  private stateListeners = new Set<(s: ConnState) => void>();
  private eventListeners = new Set<(item: unknown, g: Generation) => void>();
  private _state: ConnState = 'idle';
  lastError: Error | null = null;

  constructor(
    private readonly factory: SocketFactory,
    private readonly opts: MuxOptions = {},
  ) {}

  get state() {
    return this._state;
  }
  get generation() {
    return this.gen;
  }

  onState(fn: (s: ConnState) => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  /** `$events` items after ready (emit / waterfall / cancel), tagged with their generation. */
  onHostEvent(fn: (item: unknown, g: Generation) => void) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private setState(s: ConnState) {
    if (this._state === s) return;
    this._state = s;
    for (const fn of [...this.stateListeners]) fn(s);
  }

  private timer(fn: () => void, ms: number) {
    return (this.opts.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }
  private clear(t: unknown) {
    if (t != null) (this.opts.clearTimer ?? ((x) => clearTimeout(x as number)))(t);
  }

  /** Resolves with the current generation, connecting if needed. */
  ready(): Promise<Generation> {
    if (this._state === 'closed') return Promise.reject(new DshClosedError('mux closed'));
    if (this.gen && this._state === 'connected') return Promise.resolve(this.gen);
    this.connect();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  open(endpoint: string, args: Record<string, unknown>, handlers: StreamHandlers): MuxStream {
    if (this._state === 'closed') throw new DshClosedError('mux closed');
    const s = new MuxStream(this, uuid(), endpoint, args, handlers);
    if (this.gen && this._state === 'connected') this.sendOpen(s);
    else {
      this.pending.push(s);
      this.connect();
    }
    return s;
  }

  /** Forces a fresh connection now (e.g. app resumed, host switched). */
  reconnect() {
    if (this._state === 'closed') return;
    this.clear(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    if (this.socket) this.lose(new DshTransportError('reconnect requested'), true);
    this.connect();
  }

  close() {
    if (this._state === 'closed') return;
    this.clear(this.retryTimer);
    this.clear(this.readyTimer);
    const err = new DshClosedError('mux closed');
    for (const s of [...this.streams.values(), ...this.pending]) s.fail(err);
    this.streams.clear();
    this.pending = [];
    for (const w of this.readyWaiters.splice(0)) w.reject(err);
    const sock = this.socket;
    this.socket = null;
    this.gen = null;
    sock?.close(1000, 'client closed');
    this.setState('closed');
  }

  sendFrame(frame: Record<string, unknown>) {
    if (this.socket && this.gen) this.socket.send(JSON.stringify(frame));
  }

  forget(s: MuxStream, sendCancel: boolean) {
    this.pending = this.pending.filter((p) => p !== s);
    if (this.streams.get(s.streamId) === s) {
      this.streams.delete(s.streamId);
      if (sendCancel && s.sent) this.sendFrame({ type: 'cancel', streamId: s.streamId });
    }
  }

  private sendOpen(s: MuxStream) {
    this.streams.set(s.streamId, s);
    s.sent = true;
    this.socket!.send(JSON.stringify({ type: 'open', streamId: s.streamId, endpoint: s.endpoint, payload: { args: s.args } }));
  }

  private connect() {
    if (this.socket || this._state === 'closed' || this.retryTimer != null) return;
    this.setState('connecting');
    let sock: MuxSocket;
    try {
      sock = this.factory();
    } catch (e) {
      this.lastError = e as Error;
      this.scheduleRetry();
      return;
    }
    this.socket = sock;
    sock.onopen = () => {
      if (this.socket !== sock) return;
      const id = uuid();
      this.eventsId = id;
      sock.send(JSON.stringify({ type: 'open', streamId: id, endpoint: HOST_EVENTS_ENDPOINT, payload: { args: {} } }));
      this.readyTimer = this.timer(() => {
        if (this.socket === sock && !this.gen) {
          this.lastError = new DshTransportError('Host did not send ready on $events in time');
          this.lose(this.lastError, true);
        }
      }, this.opts.readyTimeoutMs ?? 15_000);
    };
    sock.onmessage = (text) => {
      if (this.socket !== sock) return;
      let frame: Record<string, unknown>;
      try {
        frame = obj(JSON.parse(text));
      } catch {
        return;
      }
      this.onFrame(frame);
    };
    sock.onclose = (code, reason) => {
      if (this.socket !== sock) return;
      this.lose(new DshTransportError(`socket closed (${code}${reason ? ' ' + reason : ''})`), false);
    };
  }

  private onFrame(frame: Record<string, unknown>) {
    const streamId = str(frame.streamId);
    if (streamId && streamId === this.eventsId) {
      if (frame.type === 'item') {
        const v = obj(frame.value);
        if (!this.gen) {
          if (v.type !== 'ready') return;
          this.clear(this.readyTimer);
          this.gen = { n: ++this.genCount, clientId: str(v.clientId) ?? '', home: str(obj(v.host).home) ?? '' };
          this.attempt = 0;
          this.lastError = null;
          this.setState('connected');
          for (const w of this.readyWaiters.splice(0)) w.resolve(this.gen);
          for (const fn of [...this.eventListeners]) fn(frame.value, this.gen);
          const queued = this.pending;
          this.pending = [];
          for (const s of queued) if (!s.terminal) this.sendOpen(s);
          return;
        }
        for (const fn of [...this.eventListeners]) fn(frame.value, this.gen);
        return;
      }
      // `$events` ended or failed: the generation is over.
      this.lose(
        frame.type === 'error' ? DshRemoteError.fromJson(frame.error) : new DshTransportError('$events ended'),
        true,
      );
      return;
    }
    if (!streamId) return;
    this.streams.get(streamId)?.deliver(frame);
  }

  private lose(error: Error, closeSocket: boolean) {
    const sock = this.socket;
    this.socket = null;
    this.gen = null;
    this.eventsId = null;
    this.clear(this.readyTimer);
    if (closeSocket) {
      if (sock) {
        sock.onclose = null;
        sock.onmessage = null;
      }
      sock?.close(4000, 'lost');
    }
    const live = [...this.streams.values()];
    this.streams.clear();
    for (const s of live) s.fail(error);
    if (this._state === 'closed') return;
    this.lastError = error;
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this._state === 'closed') return;
    this.setState('retrying');
    const cap = RETRY_CAPS_S[Math.min(this.attempt, RETRY_CAPS_S.length - 1)];
    this.attempt++;
    const jitter = 0.5 + 0.5 * (this.opts.random ?? Math.random)();
    this.retryTimer = this.timer(() => {
      this.retryTimer = null;
      this.connect();
    }, cap * 1000 * jitter);
  }
}
