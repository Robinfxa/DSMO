import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bm25, similarity, tokens } from '../lib/shared/text.mjs';
import {
  LIMITS, MEMORY_INSTRUCTIONS, MEMORY_SCHEMA, addEpisode, addFact, applyAnalysis, applyConsolidation, consolidationRequest,
  emptyMemory, forget, maintain, markRecalled, recall, relativeDate, render, residents, retention, strengthen,
} from '../lib/core.mjs';
import { normalizeAspect } from '../../core/lib/core.mjs';

const H = 3_600_000;
const D = 24 * H;
const T0 = new Date(2026, 10, 20, 12).getTime(); // 2026-11-20 周五 12:00（本地）

test('text: Chinese bigrams, similarity, BM25', () => {
  assert.deepEqual(tokens('喜欢猫 Cat2'), ['喜欢', '欢猫', 'cat2']);
  assert.deepEqual(tokens('猫'), ['猫']);
  assert.ok(similarity('对方不吃香菜', '对方不吃香菜的') > 0.7);
  assert.ok(similarity('对方不吃香菜', '对方喜欢猫') < 0.3);
  const idx = bm25([{ id: 'a', text: '对方养了一只猫叫团子' }, { id: 'b', text: '对方在准备考研' }]);
  const s = idx.score('团子今天又把杯子打翻了');
  assert.ok(s.get('a') > 0 && !s.has('b'));
});

test('facts need the user’s own words; without them they are only 拿不准', () => {
  const m = emptyMemory();
  const ok = addFact(m, { text: '对方不吃香菜', cat: 'pref', kw: ['香菜'], quote: '我不吃香菜' }, { now: T0, user: '我不吃香菜，一点都不行' });
  assert.equal(ok.cat, 'pref');
  const made = addFact(m, { text: '对方是医生', cat: 'identity', kw: ['医生'], quote: '我是医生' }, { now: T0, user: '今天好累啊' });
  assert.equal(made.cat, 'uncertain');
  assert.equal(addFact(m, { text: '对方的银行卡号是 6222020200001234', cat: 'stable', quote: '卡号' }, { now: T0, user: '卡号' }), null);
  assert.equal(addFact(m, { text: '对方的密码是 abc', cat: 'stable' }, { now: T0 }), null);
});

test('the same thing twice merges; a correction supersedes instead of overwriting', () => {
  const m = emptyMemory();
  const a = addFact(m, { text: '对方养了一只猫', cat: 'stable', kw: ['猫'], quote: '我养了只猫' }, { now: T0, user: '我养了只猫' });
  const b = addFact(m, { text: '对方养了一只猫叫团子', cat: 'stable', kw: ['团子'], quote: '它叫团子' }, { now: T0 + H, user: '它叫团子' });
  assert.equal(a, b);
  assert.equal(m.facts.length, 1);
  assert.equal(a.text, '对方养了一只猫叫团子');
  assert.deepEqual(a.kw, ['猫', '团子']);
  const c = addFact(m, { text: '对方住在杭州', cat: 'identity', kw: ['杭州'], quote: '我在杭州' }, { now: T0, user: '我在杭州' });
  const d = addFact(m, { text: '对方搬到了上海', cat: 'identity', kw: ['上海'], quote: '我搬到上海了', supersedes: '对方住在杭州' }, { now: T0 + D, user: '我搬到上海了' });
  assert.equal(c.supersededBy, d.id);
  assert.ok(!residents(m, { now: T0 + D }).some((f) => f.id === c.id));
});

test('episodes: same day + same story merges, different days stay apart', () => {
  const m = emptyMemory();
  const e1 = addEpisode(m, { title: '面试', summary: '对方面试没过，很难过', at: '2026-11-13', kw: ['面试'], salience: 7 }, { now: T0, feeling: { label: '难过', intensity: 0.8 } });
  const e2 = addEpisode(m, { title: '面试', summary: '对方面试没过，非常难过', at: '2026-11-13', kw: ['工作'], salience: 8 }, { now: T0 });
  const e3 = addEpisode(m, { title: '面试', summary: '对方面试没过，很难过', at: '2026-11-19', kw: ['面试'], salience: 7 }, { now: T0 });
  assert.equal(e1, e2);
  assert.notEqual(e1, e3);
  assert.equal(e1.salience, 8);
  assert.deepEqual(e1.feeling, { label: '难过', intensity: 0.8 });
});

