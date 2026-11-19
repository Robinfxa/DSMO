// Unary RPC: POST /api/<endpoint>
//   {"type":"client-request","rpcId":"<uuid>","method":"<endpoint>","payload":{"args":{...}}}
// → 200 {"type":"server-response","rpcId":"<uuid>","result":{"ok":true,"value":...}}
//   200 {"type":"server-response","rpcId":"<uuid>","result":{"ok":false,"error":{...}}}
//
// In the APK the page is served by the native local proxy (same origin), so
// `base` is '' and the proxy adds the engine cookie and rewrites Host/Origin.

import { DshAuthError, DshProtocolError, DshRemoteError, DshTransportError } from './errors';
import { obj, str, uuid } from './json';

export interface RpcTransport {
  call(endpoint: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
}

/** Validates one response envelope; returns `value` or throws. */
export function readEnvelope(decoded: unknown, rpcId: string, endpoint: string): unknown {
  const m = obj(decoded);
  if (m.type !== 'server-response') throw new DshProtocolError(`${endpoint}: not a server-response`);
  const echoed = str(m.rpcId);
  // Gateway validation failures may echo `invalid-request` instead of our id.
  if (echoed !== undefined && echoed !== rpcId && echoed !== 'invalid-request') {
    throw new DshProtocolError(`${endpoint}: rpcId mismatch (sent ${rpcId}, got ${echoed})`);
  }
  const result = obj(m.result);
  if (result.ok === true) return result.value ?? null;
  if (result.ok === false) throw DshRemoteError.fromJson(result.error);
  throw new DshProtocolError(`${endpoint}: result has no ok flag`);
}

export class HttpRpc implements RpcTransport {
  constructor(
    private readonly base: string = '',
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  async call(endpoint: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const rpcId = uuid();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? this.defaultTimeoutMs);
    opts.signal?.addEventListener('abort', () => ctl.abort(), { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new DshTransportError(`${endpoint}: ${(e as Error).message || 'network error'}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new DshAuthError(`${endpoint}: HTTP ${res.status}`);
    let decoded: unknown;
    try {
      decoded = await res.json();
    } catch {
      throw new DshProtocolError(`${endpoint}: HTTP ${res.status}, body is not JSON`);
    }
    return readEnvelope(decoded, rpcId, endpoint);
  }
}
