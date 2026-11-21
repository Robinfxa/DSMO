// 在聊天里改设定集（LORE-DESIGN §15）：情节和「前情」、轻重划分、按批应用和撤销。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_LIMIT, applyEdits, planEdits, startPlan, undoEdits } from '../lib/edit.mjs';
import { addCharacter, addEntry, addPlot, compose, emptyWork, lookup, plotLine, recordStates, stateAt } from '../lib/core.mjs';
import { acceptPending } from '../lib/auto.mjs';

function novel() {
  const w = emptyWork({ title: '长夜', now: 1 });
  addCharacter(w, { name: '沈砚', aliases: ['阿砚'], tier: 'main', card: { summary: '落魄琴师。', personality: '嘴冷心热' } }, { now: 1 });
  addEntry(w, { title: '青州', keys: ['青州'], content: '北境门户。' }, { now: 2 });
  w.cursor.chapter = 12;
  return w;
}

test('plot: 前情 is the one or two summaries just before this chapter, cut at a sentence, never over 150', () => {
  const w = novel();
  addPlot(w, { from: 1, to: 8, summary: '沈砚在青州卖琴为生。' });
  addPlot(w, { from: 9, summary: '林晚夜访琴馆，两人互相试探。' });
  addPlot(w, { from: 10, to: 11, summary: '沈砚替林晚送信出城，左臂中刀。追兵在城门外被甩开。他躲进了废弃的驿站。' });
  addPlot(w, { from: 12, summary: '还没写完的这一章。' });
  const line = plotLine(w, 12);
  assert.match(line, /^- 前情：第 9 章，林晚夜访琴馆，两人互相试探。；第 10–11 章，沈砚替林晚送信出城/);
  assert.doesNotMatch(line, /还没写完/, 'the current chapter is not 前情');
  assert.ok(line.length <= 150, line.length);
  assert.match(compose(w, { latest: '写阿砚' }).text, /- 前情：/);
  assert.match(lookup(w, '第10章'), /【第 10–11 章】沈砚替林晚送信出城/);
  assert.match(lookup(w, '第 20 章'), /还没有记情节/);
  assert.throws(() => addPlot(w, { from: 3, to: 2, summary: 'x' }), /to 要不小于 from/);
});

test('light vs heavy: additions and filling blanks go through; overwrites, removals, renames, going back need review', () => {
  const w = novel();
  const { items, errors } = planEdits(w, [
    { kind: 'character', name: '林晚', summary: '知府之女。' },
    { kind: 'character', name: '沈砚', appearance: '左眉有疤' },
    { kind: 'character', name: '阿砚', personality: '冷淡' },
    { kind: 'character', name: '沈砚', aliases: ['砚哥'], main: true },
    { kind: 'entry', title: '青州', keys: ['州城'] },
    { kind: 'entry', title: '青州', content: '已被北境攻破。' },
    { kind: 'plot', from: 12, summary: '夜入军营。' },
    { kind: 'remove', target: '青州' },
    { kind: 'rename', title: '长夜行' },
    { kind: 'chapter', chapter: 8 },
    { kind: 'chapter', chapter: 15 },
    { kind: 'character', name: '沈砚', secret: true },
    { kind: 'whatever' },
    { kind: 'remove', target: '路人' },
  ]);
  const light = items.filter((i) => !i.important).map((i) => i.text);
  const heavy = items.filter((i) => i.important).map((i) => i.text);
  assert.deepEqual(light, ['新人物：林晚（知府之女。）', '补 沈砚 的外貌：左眉有疤', '给 沈砚 加别名：砚哥', '给设定「青州」加关键词：州城', '情节 第 12 章：夜入军营。', '现在写到：第 12 章 → 第 15 章']);
  assert.deepEqual(heavy, ['改 沈砚 的性格：嘴冷心热 → 冷淡', '改设定「青州」：北境门户。 → 已被北境攻破。', '删掉设定：青州', '作品改名：《长夜》→《长夜行》', '现在写到：第 12 章 → 第 8 章', '沈砚 设为隐藏人物']);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /不认识的改动种类/);
  assert.match(errors[1], /找不到「路人」/);
  // 「设为主要人物」：已经是主要人物，不算改动
  assert.ok(!items.some((i) => /主要人物/.test(i.text)));
});

