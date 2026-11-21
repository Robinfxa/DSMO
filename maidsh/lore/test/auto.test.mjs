// 聊天时自动整理设定（LORE-DESIGN §14）：章节、档位、核对原句、不重复、待确认 / 自动模式、撤销、重新生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPending, applyAuto, autoRequest, chapterFromText, cnNumber, dismissPending, shouldRecord, undoAutoTurn, vanishedTurns } from '../lib/auto.mjs';
import { addCharacter, emptyWork, recordStates, relationAt, stateAt } from '../lib/core.mjs';

function novel() {
  const w = emptyWork({ title: '长夜', now: 1 });
  addCharacter(w, { name: '沈砚', aliases: ['阿砚'], tier: 'main', card: { summary: '落魄琴师。' } }, { now: 1 });
  addCharacter(w, { name: '林晚', tier: 'main', card: { summary: '知府之女。' } }, { now: 2 });
  w.cursor.chapter = 11;
  return w;
}
const at = (w, name, ch = w.cursor.chapter) => Object.fromEntries(stateAt(w, w.characters.find((c) => c.name === name).id, ch).map((s) => [s.key, s.value]));
const reply = '夜里，沈砚被刀锋划过左臂，血顺着袖口往下淌。他把林晚的玉佩塞进怀里，翻身出了青州城。城外的苏九牵着马等他，两人从此结为生死之交。北境的规矩是见血不追。';
const turn = { user: '写第十二章：阿砚出城', reply, chapter: 12, turnId: 'msg-1', sessionId: 's1' };

test('chapter numbers in the author’s words, Arabic or Chinese', () => {
  assert.equal(chapterFromText('写第十二章：阿砚出城'), 12);
  assert.equal(chapterFromText('第 3 章和第二十一章'), 21);
  assert.equal(chapterFromText('第一百零五章'), 105);
  assert.equal(chapterFromText('第两千章'), 2000);
  assert.equal(chapterFromText('继续写'), null);
  assert.equal(cnNumber('十'), 10);
  assert.equal(cnNumber('二十'), 20);
  assert.ok(Number.isNaN(cnNumber('几')));
});

test('which turns are worth a call', () => {
  const w = novel();
  assert.equal(shouldRecord(w, '好的'), false, 'long (default): chit-chat is skipped');
  assert.equal(shouldRecord(w, 'x'.repeat(300)), true);
  w.settings.autoRecord = 'every';
  assert.equal(shouldRecord(w, '好的'), true);
  w.settings.autoRecord = 'off';
  assert.equal(shouldRecord(w, 'x'.repeat(5000)), false);
});

test('the request carries this chapter’s facts for who appears, and the known names', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '青州城内' }], { chapter: 10 });
  const { req, facts } = autoRequest(w, turn);
  assert.match(req.system, /现在写到第 12 章/);
  assert.match(req.system, /已有名单：沈砚（阿砚）、林晚/);
  assert.ok(facts.some((f) => /沈砚的位置：青州城内/.test(f.text)));
  assert.match(req.user, /【AI 写的正文】\n夜里/);
});

const answer = {
  changes: [
    { subject: '阿砚', key: '伤势', value: '左臂刀伤', op: 'replace', quote: '沈砚被刀锋划过左臂' },
    { subject: '沈砚', key: '持有', value: '林晚的玉佩', op: 'add', quote: '他把林晚的玉佩塞进怀里' },
    { subject: '沈砚', key: '位置', value: '青州城外', op: 'replace', quote: '翻身出了青州城' },
    { subject: '沈砚', key: '心情', value: '低落', op: 'replace', quote: '他心里很难过很难过' }, // 原句不在正文里
    { subject: '顾长风', key: '位置', value: '北境', op: 'replace', quote: '翻身出了青州城' }, // 不认识的人
  ],
  relations: [{ a: '沈砚', b: '林晚', key: '关系', value: '托付信物', quote: '他把林晚的玉佩塞进怀里' }],
  newCharacters: [{ name: '苏九', aliases: ['九娘'], summary: '城外接应的人。', quote: '城外的苏九牵着马等他' }, { name: '路人甲', quote: '编的原句不存在' }],
  newEntries: [{ title: '见血不追', keys: ['见血不追'], content: '北境的规矩：见了血就不再追。', quote: '北境的规矩是见血不追' }],
};

