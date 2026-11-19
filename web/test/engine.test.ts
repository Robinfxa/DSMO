// Engine client tests driven by frames captured live from `dsh web` (fixtures
// copied from dsh-Go packages/dsh_client/test/fixtures, AGPL-3.0).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DshRemoteError } from '../src/engine/errors';
import { describeApproval, parseFollowFrame, parseHostEvent } from '../src/engine/events';
import { Mux, type MuxSocket } from '../src/engine/mux';
import { readEnvelope } from '../src/engine/rpc';
import { Transcript } from '../src/engine/transcript';

const here = dirname(fileURLToPath(import.meta.url));
const jsonl = (name: string) =>
  readFileSync(join(here, 'fixtures', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));

function replay(name: string, upTo?: (v: any) => boolean) {
  const t = new Transcript();
  let snapshots = 0;
  for (const v of jsonl(name)) {
    if (upTo && upTo(v)) break;
    const isResync = v.type === 'snapshot' && snapshots++ > 0;
    t.apply(parseFollowFrame(v, isResync));
  }
  return t;
}

describe('rpc envelope', () => {
  const exchanges = JSON.parse(readFileSync(join(here, 'fixtures', 'rpc_exchanges.json'), 'utf8'));
  it('returns values and throws remote errors exactly as captured', () => {
    for (const x of exchanges) {
      const r = x.response;
      if (r.result.ok) expect(() => readEnvelope(r, r.rpcId, x.endpoint)).not.toThrow();
      else {
        try {
          readEnvelope(r, r.rpcId, x.endpoint);
          throw new Error('should throw');
        } catch (e) {
          expect(e).toBeInstanceOf(DshRemoteError);
          expect((e as DshRemoteError).code).toBe(r.result.error.code);
        }
      }
    }
  });
  it('rejects a mismatched rpcId', () => {
    expect(() => readEnvelope({ type: 'server-response', rpcId: 'b', result: { ok: true } }, 'a', 'x')).toThrow(/mismatch/);
  });
});

describe('transcript', () => {
  it('folds a plain reply: one user row, one assistant row, not running', () => {
    const t = replay('follow_reply_ok.jsonl');
    const kinds = t.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'assistant']);
    const a = t.items[1];
    expect(a.kind === 'assistant' && a.text).toBe('OK');
    expect(a.kind === 'assistant' && a.streaming).toBe(false);
    expect(t.running).toBe(false);
  });

  it('shows a streaming draft before the durable message lands, under the same row key', () => {
    const t = replay('follow_reply_ok.jsonl', (v) => v.type === 'event' && v.event.type === 'assistant/message');
    const draft = t.items.find((i) => i.kind === 'assistant');
    expect(draft && draft.kind === 'assistant' && draft.text).toBe('OK');
    expect(draft?.key).toBe('m1.1');
    expect(t.running).toBe(true);
    const done = replay('follow_reply_ok.jsonl');
    expect(done.items.find((i) => i.kind === 'assistant')?.key).toBe('m1.1');
  });

  it('merges a resync snapshot and keeps the tool row with its result', () => {
    const t = replay('follow_approval_with_resync.jsonl');
    const tool = t.items.find((i) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.name).toBe('bash');
    expect(tool && tool.kind === 'tool' && tool.status).toBe('succeeded');
    expect(tool && tool.kind === 'tool' && tool.resultText).toBe('hi\n');
    expect(tool && tool.kind === 'tool' && tool.approvalOutcome).toBe('allowed-once');
    const texts = t.items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''));
    expect(texts.at(-1)).toBe('hi');
    expect(t.title).toBe('Testing approval UI with bash echo');
  });

  it('marks a tool awaiting approval while the $events request is pending', () => {
    const t = replay('follow_approval_with_resync.jsonl', (v) => v.type === 'event' && v.event.type === 'approval/decided');
    const ev = jsonl('events_approval.jsonl').find((v: any) => v.type === 'waterfall');
    const host = parseHostEvent(ev);
    expect(host.kind).toBe('approval');
    if (host.kind !== 'approval') return;
    t.addApproval(host.request);
    const tool = t.items.find((i) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.status).toBe('awaiting-approval');
    expect(tool && tool.kind === 'tool' && tool.approval?.eventId).toBe(host.request.eventId);
    expect(describeApproval(host.request, 'zh')).toContain('danger-full-access');
    t.removeRequest(host.request.eventId);
    expect(t.pendingApprovals).toHaveLength(0);
  });

  it('shows the interrupted prefix and a stopped notice after cancel', () => {
    const t = replay('follow_cancel.jsonl');
    const a = t.items.find((i) => i.kind === 'assistant');
    expect(a && a.kind === 'assistant' && a.interrupted).toBe(true);
    expect(a && a.kind === 'assistant' && a.text.startsWith('one two three')).toBe(true);
    const n = t.items.at(-1);
    expect(n?.kind === 'notice' && n.tone).toBe('aborted');
    expect(t.running).toBe(false);
    expect(t.title).toBe('Count from 1 to 80 in words');
  });

  it('is idempotent when the same snapshot is applied twice', () => {
    const t = replay('follow_reply_ok.jsonl');
    const before = JSON.stringify(t.items);
    const snap = jsonl('follow_reply_ok.jsonl')[0];
    t.apply(parseFollowFrame(snap, true));
    expect(JSON.stringify(t.items)).toBe(before);
  });
});