test(`more than ${ADD_LIMIT} additions at once: all of them need review`, () => {
  const w = novel();
  const many = Array.from({ length: ADD_LIMIT + 1 }, (_, i) => ({ kind: 'character', name: `路人${i}` }));
  assert.ok(planEdits(w, many).items.every((i) => i.important));
  assert.ok(planEdits(w, many.slice(0, ADD_LIMIT)).items.every((i) => !i.important));
});

test('apply a batch, then undo it: created things go, overwritten things come back, removed things return', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '青州' }], { chapter: 3 });
  const plan = planEdits(w, [
    { kind: 'character', name: '林晚', summary: '知府之女。', main: true },
    { kind: 'character', name: '沈砚', personality: '冷淡', newName: '沈烬' },
    { kind: 'plot', from: 1, summary: '开篇。' },
    { kind: 'remove', target: '青州' },
    { kind: 'rename', title: '长夜行' },
    { kind: 'chapter', chapter: 5 },
  ]);
  const r = applyEdits(w, plan.items, { now: 5, sessionId: 's1' });
  assert.equal(r.failed.length, 0, r.failed.join());
  assert.equal(w.title, '长夜行');
  assert.equal(w.cursor.chapter, 5);
  assert.ok(w.characters.some((c) => c.name === '沈烬' && c.card.personality === '冷淡'));
  assert.ok(w.characters.some((c) => c.name === '林晚' && c.tier === 'main' && c.source === `chat:${r.batchId}`));
  assert.equal(w.lore.length, 0);
  assert.equal(w.plot.length, 1);
  const u = undoEdits(w, r.batchId);
  assert.equal(u.ok, true);
  assert.equal(w.title, '长夜');
  assert.equal(w.cursor.chapter, 12);
  const shen = w.characters.find((c) => c.aliases.includes('阿砚'));
  assert.equal(shen.name, '沈砚');
  assert.equal(shen.card.personality, '嘴冷心热');
  assert.ok(!w.characters.some((c) => c.name === '林晚'));
  assert.equal(w.lore[0]?.title, '青州');
  assert.equal(w.plot.length, 0);
  assert.equal(stateAt(w, shen.id, 3)[0].value, '青州', 'states of untouched people survive');
  assert.equal(undoEdits(w, r.batchId).ok, false);
});

test('earlier-chapter state goes through review and is recorded at that chapter', () => {
  const w = novel();
  const plan = planEdits(w, [{ kind: 'state', chapter: 4, changes: [{ subject: '沈砚', key: '伤势', value: '右手烫伤' }] }]);
  assert.equal(plan.items[0].important, true);
  assert.match(plan.items[0].text, /改第 4 章的状态：沈砚·伤势 = 右手烫伤/);
  const r = applyEdits(w, plan.items, {});
  assert.equal(r.done.length, 1);
  assert.equal(stateAt(w, w.characters[0].id, 4)[0].value, '右手烫伤');
  assert.equal(w.cursor.chapter, 12, 'going back never moves the cursor');
  undoEdits(w, r.batchId);
  assert.equal(stateAt(w, w.characters[0].id, 4).length, 0);
});

test('a chat edit waiting in 待确认 is applied by 收下 on the page', () => {
  const w = novel();
  w.pending.push({ id: 'p1', kind: 'edit', data: { changes: [{ kind: 'rename', title: '长夜行' }], texts: ['作品改名'] }, sessionId: 's1', userTurns: 1, at: 1 });
  const r = acceptPending(w, 'p1');
  assert.equal(r.accepted, 1);
  assert.equal(w.title, '长夜行');
  assert.equal(w.pending.length, 0);
  assert.equal(w.batches.length, 1);
});

test('start plan: title required; characters, entries, plot and chapter become changes', () => {
  assert.throws(() => startPlan({}), /作品要有名字/);
  const p = startPlan({ title: '长夜', characters: [{ name: '沈砚' }], entries: [{ title: '青州', content: '门户' }], plot: [{ from: 1, summary: '开篇' }], chapter: 3 });
  assert.deepEqual(p.changes.map((c) => c.kind), ['character', 'entry', 'plot', 'chapter']);
});
