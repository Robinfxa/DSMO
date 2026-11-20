import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMOTIONS, baseline, decay, describe, feel, initialMood } from '../lib/core.mjs';

const H = 3_600_000;

test('a happy turn lifts the mood and names it', () => {
  const m = feel(initialMood(0), '开心', 1, 0);
  assert.ok(m.valence > 0.2 && m.arousal > 0.1);
  assert.notEqual(m.label, '平静');
  assert.match(describe(m), /^你现在的心情：/);
});

test('it settles back: half the swing after the half-life', () => {
  const m = feel(initialMood(0), '生气', 1, 0);
  const later = decay(m, 2 * H);
  assert.ok(Math.abs(later.valence - m.valence / 2) < 0.01, `${later.valence} vs ${m.valence / 2}`);
  assert.ok(Math.abs(decay(m, 48 * H).valence) < 0.01);
  assert.equal(describe(decay(m, 48 * H)), '');
});

test('neuroticism: swings further and settles faster', () => {
  const calm = feel(initialMood(0), '难过', 1, 0, { neuroticism: 0 });
  const nervy = feel(initialMood(0), '难过', 1, 0, { neuroticism: 1 });
  assert.ok(nervy.valence < calm.valence);
  const r = (m, o) => Math.abs(decay(m, H, o).valence / m.valence);
  assert.ok(r(nervy, { neuroticism: 1 }) < r(calm, { neuroticism: 0 }));
});

test('agreeable people keep good moods longer and let bad ones go sooner', () => {
  const o = { agreeableness: 0.7 };
  const good = feel(initialMood(0), '开心', 1, 0, o);
  const bad = feel(initialMood(0), '生气', 1, 0, o);
  const kept = (m) => Math.abs(decay(m, H, o).valence / m.valence);
  assert.ok(kept(good) > kept(bad));
});

test('very agreeable people rest a little above neutral', () => {
  assert.ok(baseline(1) > 0 && baseline(0) < 0 && baseline(0.5) === 0);
  const m = decay({ valence: 0, arousal: 0, label: '平静', updatedAt: 0 }, 100 * H, { agreeableness: 1 });
  assert.ok(Math.abs(m.valence - baseline(1)) < 0.01);
});

test('values stay in range however hard it is pushed; unknown labels change nothing but time', () => {
  let m = initialMood(0);
  for (let i = 0; i < 50; i++) m = feel(m, '生气', 1, i);
  assert.ok(m.valence >= -1 && m.arousal <= 1);
  const same = feel(m, '不存在的情绪', 1, m.updatedAt);
  assert.equal(same.valence, m.valence);
  assert.equal(Object.keys(EMOTIONS).length, 13);
});
