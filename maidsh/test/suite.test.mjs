// 跨包的组合测试：心情 + 羁绊 + 总控（不经过 DSH）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanion } from '../core/lib/runtime.mjs';
import { createMood } from '../mood/lib/aspect.mjs';
import { createBond } from '../bond/lib/aspect.mjs';

const memStore = (init = null) => {
  let v = init;
  return { load: () => v, save: (x) => (v = JSON.parse(JSON.stringify(x))), peek: () => v };
};

test('with the controller: one call drives both faces, bond feels the mood', async () => {
  let t = 0;
  let calls = 0;
  const now = () => t;
  const mood = createMood({ store: memStore(), now });
  const bond = createBond({ store: memStore(), now, moodValence: () => mood.service.get().valence });
  const plain = createBond({ store: memStore(), now });
  const c = createCompanion({ complete: async () => (calls++, '{"feeling":{"label":"开心","intensity":1}}'), now, random: () => 0.1 });
  c.register(mood.aspect);
  c.register(bond.aspect);
  for (let i = 0; i < 3; i++) {
    t += 60_000;
    await c.afterTurn({ user: '谢谢你', reply: '不客气呀' });
    plain.service.interact('开心', 1);
  }
  assert.equal(calls, 3);
  assert.ok(mood.service.get().valence > 0.3);
  assert.ok(bond.service.get().value > plain.service.get().value, 'a happy mood makes the same turns count more');
  const text = c.promptText();
  assert.match(text, /^你现在的心情：/);
  assert.deepEqual(c.state().aspects.map((a) => a.id), ['mood', 'bond']);
});

test('state survives a restart through the store', () => {
  const s = memStore();
  const a = createMood({ store: s, now: () => 0 });
  a.service.feel('生气', 1, 'test');
  const b = createMood({ store: s, now: () => 0 });
  assert.equal(b.service.get().valence, a.service.get().valence);
  assert.ok(b.service.get().valence < 0);
});

test('without the controller: bond can follow mood’s feelings instead of asking the model again', () => {
  const mood = createMood({ store: memStore(), now: () => 0 });
  const bond = createBond({ store: memStore(), now: () => 0, moodValence: () => mood.service.get().valence });
  const off = mood.service.subscribe(({ label, intensity }) => bond.service.interact(label, intensity, 'mood'));
  mood.service.feel('感动', 0.9, 'standalone');
  assert.ok(bond.service.get().value > 0);
  off();
  const before = bond.service.get().value;
  mood.service.feel('感动', 0.9, 'standalone');
  assert.equal(bond.service.get().value, before);
});

test('services never throw, even on nonsense', () => {
  const failing = { load: () => null, save: () => { throw new Error('磁盘满了'); } };
  const logs = [];
  const mood = createMood({ store: failing, log: (m) => logs.push(m) });
  const bond = createBond({ store: failing, log: (m) => logs.push(m), moodValence: () => { throw new Error('x'); } });
  assert.doesNotThrow(() => mood.service.feel('不存在', 'abc'));
  assert.doesNotThrow(() => mood.service.feel('开心', 1));
  assert.doesNotThrow(() => bond.service.interact('开心', 1));
  assert.equal(typeof mood.service.describe(), 'string');
  assert.equal(typeof bond.service.describe(), 'string');
  assert.ok(logs.filter((m) => /磁盘满了/.test(m)).length === 2);
});
