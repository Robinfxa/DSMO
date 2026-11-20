// 回归测试：2026-11-20 代码审查发现的六个问题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseLenient } from '../shared/json.mjs';
import { readJsonBody } from '../shared/dsh.mjs';
import { splitAnalysis } from '../core/lib/core.mjs';
import { addFact, applyAnalysis, applyConsolidation, consolidationRequest, emptyMemory, finishBatch, applyBatch } from '../memory/lib/core.mjs';
import { addFollowup, due, emptyInitiative, onInitiated, onUserTurn, settlePending } from '../initiative/lib/core.mjs';

const H = 3_600_000;
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('1. truncated model output keeps what was written completely', () => {
  const full = '{"feeling":{"label":"开心","intensity":0.8},"memory":{"facts":[{"text":"对方养了一只猫","cat":"stable","kw":["猫"],"quote":"我养了猫"},{"text":"对方在考研","cat":"re';
  const r = splitAnalysis(full, ['feeling', 'memory', 'expression']);
  assert.deepEqual(r.feeling, { label: '开心', intensity: 0.8 });
  assert.equal(r.memory.facts[0].text, '对方养了一只猫');
  assert.equal(r.expression, null);
  assert.deepEqual(parseLenient('```json\n{"a":1,"b":[1,2,3]}\n```'), { a: 1, b: [1, 2, 3] });
  assert.deepEqual(parseLenient('好的：{"a":{"b":"含 } 和 , 的字"},"c":'), { a: { b: '含 } 和 , 的字' } });
  assert.deepEqual(parseLenient('{"a":1} 后面还有 {"b":2}'), { a: 1 });
  assert.equal(parseLenient('不是 JSON'), null);
  assert.equal(parseLenient('[1,2]'), null);
});

test('2. a request body split inside a Chinese character is decoded whole', async () => {
  const bytes = Buffer.from(JSON.stringify({ text: '我叫小林，喜欢猫'.repeat(200) }), 'utf8');
  const req = new EventEmitter();
  const p = readJsonBody(req, 1_000_000);
  for (let i = 0; i < bytes.length; i += 7) req.emit('data', bytes.subarray(i, i + 7)); // 7 字节一块：汉字（3 字节）一定会被切开
  req.emit('end');
  const body = await p;
  assert.equal(body.text, '我叫小林，喜欢猫'.repeat(200));
  const big = new EventEmitter();
  const q = readJsonBody(big, 10);
  big.emit('data', Buffer.from('{"a":"0123456789"}'));
  big.emit('end');
  assert.equal(await q, undefined, 'over the limit');
});

test('3. initiative is not stuck forever when the turn TA started never reports its end', () => {
  const st = emptyInitiative();
  onUserTurn(st, { now: at(20, 9), sessionId: 's1', random: () => 0.1 });
  onInitiated(st, st.nextAt, { kind: 'random' }, { random: () => 0.1 });
  const t = st.pending.at;
  settlePending(st, t + H);
  assert.equal(st.pending.done, undefined, 'still waiting within 2 hours');
  settlePending(st, t + 2 * H + 1);
  assert.equal(st.pending.done, true);
  settlePending(st, t + 4 * H + 1);
  assert.equal(st.pending, null, 'counted as unanswered, then free to plan again');
  assert.equal(st.ignored, 1);
});

test('4. a check-in that falls into the quiet hours is not sent the next morning', () => {
  const st = emptyInitiative();
  onUserTurn(st, { now: at(20, 23), sessionId: 's1', random: () => 0.5 });
  addFollowup(st, { afterMin: 40, reason: '洗澡' }, at(20, 23));
  assert.equal(due(st, at(20, 23, 41)), null, 'quiet hours');
  const morning = due(st, at(21, 8, 1));
  assert.notEqual(morning?.kind, 'followup');
  assert.equal(st.followups.length, 0);
  assert.equal(st.lastTopic, '洗澡', 'kept as a reason for the next hello');
});

test('5. 「忘掉」 removes what was meant, not a pinned memory that shares a word', () => {
  const m = emptyMemory();
  const cat = addFact(m, { text: '对方养了一只叫团子的猫', cat: 'stable', kw: ['猫', '团子'] }, { now: 0, source: 'import' });
  cat.pinned = true;
  addFact(m, { text: '对方讨厌猫毛', cat: 'pref', kw: ['猫毛'], quote: '讨厌猫毛' }, { now: 0, user: '我讨厌猫毛' });
  addFact(m, { text: '对方的前任叫小王', cat: 'stable', kw: ['前任', '小王'], quote: '前任小王' }, { now: 0, user: '我前任小王' });
  applyAnalysis(m, { forget: ['我说讨厌猫毛的那句话', '前任的事'] }, { now: 0 });
  assert.deepEqual(m.facts.map((f) => f.text), ['对方养了一只叫团子的猫']);
});

test('6. what arrives while the impression is being rewritten is not wiped', () => {
  const m = emptyMemory();
  applyBatch(m, { facts: [{ text: '对方叫小林', cat: 'identity', kw: ['小林'] }] }, { now: 0, jobId: 'j1', textType: 'aboutme' });
  finishBatch(m, 'j1');
  const req = consolidationRequest(m, 0);
  // 调用进行中：又导入完一批，对方又说了「忘掉…」
  applyBatch(m, { facts: [{ text: '对方是护士', cat: 'identity', kw: ['护士'] }] }, { now: 0, jobId: 'j2', textType: 'aboutme' });
  finishBatch(m, 'j2');
  m.profile.forgetNotes.push('前任的事');
  assert.equal(applyConsolidation(m, '{"impression":"截至 11 月，我对 TA 的了解：叫小林。","short":"小林"}', req.taken), true);
  assert.ok(m.profile.learned.includes('对方是护士'), 'the new batch waits for the next rewrite');
  assert.ok(!m.profile.learned.includes('对方叫小林'));
  assert.deepEqual(m.profile.forgetNotes, ['前任的事']);
  assert.ok(consolidationRequest(m, 0).user.includes('对方是护士'));
});
