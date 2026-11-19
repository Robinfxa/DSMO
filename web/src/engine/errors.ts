import { obj, str } from './json';

/** Base class: everything the client throws on purpose. */
export class DshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The Host answered `{ok:false, error:{code,message,details}}`. */
export class DshRemoteError extends DshError {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
  static fromJson(v: unknown): DshRemoteError {
    const m = obj(v);
    return new DshRemoteError(str(m.code) ?? 'unknown', str(m.message) ?? 'request failed', obj(m.details));
  }
}

/** Wire-level surprise: wrong envelope, mismatched rpcId, non-JSON body. */
export class DshProtocolError extends DshError {}

/** The network failed (fetch threw, socket closed, timeout). Retryable. */
export class DshTransportError extends DshError {}

/** 401/403 from the Host or proxy: the session cookie or proxy secret is gone. */
export class DshAuthError extends DshError {}

export class DshClosedError extends DshError {}
