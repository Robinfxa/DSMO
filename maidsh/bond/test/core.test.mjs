import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPACT, LEVELS, hint, initialBond, interact, levelOf } from '../lib/core.mjs';

const many = (bond, label, n, mood = 0) => {
  let b = bond;
  for (let i = 0; i < n; i++) b = interact(b, label, 1, i, mood);
  return b;
};
const at = (value, streak = 0) => ({ ...initialBond(0), value, level: levelOf(value), streak });

test('levels: 厌恶 … 暧昧 at the documented bounds', () => {
  assert.deepEqual([-1000, -227, -73, 0, 227, 587, 900, 1000].map(levelOf), [0, 1, 2, 2, 3, 4, 5, 5]);
  assert.equal(LEVELS.length, 6);
});

test('warm turns build the relationship, slower and slower near the top', () => {
  const b = many(initialBond(0), '开心', 40);
  assert.ok(b.value > 227, `${b.value}`);
  const nearTop = interact(at(950), '开心', 1, 0).value - 950;
  const fromZero = interact(at(0), '开心', 1, 0).value - 0;
  assert.ok(nearTop < fromZero / 5, `${nearTop} vs ${fromZero}`);
  assert.ok(many(initialBond(0), '感动', 5000).value <= 1000);
});

test('a close relationship is hurt more by the same thing', () => {
  const hurtClose = interact(at(800), '生气', 1, 0).value - 800;
  const hurtNeutral = interact(at(0), '生气', 1, 0).value - 0;
  assert.ok(hurtClose < hurtNeutral, `${hurtClose} vs ${hurtNeutral}`);
});

test('a bad relationship mends slowly', () => {
  const mendBad = interact(at(-600), '开心', 1, 0).value + 600;
  const gainNeutral = interact(at(0), '开心', 1, 0).value;
  assert.ok(mendBad < gainNeutral, `${mendBad} vs ${gainNeutral}`);
});

test('streaks amplify, a turn the other way resets them', () => {
  const sixth = interact(at(0, 5), '开心', 1, 0).value;
  const first = interact(at(0, 0), '开心', 1, 0).value;
  assert.ok(sixth > first * 1.5, `${sixth} vs ${first}`);
  assert.equal(interact(at(0, 5), '生气', 1, 0).streak, 0);
  assert.equal(interact(at(0, 0), '生气', 1, 0).streak, -1);
  assert.equal(interact(at(0, 3), '困惑', 1, 0).streak, 3);
});

test('a good mood makes good things count more and bad things less', () => {
  const happyGain = interact(at(0), '开心', 1, 0, 0.8).value;
  const flatGain = interact(at(0), '开心', 1, 0, 0).value;
  assert.ok(happyGain > flatGain);
  const happyHurt = interact(at(0), '生气', 1, 0, 0.8).value;
  const flatHurt = interact(at(0), '生气', 1, 0, 0).value;
  assert.ok(happyHurt > flatHurt, 'less negative');
});

test('hints are sparing: none at 一般, always at the ends, sometimes in between', () => {
  assert.equal(hint(at(0), 0), '');
  assert.notEqual(hint(at(-900), 0.99), '');
  assert.notEqual(hint(at(950), 0.99), '');
  assert.notEqual(hint(at(400), 0.1), '');
  assert.equal(hint(at(400), 0.9), '');
});

test('recent changes are kept for the 陪伴 page, at most 20; unknown labels change nothing', () => {
  const b = many(initialBond(0), '开心', 25);
  assert.equal(b.recent.length, 20);
  assert.equal(b.recent[0].label, '开心');
  assert.deepEqual(interact(b, '未知', 1, 99), b);
  assert.equal(Object.keys(IMPACT).length, 13);
});