test('forgetting by use: half-lives by kind, recall strengthens and slows forgetting', () => {
  const m = emptyMemory();
  const recent = addFact(m, { text: '对方这周在出差', cat: 'recent', quote: '这周出差', kw: ['出差'] }, { now: T0, user: '这周出差' });
  const pref = addFact(m, { text: '对方不吃香菜', cat: 'pref', quote: '不吃香菜', kw: ['香菜'] }, { now: T0, user: '不吃香菜' });
  assert.ok(Math.abs(retention(recent, T0 + 2 * D) - 0.5) < 0.01);
  assert.ok(retention(pref, T0 + 30 * D) > 0.88);
  const H0 = pref.H;
  assert.equal(strengthen(pref, T0 + D), true);
  assert.equal(strengthen(pref, T0 + D + 10 * 60_000), false, '60-minute cooldown');
  assert.ok(Math.abs(pref.H - H0 * 1.3) < 1e-6);
  pref.pinned = true;
  assert.equal(retention(pref, T0 + 9999 * D), 1);
});

test('recall: by words, by the keyword graph, frozen ones only by their keyword', () => {
  const m = emptyMemory();
  applyAnalysis(m, { facts: [{ text: '对方数学一直不太好', cat: 'stable', kw: ['数学', '考研'], quote: '数学不好' }] }, { now: T0, user: '我数学不好' });
  applyAnalysis(m, { event: { title: '图书馆', summary: '对方在图书馆复习到闭馆', at: '2026-11-18', kw: ['图书馆'], salience: 3 } }, { now: T0 });
  // 「考研」只在关键词里；说到考研时，经由图想起「数学不好」
  const r1 = recall(m, { query: '考研好难', now: T0 + H });
  assert.equal(r1[0]?.item.text, '对方数学一直不太好');
  // 冻结：一个月后小事想不起来，说到「图书馆」才唤醒
  const later = T0 + 60 * D;
  assert.ok(retention(m.episodes[0], later) < 0.1);
  assert.equal(recall(m, { query: '今天去复习了', now: later }).length, 0);
  assert.equal(recall(m, { query: '今天又去图书馆了', now: later })[0]?.kind, 'episode');
});

test('recall: no repeats within 6 turns; signal words look harder', () => {
  const m = emptyMemory();
  applyAnalysis(m, { facts: [{ text: '对方养了一只猫叫团子', cat: 'stable', kw: ['团子', '猫'], quote: '团子' }] }, { now: T0, user: '我家团子' });
  const r = recall(m, { query: '团子又调皮了', now: T0 });
  assert.equal(r.length, 1);
  markRecalled(m, [r[0].item.id], T0);
  assert.equal(recall(m, { query: '团子又调皮了', now: T0 }).length, 0);
  m.turn += LIMITS.noRepeatTurns;
  assert.equal(recall(m, { query: '团子又调皮了', now: T0 }).length, 1);
  for (const f of ['玫瑰', '百合', '茉莉', '郁金香', '栀子', '向日葵']) applyAnalysis(m, { facts: [{ text: `对方喜欢${f}`, cat: 'pref', kw: [f], quote: f }] }, { now: T0, user: f });
  assert.ok(recall(m, { query: '还记得我喜欢什么花吗', now: T0 }).length > recall(m, { query: '我喜欢什么花', now: T0 }).length);
});

test('intimate memories wait until the relationship is close, unless she brings them up', () => {
  const m = emptyMemory();
  applyAnalysis(m, { event: { title: '告白', summary: '对方第一次说喜欢你，你们都很害羞', at: '2026-11-19', kw: ['告白', '第一次'], salience: 9 } }, { now: T0, user: '', feeling: { label: '害羞', intensity: 0.9 } });
  assert.equal(recall(m, { query: '今天心情不错，喜欢这样的天气', now: T0, bondLevel: 2 }).length, 0);
  assert.equal(recall(m, { query: '今天心情不错，喜欢这样的天气', now: T0, bondLevel: 4 }).length, 1);
  assert.equal(recall(m, { query: '还记得那次告白吗', now: T0, bondLevel: 1 }).length, 1);
});

test('mood-congruent recall: a happy mood favours happy memories', () => {
  const m = emptyMemory();
  applyAnalysis(m, { event: { summary: '你们在海边看日落，很开心', at: '2026-11-10', kw: ['海边'], salience: 6 } }, { now: T0, feeling: { label: '开心', intensity: 0.9 } });
  applyAnalysis(m, { event: { summary: '你们在海边吵了一架，不欢而散', at: '2026-11-12', kw: ['海边'], salience: 6 } }, { now: T0, feeling: { label: '生气', intensity: 0.9 } });
  assert.match(recall(m, { query: '想去海边', now: T0, moodValence: 0.8 })[0].item.summary, /日落/);
  assert.match(recall(m, { query: '想去海边', now: T0, moodValence: -0.8 })[0].item.summary, /吵/);
});

