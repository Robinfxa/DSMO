// The wire form of a share code, as dsh-Go writes it (app/lib/share_code/share_codec.dart):
//
//   <base64url(deflate-raw(json))>.<base64url(sha256(json)[0..6])>
//
// A `.dshgo` file (and a Gist) holds that string in a small JSON envelope.

import { deflateSync, inflateSync } from 'fflate';
import { sha256 } from './sha256';

export class ShareDecodeError extends Error {}
export class ShareFormatError extends Error {}

export const MAX_BODY = 1024 * 1024;
export const MAX_CODE = 1024 * 1024;
export const MAX_CONVERSATION_BODY = 16 * 1024 * 1024;
export const MAX_CONVERSATION_CODE = 6 * 1024 * 1024;
export const SHARE_FILE_MIME = 'application/vnd.dshgo+json';
export const SHARE_FILE_EXT = 'dshgo';
export const SHARE_FORMAT_VERSION = 1;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ShareDecodeError('not base64url');
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new ShareDecodeError('not base64url');
  }
}

/** 8 base64url characters: the first 6 bytes of SHA-256. */
export const checksum = (bytes: Uint8Array) => b64url(sha256(bytes).subarray(0, 6));

export function encodeJson(json: unknown): string {
  const body = enc.encode(JSON.stringify(json));
  return `${b64url(deflateSync(body, { level: 9 }))}.${checksum(body)}`;
}

export function decodeBody(code: string, maxBytes = MAX_BODY, maxChars = MAX_CODE): Uint8Array {
  const text = code.trim();
  if (!text || text.length > maxChars) throw new ShareDecodeError('empty or too long');
  const dot = text.indexOf('.');
  if (dot <= 0 || dot !== text.lastIndexOf('.')) throw new ShareDecodeError('no checksum');
  const data = unb64url(text.slice(0, dot));
  let body: Uint8Array;
  try {
    body = inflateSync(data);
  } catch {
    throw new ShareDecodeError('not deflate');
  }
  if (body.length > maxBytes) throw new ShareDecodeError('body too large');
  if (checksum(body) !== text.slice(dot + 1)) throw new ShareDecodeError('checksum mismatch');
  return body;
}

/** The checked JSON object inside a code (a conversation may be larger: [large]). */
export function decodeJson(code: string, large = false): Record<string, unknown> {
  const body = decodeBody(code, large ? MAX_CONVERSATION_BODY : MAX_BODY, large ? MAX_CONVERSATION_CODE : MAX_CODE);
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(body));
  } catch {
    throw new ShareDecodeError('not JSON');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ShareFormatError('body is not an object');
  const small = body.length <= MAX_BODY && code.length <= MAX_CODE;
  if (!small && (json as Record<string, unknown>).kind !== 'conversation') throw new ShareDecodeError('body too large');
  return json as Record<string, unknown>;
}

export interface Envelope {
  code: string;
  kind?: string;
  name?: string;
  assets?: Record<string, unknown>;
}

/** A `.dshgo` file's text, or a bare code. */
export function readEnvelope(text: string): Envelope {
  const t = text.trim();
  if (!t.startsWith('{')) return { code: t };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(t);
  } catch {
    throw new ShareDecodeError('not JSON');
  }
  if (!json || typeof json.dshgo !== 'number' || typeof json.code !== 'string') throw new ShareDecodeError('not a dsh-go file');
  return {
    code: json.code,
    kind: typeof json.kind === 'string' ? json.kind : undefined,
    name: typeof json.name === 'string' ? json.name : undefined,
    assets: json.assets && typeof json.assets === 'object' ? (json.assets as Record<string, unknown>) : undefined,
  };
}

export function encodeFile(kind: string, name: string | undefined, code: string): string {
  return `${JSON.stringify({ dshgo: SHARE_FORMAT_VERSION, kind, ...(name ? { name } : {}), code }, null, 2)}\n`;
}

/** Short words for a code that can't be opened (dsh-Go's shareOpenError). */
export function openErrorText(e: unknown): string {
  if (e instanceof ShareFormatError) return e.message === 'newer format' ? '需要更新 App 才能打开' : '这个分享码无法使用';
  if (e instanceof ShareDecodeError) return '这个分享码不完整或已损坏';
  if (e instanceof Error && e.name === 'GistError') return e.message;
  return '没能打开这个分享码';
}
