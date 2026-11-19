// The real client against the mock engine: the same path the prototype runs.
import { describe, expect, it } from 'vitest';
import { DshClient } from '../src/engine/client';
import type { ApprovalRequest } from '../src/engine/events';
import { Transcript } from '../src/engine/transcript';
import { MockEngine } from '../src/mock/engine';

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('client ↔ mock engine', () => {
  it('runs a turn with a tool call that needs approval', async () => {
    const engine = new MockEngine(false);
    engine.speed = 0;
    const client = new DshClient(engine.rpc, engine.socketFactory);
    const approvals: ApprovalRequest[] = [];
    const t = new Transcript();
    client.onHostEvent((e) => {
      if (e.kind === 'approval') {
        approvals.push(e.request);
        t.addApproval(e.request);
      }
      if (e.kind === 'cancel') t.removeRequest(e.eventId);
    });
    await client.connect();
    const { sessionId } = await client.createSession();
    const w = client.watchSession(sessionId, (e) => t.apply(e));
    await until(() => t.cursor >= 0);
    await client.prompt(sessionId, [{ type: 'text', text: '修复登录 bug 并补测试' }]);
    await until(() => approvals.length === 1);
    await until(() => t.items.some((i) => i.kind === 'tool' && i.status === 'awaiting-approval'));
    expect(t.todos?.length).toBe(3);
    await client.respondApproval(approvals[0].eventId, 'allowed-once');
    t.removeRequest(approvals[0].eventId); // the Host sends cancel only to the other clients
    await until(() => !t.running && t.items.at(-1)?.kind === 'assistant');
    const tools = t.items.filter((i) => i.kind === 'tool');
    expect(tools.map((i) => i.kind === 'tool' && i.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(t.pendingApprovals).toHaveLength(0);
    expect(t.todos?.every((x) => x.status === 'completed')).toBe(true);
    expect(t.title).toBeTruthy();
    w.stop();
    client.close();
  });

  it('cancels mid-stream and keeps the partial text', async () => {
    const engine = new MockEngine(false);
    engine.speed = 0.02;
    const client = new DshClient(engine.rpc, engine.socketFactory);
    const t = new Transcript();
    await client.connect();
    const { sessionId } = await client.createSession();
    client.watchSession(sessionId, (e) => t.apply(e));
    await until(() => t.cursor >= 0);
    await client.prompt(sessionId, [{ type: 'text', text: '讲讲怎么把一个大目标拆成小步骤，越详细越好' }]);
    await until(() => t.items.some((i) => i.kind === 'assistant' && i.text.length > 5));
    await client.cancel(sessionId);
    await until(() => !t.running);
    const a = t.items.find((i) => i.kind === 'assistant');
    expect(a?.kind === 'assistant' && a.interrupted).toBe(true);
    expect(t.items.at(-1)?.kind === 'notice').toBe(true);
    client.close();
  });

  it('resyncs after a dropped connection without duplicating rows', async () => {
    const engine = new MockEngine(true);
    engine.speed = 0;
    const client = new DshClient(engine.rpc, engine.socketFactory);
    await client.connect();
    const [first] = await client.listSessions();
    const t = new Transcript();
    client.watchSession(first.sessionId, (e) => t.apply(e));
    await until(() => t.items.length > 0);
    const before = t.items.map((i) => i.key).join();
    engine.blip();
    await until(() => client.mux.state !== 'connected');
    await until(() => client.mux.state === 'connected', 5000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(t.items.map((i) => i.key).join()).toBe(before);
    client.close();
  });
});

describe('questions', () => {
  it('asks, takes the answer in the engine shape, and continues', async () => {
    const engine = new MockEngine(false);
    engine.speed = 0.01;
    const client = new DshClient(engine.rpc, engine.socketFactory);
    const t = new Transcript();
    let q: { eventId: string; questions: { id: string }[] } | null = null;
    client.onHostEvent((e) => {
      if (e.kind === 'question') q = e.request;
    });
    await client.connect();
    const { sessionId } = await client.createSession();
    client.watchSession(sessionId, (e) => t.apply(e));
    await until(() => t.cursor >= 0);
    await client.prompt(sessionId, [{ type: 'text', text: '帮我选一个风格写介绍' }]);
    await until(() => q !== null);
    expect(t.running).toBe(true);
    await client.answerQuestion(q!.eventId, [{ id: q!.questions[0].id, selected: ['详细'] }]);
    await until(() => !t.running);
    const last = t.items.filter((i) => i.kind === 'assistant').at(-1);
    expect(last?.kind === 'assistant' && last.text).toContain('详细');
    client.close();
  });
});

describe('pins, feedback, resend', () => {
  it('pins via workspace/follow, rates a reply, and forks before a prompt', async () => {
    const { forkPointBeforePrompt } = await import('../src/engine/transcript');
    const engine = new MockEngine(true);
    engine.speed = 0;
    const client = new DshClient(engine.rpc, engine.socketFactory);
    let pins: string[] = [];
    client.watchPins((ids) => (pins = ids));
    await client.connect();
    const [s] = await client.listSessions();
    await client.pinSession(s.sessionId);
    await until(() => pins[0] === s.sessionId);
    const t = new Transcript();
    client.watchSession(s.sessionId, (e) => t.apply(e));
    await until(() => t.items.length > 1);
    const reply = t.items.find((i) => i.kind === 'assistant');
    const mid = reply?.kind === 'assistant' ? reply.messageId : undefined;
    expect(mid).toBeTruthy();
    const f = await client.putFeedback(s.sessionId, mid!, 'positive', null);
    expect((await client.listFeedback(s.sessionId))[mid!].rating).toBe('positive');
    await client.deleteFeedback(s.sessionId, mid!, f.version);
    const user = t.items.find((i) => i.kind === 'user')!;
    const cut = forkPointBeforePrompt(t.events, user.kind === 'user' ? user.seq : 0)!;
    const fork = await client.forkAt(s.sessionId, cut);
    const t2 = new Transcript();
    client.watchSession(fork, (e) => t2.apply(e));
    await until(() => t2.cursor >= 0);
    expect(t2.items.filter((i) => i.kind === 'user')).toHaveLength(0);
    client.close();
  });
});