test('verified changes are recorded at once; new people and places wait for confirmation', () => {
  const w = novel();
  const r = applyAuto(w, JSON.stringify(answer), turn);
  assert.equal(r.ok, true);
  assert.deepEqual(r.recorded.map((x) => x.text), ['沈砚·伤势 = 左臂刀伤', '沈砚·持有 + 林晚的玉佩', '沈砚·位置 = 青州城外', '沈砚/林晚·关系 = 托付信物']);
  assert.deepEqual(r.pending.map((x) => x.text), ['新人物：苏九', '新设定：见血不追']);
  assert.equal(r.dropped, 3, 'a quote not in the text, an unknown person, an invented quote');
  assert.deepEqual(at(w, '沈砚', 12), { 伤势: '左臂刀伤', 持有: '林晚的玉佩', 位置: '青州城外' });
  assert.equal(at(w, '沈砚', 11).伤势, undefined, 'from chapter 12, not before');
  const [a, b] = w.characters.map((c) => c.id);
  assert.equal(relationAt(w, a, b, 12)[0].value, '托付信物');
  assert.ok(w.states.every((s) => s.source === 'auto:msg-1' && s.evidence));
  assert.equal(w.characters.length, 2, 'not added before confirmation');
  assert.deepEqual(w.lastAuto, { ...w.lastAuto, sessionId: 's1', turnId: 'msg-1', recorded: 4, pending: 2, chapter: 12 });
  // 同一件事再来一遍：已经是这个值的不再记，已经在待确认的不再提
  const again = applyAuto(w, answer, { ...turn, turnId: 'msg-2' });
  assert.equal(again.recorded.length, 0);
  assert.equal(again.pending.length, 0);
  assert.equal(w.pending.length, 2);
});

test('auto mode takes new people and places in directly', () => {
  const w = novel();
  w.settings.autoAccept = true;
  const r = applyAuto(w, answer, turn);
  assert.deepEqual(r.pending, []);
  assert.ok(r.recorded.some((x) => x.text === '新人物：苏九') && r.recorded.some((x) => x.text === '新设定：见血不追'));
  const su = w.characters.find((c) => c.name === '苏九');
  assert.equal(su.tier, 'side');
  assert.deepEqual(su.aliases, ['九娘']);
  assert.equal(su.card.summary, '城外接应的人。');
});

test('accept / dismiss pending; accepted ones belong to their turn', () => {
  const w = novel();
  applyAuto(w, answer, turn);
  const [pc, pe] = w.pending;
  assert.equal(acceptPending(w, pc.id).accepted, 1);
  assert.ok(w.characters.some((c) => c.name === '苏九' && c.source === 'auto:msg-1'));
  assert.equal(dismissPending(w, pe.id).dismissed, 1);
  assert.equal(w.pending.length, 0);
  assert.deepEqual(acceptPending(w, 'nope').errors, ['找不到这条待确认']);
  // 撤销那一轮：收下的苏九也一起撤
  undoAutoTurn(w, 'msg-1');
  assert.ok(!w.characters.some((c) => c.name === '苏九'));
});

test('undo a turn: its records go, rewritten older ones come back, edited people are kept', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '青州城内' }], { chapter: 12, source: 'tool' });
  w.settings.autoAccept = true;
  applyAuto(w, answer, turn);
  assert.equal(at(w, '沈砚', 12).位置, '青州城外');
  const su = w.characters.find((c) => c.name === '苏九');
  su.updatedAt = su.createdAt + 1; // 作者改过
  const u = undoAutoTurn(w, 'msg-1');
  assert.deepEqual(u.kept, ['苏九']);
  assert.equal(at(w, '沈砚', 12).位置, '青州城内', 'the record it rewrote is back');
  assert.equal(at(w, '沈砚', 12).伤势, undefined);
  assert.ok(!w.lore.some((e) => e.title === '见血不追'));
  assert.equal(w.autoTurns.length, 0);
  assert.equal(w.lastAuto.undone, true);
});

test('regenerated replies: turns whose reply is gone from the conversation are found', () => {
  const w = novel();
  applyAuto(w, answer, turn);
  applyAuto(w, { changes: [{ subject: '林晚', key: '位置', value: '后宅', quote: '城外的苏九牵着马等他' }] }, { ...turn, turnId: 'msg-9', sessionId: 's2' });
  assert.deepEqual(vanishedTurns(w, 's1', ['msg-0', 'msg-1']), []);
  assert.deepEqual(vanishedTurns(w, 's1', ['msg-0', 'msg-3']), ['msg-1']);
  assert.deepEqual(vanishedTurns(w, 's2', ['msg-9']), [], 'other conversations untouched');
});

test('an unreadable answer changes nothing', () => {
  const w = novel();
  assert.equal(applyAuto(w, '不是 JSON', turn).ok, false);
  assert.equal(w.states.length, 0);
});