test('render: 关于对方 + 此刻想起 + footer, within budget, with relative dates', () => {
  const m = emptyMemory();
  m.profile.short = '嘴硬心软，累了也不爱说。';
  applyAnalysis(m, { facts: [{ text: '对方养了一只猫叫团子', cat: 'stable', kw: ['团子'], quote: '团子' }, { text: '对方不吃香菜', cat: 'pref', kw: ['香菜'], quote: '香菜' }] }, { now: T0, user: '团子 香菜' });
  applyAnalysis(m, { event: { summary: '对方面试没过，那天很难过', at: '2026-11-13', kw: ['面试'], salience: 7 } }, { now: T0 });
  const res = residents(m, { now: T0 });
  const rec = recall(m, { query: '又要面试了', now: T0, exclude: new Set(res.map((f) => f.id)) });
  const { text, recalledIds } = render(m, { residents: res, recalled: rec, now: T0 });
  assert.match(text, /^【关于对方】嘴硬心软，累了也不爱说。\n- 对方养了一只猫叫团子；对方不吃香菜\n【此刻想起】\n- 上周五（11 月 13 日），对方面试没过，那天很难过\n（以上只是你心里记得的事/);
  assert.equal(recalledIds.length, 1);
  assert.ok(text.length <= LIMITS.budget);
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `对方喜欢第 ${i} 样很长很长很长很长很长的东西` }));
  assert.ok(render(m, { residents: many, recalled: [], now: T0 }).text.length <= LIMITS.budget);
  assert.equal(render(emptyMemory(), { now: T0 }).text, '');
  assert.equal(relativeDate('2026-11-19', T0), '昨天');
  assert.equal(relativeDate('2026-11-16', T0), '4 天前');
  assert.equal(relativeDate('2025-03-02', T0), '2025 年 3 月');
});

test('「忘掉…」 deletes, and is remembered for the next impression', () => {
  const m = emptyMemory();
  applyAnalysis(m, { facts: [{ text: '对方的前任叫小王', cat: 'stable', kw: ['前任', '小王'], quote: '前任小王' }] }, { now: T0, user: '我前任小王' });
  applyAnalysis(m, { forget: ['前任的事'] }, { now: T0 });
  assert.equal(m.facts.length, 0);
  assert.deepEqual(m.profile.forgetNotes, ['前任的事']);
  assert.equal(forget(m, ['不存在的事']), 0);
});

test('details fade into an impression: frozen small things gather, then one rewrite', () => {
  const m = emptyMemory();
  const small = ['吃了火锅', '买了新裙子', '看了一部电影', '养的花开了', '加班到很晚', '去跑步了', '做了蛋糕', '剪了头发', '换了手机壳', '学会了织围巾'];
  for (const x of small) applyAnalysis(m, { event: { summary: `那天对方说自己${x}`, at: '2026-06-01', kw: [x.slice(-2)], salience: 2 } }, { now: T0 });
  applyAnalysis(m, { event: { summary: '对方第一次带你去见朋友', at: '2026-06-02', kw: ['朋友'], salience: 9 } }, { now: T0 });
  assert.equal(maintain(m, T0 + 10 * D), false);
  assert.equal(maintain(m, T0 + 120 * D), true);
  assert.equal(m.episodes.length, 1, 'the important one stays');
  const req = consolidationRequest(m, T0 + 120 * D);
  assert.match(req.user, /做了蛋糕/);
  assert.equal(applyConsolidation(m, '```json\n{"impression":"截至 3 月，我对 TA 的了解：话多，爱分享小事。","short":"爱分享小事的话痨"}\n```'), true);
  assert.equal(m.profile.short, '爱分享小事的话痨');
  assert.equal(m.profile.fading.length, 0);
  assert.equal(applyConsolidation(m, '不是 JSON'), false);
});

test('the analysis contract fits the controller’s limits', () => {
  assert.ok(MEMORY_INSTRUCTIONS.length <= 300, `${MEMORY_INSTRUCTIONS.length}`);
  // 扮演里对 TA 的角色做的事（「摸摸你的鳍」）不能记成对方本人的喜好，否则会带进每一段对话
  assert.match(MEMORY_INSTRUCTIONS, /扮演里对方的动作、台词都不算/);
  const { errors } = normalizeAspect({ id: 'memory', analysis: { schema: MEMORY_SCHEMA, instructions: MEMORY_INSTRUCTIONS } });
  assert.deepEqual(errors, []);
});