describe('mux', () => {
  class FakeSocket implements MuxSocket {
    sent: any[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((t: string) => void) | null = null;
    onclose: ((c: number, r: string) => void) | null = null;
    closed = false;
    send(t: string) {
      this.sent.push(JSON.parse(t));
    }
    close() {
      this.closed = true;
    }
    push(frame: unknown) {
      this.onmessage?.(JSON.stringify(frame));
    }
  }

  it('opens $events first, waits for ready, then flushes queued streams', async () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const mux = new Mux(
      () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      { setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {}, random: () => 0 },
    );
    const got: unknown[] = [];
    const stream = mux.open('session/follow', { request: { address: { kind: 'session', sessionId: 's' } } }, { onItem: (v) => got.push(v) });
    const s = sockets[0];
    s.onopen?.();
    expect(s.sent[0]).toMatchObject({ type: 'open', endpoint: '$events', payload: { args: {} } });
    expect(s.sent).toHaveLength(1);
    const eventsId = s.sent[0].streamId;
    const ready = mux.ready();
    s.push({ type: 'item', streamId: eventsId, value: { type: 'ready', clientId: 'c1', host: { home: '/home/user' } } });
    expect((await ready).clientId).toBe('c1');
    expect(s.sent[1]).toMatchObject({ type: 'open', endpoint: 'session/follow', streamId: stream.streamId });
    s.push({ type: 'item', streamId: stream.streamId, value: { type: 'snapshot' } });
    expect(got).toHaveLength(1);

    // Socket drop: the stream fails, the mux retries and a new generation starts.
    let failed: Error | null = null;
    stream.handlers.onError = (e) => (failed = e);
    s.onclose?.(1006, '');
    expect(failed).not.toBeNull();
    expect(mux.state).toBe('retrying');
    timers.at(-1)!();
    const s2 = sockets[1];
    s2.onopen?.();
    s2.push({ type: 'item', streamId: s2.sent[0].streamId, value: { type: 'ready', clientId: 'c2', host: {} } });
    expect(mux.generation?.clientId).toBe('c2');
    expect(mux.generation?.n).toBe(2);
  });

  it('treats a missing ready as a lost connection', () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const mux = new Mux(
      () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      { setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} },
    );
    void mux.ready().catch(() => {});
    sockets[0].onopen?.();
    timers[0](); // ready timeout fires
    expect(sockets[0].closed).toBe(true);
    expect(mux.state).toBe('retrying');
    mux.close();
  });
});

describe('fork point before a prompt', () => {
  it('cuts at the last event that is not part of delivering the prompt', async () => {
    const { forkPointBeforePrompt } = await import('../src/engine/transcript');
    const t = replay('follow_reply_ok.jsonl');
    const user = t.items.find((i) => i.kind === 'user')!;
    const cut = forkPointBeforePrompt(t.events, user.kind === 'user' ? user.seq : 0);
    expect(cut).not.toBeNull();
    const ev = t.events.find((e) => e.seq === cut)!;
    expect(['agent/inbox/spliced', 'turn/start', 'step/start', 'system/message']).not.toContain(ev.type);
    expect(cut!).toBeLessThan(user.kind === 'user' ? user.seq : 0);
  });
});
