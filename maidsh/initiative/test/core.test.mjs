import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, addFollowup, due, emptyInitiative, gapLine, gapText, initiativePrompt, onInitiated, onInitiativeDone, onStartup, onUserTurn, planNext, quiet, quietEnd, settlePending } from '../lib/core.mjs';
import { INITIATIVE_INSTRUCTIONS, INITIATIVE_SCHEMA } from '../lib/core.mjs';
import { normalizeAspect } from '../../core/lib/core.mjs';

const MIN = 60_000;
const H = 60 * MIN;
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // 2026-11-d 本地时间

const chatted = (now, r = () => 0.5) => {
  const st = emptyInitiative();
  onUserTurn(st, { now, sessionId: 's1', topic: '聊团子的糗事', random: r });
  return st;
};

test('quiet hours wrap past midnight', () => {
  assert.equal(quiet(at(20, 23, 45)), true);
  assert.equal(quiet(at(21, 3)), true);
  assert.equal(quiet(at(21, 8)), false);
  assert.equal(quiet(at(20, 12)), false);
  assert.equal(quietEnd(at(21, 2)), at(21, 8));
  assert.equal(quietEnd(at(20, 23, 50)), at(21, 8));
});

test('the next random moment: not before 2h after chatting, within the spread, never in quiet hours', () => {
  for (const r of [0, 0.3, 0.7, 0.999]) {
    const st = chatted(at(20, 10), () => r);
    assert.ok(st.nextAt >= at(20, 12), `${new Date(st.nextAt)}`);
    assert.ok(st.nextAt <= at(20, 12) + DEFAULTS.spreadHours * H + 90 * MIN);
    assert.equal(quiet(st.nextAt), false);
  }
  const late = chatted(at(20, 21, 30), () => 0.99);
  assert.ok(late.nextAt >= at(21, 8) && late.nextAt <= at(21, 9, 30), `${new Date(late.nextAt)}`);
});

test('due: random moment, then the rules — daily cap, quiet, cold relationship, waiting for her reply', () => {
  const st = chatted(at(20, 10), () => 0.2);
  assert.equal(due(st, st.nextAt - MIN), null);
  const plan = due(st, st.nextAt);
  assert.equal(plan.kind, 'random');
  assert.equal(plan.reason, '聊团子的糗事');
  assert.equal(due(st, st.nextAt, { bondLevel: 1 }), null, '冷淡时不主动');
  onInitiated(st, st.nextAt, plan, { random: () => 0.2 });
  assert.equal(due(st, st.nextAt + 10 * H), null, 'waits for her reply first');
  assert.ok(st.nextAt - st.lastInitiativeAt >= 4 * H);
});

test('no reply → the gap doubles; two in a row → stop until she speaks first', () => {
  const st = chatted(at(20, 9), () => 0.1);
  let t = st.nextAt;
  onInitiated(st, t, { kind: 'random' }, { random: () => 0.1 });
  onInitiativeDone(st);
  settlePending(st, t + 3 * H);
  assert.equal(st.ignored, 0);
  settlePending(st, t + 4 * H);
  assert.equal(st.ignored, 1);
  planNext(st, t + 4 * H, { random: () => 0 });
  assert.ok(st.nextAt - st.lastInitiativeAt >= 8 * H, 'gap doubled');
  t = st.nextAt;
  onInitiated(st, t, { kind: 'random' }, { random: () => 0 });
  onInitiativeDone(st);
  settlePending(st, t + 8 * H);
  assert.equal(st.ignored, 2);
  planNext(st, t + 8 * H);
  assert.equal(st.nextAt, 0, 'stopped');
  onUserTurn(st, { now: t + 30 * H, sessionId: 's1', random: () => 0.5 });
  assert.equal(st.ignored, 0);
  assert.ok(st.nextAt > 0, 'resumes after she speaks');
});

test('at most 3 a day', () => {
  const st = chatted(at(20, 8), () => 0);
  st.day = '2026-11-20';
  st.count = 3;
  planNext(st, at(20, 12), { random: () => 0 });
  assert.ok(st.nextAt >= at(21, 8), `${new Date(st.nextAt)}`);
  assert.equal(due(st, at(20, 20)), null);
});

test('a promised check-in comes first; one missed while the app was closed folds into the next hello', () => {
  const st = chatted(at(20, 14), () => 0.9);
  addFollowup(st, { afterMin: 40, reason: '洗澡' }, at(20, 14));
  const p = due(st, at(20, 14, 41));
  assert.deepEqual([p.kind, p.reason], ['followup', '洗澡']);
  const st2 = chatted(at(20, 14), () => 0.9);
  addFollowup(st2, { afterMin: 40, reason: '开会' }, at(20, 14));
  onStartup(st2, at(20, 20), { random: () => 0.5 });
  assert.equal(st2.followups.length, 0);
  assert.equal(st2.lastTopic, '开会');
  assert.equal(addFollowup(st2, { afterMin: 2 }, at(20, 20)), false);
});

test('startup: a moment missed by under 2h fires within minutes; longer is re-planned', () => {
  const st = chatted(at(20, 9), () => 0.5);
  const missed = st.nextAt;
  onStartup(st, missed + H, { random: () => 0.5 });
  assert.ok(st.nextAt > missed + H && st.nextAt <= missed + H + 3 * MIN);
  const st2 = chatted(at(20, 9), () => 0.5);
  onStartup(st2, st2.nextAt + 5 * H, { random: () => 0.5 });
  assert.ok(st2.nextAt >= st2.lastUserAt + 2 * H && !quiet(st2.nextAt));
});

test('what she is told when speaking first; the time-gap line in normal turns', () => {
  const st = chatted(at(20, 10));
  const text = initiativePrompt(st, at(20, 13, 20), { kind: 'random' }, { mood: '你现在的心情：快乐。', hooks: ['对方明天要面试'] });
  assert.match(text, /这不是对方发来的消息/);
  assert.match(text, /3 小时 20 分钟前，刚分开没多久，当时聊到：聊团子的糗事。现在是下午/);
  assert.match(text, /对方明天要面试/);
  assert.match(initiativePrompt(st, at(20, 11), { kind: 'followup', reason: '洗澡' }), /对方之前说过「洗澡」/);
  assert.equal(gapLine(st, at(20, 12)), '');
  assert.equal(gapLine(st, at(22, 11)), '（距离你们上次聊天已经过去 2 天。）');
  assert.equal(gapText(3 * H + 5 * MIN), '3 小时');
});

test('the analysis contract fits the controller’s limits', () => {
  assert.deepEqual(normalizeAspect({ id: 'initiative', analysis: { schema: INITIATIVE_SCHEMA, instructions: INITIATIVE_INSTRUCTIONS } }).errors, []);
});

test('time of day words', async () => {
  const st = emptyInitiative();
  const word = (h) => initiativePrompt(st, at(20, h, 30), { kind: 'random' }).match(/现在是(.+?)。/)[1];
  assert.deepEqual([2, 7, 10, 12, 15, 18, 21, 23].map(word), ['凌晨', '早上', '上午', '中午', '下午', '傍晚', '晚上', '深夜']);
});
