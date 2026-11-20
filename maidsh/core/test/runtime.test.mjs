import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanion } from '../lib/runtime.mjs';

const answer = (obj) => async () => JSON.stringify(obj);

test('one model call per turn; feeling and per-face results reach every face', async () => {
  const calls = [];
  const seen = {};
  const c = createCompanion({
    complete: async (req) => {
      calls.push(req);
      return '```json\n{"feeling":{"label":"开心","intensity":0.8},"weather":{"mentioned":true}}\n```';
    },
  });
  c.register({ id: 'mood', onAnalysis: (r, t) => (seen.mood = { r, f: t.feeling }) });
  c.register({ id: 'weather', analysis: { schema: { type: 'object', properties: { mentioned: { type: 'boolean' } } }, instructions: '提到天气没有' }, onAnalysis: (r) => (seen.weather = r) });
  await c.afterTurn({ user: '今天下雨了', reply: '记得带伞' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /"feeling"/);
  assert.match(calls[0].user, /今天下雨了/);
  assert.deepEqual(seen.mood, { r: null, f: { label: '开心', intensity: 0.8 } });
  assert.deepEqual(seen.weather, { mentioned: true });
  assert.deepEqual(c.state().lastFeeling, { label: '开心', intensity: 0.8 });
});

test('nothing registered (or nobody listening) costs no call', async () => {
  let n = 0;
  const c = createCompanion({ complete: async () => (n++, '{}') });
  await c.afterTurn({ user: 'a', reply: 'b' });
  c.register({ id: 'quiet', prompt: { text: () => '只注入' } });
  await c.afterTurn({ user: 'a', reply: 'b' });
  assert.equal(n, 0);
  assert.equal(c.promptText(), '只注入');
});

test('prompt: ordered by face, stable within a turn, re-rolled after each turn', async () => {
  const rolls = [0.1, 0.9];
  const c = createCompanion({ complete: answer({ feeling: { label: '平静', intensity: 0.1 } }), random: () => rolls.shift() ?? 0.5 });
  c.register({ id: 'bond', prompt: { order: 400, text: ({ roll }) => (roll < 0.6 ? '你喜欢对方。' : '') }, onAnalysis() {} });
  c.register({ id: 'mood', prompt: { order: 300, text: () => '你现在的心情：放松。' } });
  assert.equal(c.promptText(), '你现在的心情：放松。\n你喜欢对方。');
  assert.equal(c.promptText(), '你现在的心情：放松。\n你喜欢对方。');
  await c.afterTurn({ user: 'a', reply: 'b' });
  assert.equal(c.promptText(), '你现在的心情：放松。');
});

test('a broken face, a failing model and junk answers never throw', async () => {
  const logs = [];
  let fail = true;
  const c = createCompanion({ complete: async () => { if (fail) throw new Error('网络断了'); return '我不会输出 JSON'; }, log: (m) => logs.push(m) });
  c.register({ id: 'boom', onAnalysis() { throw new Error('坏了'); }, prompt: { text() { throw new Error('也坏了'); } }, state() { throw new Error('还是坏了'); } });
  c.register({ id: 'fine', prompt: { text: () => '正常' } });
  await c.afterTurn({ user: 'a', reply: 'b' });
  assert.equal(c.state().lastError, '网络断了');
  fail = false;
  await c.afterTurn({ user: 'a', reply: 'b' });
  assert.equal(c.promptText(), '正常');
  assert.deepEqual(c.state().aspects.map((a) => a.state), [null, null]);
  assert.ok(logs.some((m) => /网络断了/.test(m)) && logs.some((m) => /读不出 JSON/.test(m)) && logs.some((m) => /也坏了/.test(m)));
});

test('turns arriving mid-analysis: only the newest waits, nothing overlaps', async () => {
  let active = 0;
  let maxActive = 0;
  const seen = [];
  const c = createCompanion({
    complete: async (req) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return JSON.stringify({ feeling: { label: '开心', intensity: 0.5 }, tag: req.user });
    },
  });
  c.register({ id: 'log', onAnalysis: (_r, t) => seen.push(t.user) });
  c.afterTurn({ user: '1', reply: '' });
  c.afterTurn({ user: '2', reply: '' });
  c.afterTurn({ user: '3', reply: '' });
  await c.idle();
  assert.equal(maxActive, 1);
  assert.deepEqual(seen, ['1', '3']);
});