test('her own words come first; the last chat impression only fills in when they find nothing', async () => {
  const { createMemory } = await import('../lib/aspect.mjs');
  let v = null;
  const m = createMemory({ store: { load: () => v, save: (x) => (v = JSON.parse(JSON.stringify(x))) }, now: () => T0 });
  m.afterTurn({ facts: [], event: { summary: '团子打翻了杯子，对方哭笑不得', at: '2026-11-20', kw: ['团子', '杯子'], salience: 4 }, cue: '聊团子的糗事' }, { user: '我家团子打翻了杯子' });
  m.afterTurn({ facts: [{ text: '对方最近在加班', cat: 'recent', kw: ['加班'], quote: '加班' }], cue: '聊团子的糗事' }, { user: '最近一直加班' });
  assert.match(m.compose('今天又加班到很晚'), /对方最近在加班/);
  assert.doesNotMatch(m.compose('今天又加班到很晚'), /团子/, 'her words found something, so no carry-over');
  m.afterTurn({ facts: [] }, { user: '今天又加班到很晚' });
  assert.match(m.compose('团子又调皮了'), /团子打翻了杯子/);
  // 只靠聊天印象想起的（对方这轮没说到）不占「6 轮不重复」的名额
  m.afterTurn({ facts: [], cue: '聊团子的糗事' }, { user: '团子又调皮了' });
  for (let i = 0; i < 6; i++) m.afterTurn({ facts: [], cue: '聊团子的糗事' }, { user: '嗯嗯' });
  assert.match(m.compose('今天好累'), /团子打翻了杯子/, 'lingers through the chat impression');
  m.afterTurn({ facts: [], cue: '聊团子的糗事' }, { user: '今天好累' });
  assert.match(m.compose('团子今天乖不乖'), /团子打翻了杯子/, 'and can still be properly recalled right after');
});

test('batch: about-me facts are pinned and need no quote; stories stay in the story world; undo restores', async () => {
  const { applyBatch, finishBatch, undoBatch, MEMORY_BATCH_SCHEMA, memoryBatchInstructions } = await import('../lib/core.mjs');
  const m = emptyMemory();
  const old = addFact(m, { text: '对方住在杭州', cat: 'identity', kw: ['杭州'], quote: '我在杭州' }, { now: T0, user: '我在杭州' });
  applyBatch(m, { facts: [{ text: '对方叫小林', cat: 'identity', kw: ['小林'] }, { text: '对方住在上海', cat: 'identity', kw: ['上海'] }] }, { now: T0, jobId: 'j1', textType: 'aboutme' });
  assert.ok(m.facts.filter((f) => f.jobId === 'j1').every((f) => f.pinned && f.source === 'import'));
  applyBatch(m, { facts: [{ text: '魔法学院在云上', cat: 'stable', kw: ['魔法学院'] }], episodes: [{ summary: '你们在魔法学院第一次见面', at: '2026-01-01', kw: ['魔法学院'], salience: 8, feeling: '害羞' }] }, { now: T0, jobId: 'j2', textType: 'story' });
  assert.equal(m.facts.find((f) => f.jobId === 'j2').cat, 'world');
  assert.equal(m.episodes[0].story, true);
  assert.ok(!residents(m, { now: T0 }).some((f) => f.cat === 'world'));
  const chat = applyBatch(m, { facts: [{ text: '对方是护士', cat: 'identity', kw: ['护士'], quote: '我是护士' }] }, { now: T0, jobId: 'j3', textType: 'chatlog', user: '今天好累' });
  assert.equal(chat[0].cat, 'uncertain', 'chat logs still need her own words');
  assert.equal(finishBatch(m, 'j1'), true);
  assert.ok(consolidationRequest(m, T0).user.includes('对方叫小林'));
  undoBatch(m, 'j2');
  assert.equal(m.episodes.length, 0);
  assert.ok(old);
  assert.ok(JSON.stringify(MEMORY_BATCH_SCHEMA).length <= 4096);
  assert.equal(memoryBatchInstructions('session'), memoryBatchInstructions('chatlog'));
});

test('the last chat impression belongs to its own conversation: another one never recalls through it', async () => {
  const { createMemory } = await import('../lib/aspect.mjs');
  const m = createMemory({ store: { load: () => null, save: () => {} }, now: () => T0 });
  m.afterTurn({ facts: [], event: { summary: '团子打翻了杯子，对方哭笑不得', at: '2026-11-20', kw: ['团子', '杯子'], salience: 4 }, cue: '聊团子的糗事' }, { user: '我家团子打翻了杯子', sessionId: 'A' });
  m.afterTurn({ facts: [], cue: '聊团子的糗事' }, { user: '嗯嗯', sessionId: 'A' });
  assert.match(m.compose('今天好累', 'A'), /团子打翻了杯子/, 'the same conversation carries on');
  assert.doesNotMatch(m.compose('帮我写一封请假邮件', 'B'), /团子/, 'a different conversation does not');
  assert.match(m.compose('团子又调皮了', 'B'), /团子打翻了杯子/, 'unless she brings it up herself');
});
