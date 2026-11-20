// 设定集的纯逻辑：状态按章节叠、匹配、按预算拼注入、查设定、一致性检查的证据核对、导入导出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCharacter, addEntry, checkFacts, checkReport, compose, emptyWork, lookup, matchCharacters, matchEntries, nextSticky, recordStates, relationAt, roster, stateAt, toWorldbook, verifyCheck } from '../lib/core.mjs';
import { applyImport, cardFromPng, importReport, macros, readImport, undoImport } from '../lib/import.mjs';

function novel() {
  const w = emptyWork({ title: '长夜', now: 1 });
  addCharacter(w, { name: '沈砚', aliases: ['阿砚', '砚'], tier: 'main', card: { summary: '落魄琴师，嘴冷心热。', appearance: '左眉有疤' } }, { now: 1 });
  addCharacter(w, { name: '林晚', tier: 'main', card: { summary: '青州知府之女，暗中替北境传信。' } }, { now: 2 });
  addCharacter(w, { name: '林晚晴', card: { summary: '林晚的堂妹。' } }, { now: 3 });
  addCharacter(w, { name: '北境王', secret: true, card: { summary: '幕后之人。' } }, { now: 4 });
  addCharacter(w, { name: '顾长风', debut: 15, card: { summary: '北境军副将。' } }, { now: 5 });
  addEntry(w, { title: '青州', keys: ['青州'], content: '北境门户，城门入夜即闭，出城要腰牌。' }, { now: 6 });
  return w;
}
const at = (w, name, ch) => Object.fromEntries(stateAt(w, w.characters.find((c) => c.name === name).id, ch).map((s) => [s.key, s.value]));

test('states stack by chapter: replace, add / remove on lists, until, same-chapter rewrite', () => {
  const w = novel();
  let r = recordStates(w, [{ subject: '沈砚', key: '位置', value: '青州城外' }, { subject: '阿砚', key: '持有', value: '断弦琴', op: 'add' }], { chapter: 11, now: 10 });
  assert.equal(r.written.length, 2);
  assert.equal(r.cursorMoved, true);
  assert.equal(w.cursor.chapter, 11);
  recordStates(w, [{ subject: '沈砚', key: '持有', value: '林晚的玉佩', op: 'add' }, { subject: '沈砚', key: '伤势', value: '左臂刀伤', until: 13 }], { chapter: 11, now: 11 });
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '北境军营' }], { chapter: 14, now: 12 });
  recordStates(w, [{ subject: '沈砚', key: '持有', value: '林晚的玉佩', op: 'remove' }], { chapter: 20, now: 13 });
  assert.deepEqual(at(w, '沈砚', 10), {});
  assert.deepEqual(at(w, '沈砚', 12), { 位置: '青州城外', 持有: '断弦琴、林晚的玉佩', 伤势: '左臂刀伤' });
  assert.deepEqual(at(w, '沈砚', 14), { 位置: '北境军营', 持有: '断弦琴、林晚的玉佩' }, 'the wound ended at chapter 13');
  assert.deepEqual(at(w, '沈砚', 20), { 位置: '北境军营', 持有: '断弦琴' });
  // 同一章同一项再写：新的生效，旧的标作废
  r = recordStates(w, [{ subject: '沈砚', key: '位置', value: '北境王帐' }], { chapter: 14, now: 14 });
  assert.equal(r.written[0].replaced, true);
  assert.equal(at(w, '沈砚', 14).位置, '北境王帐');
  // 光标不往回拨
  r = recordStates(w, [{ subject: '林晚', key: '位置', value: '知府后宅' }], { chapter: 3, now: 15 });
  assert.equal(r.cursorMoved, false);
  assert.equal(w.cursor.chapter, 20);
});

test('recording refuses what would corrupt the book, and says why', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '青州' }, { subject: '沈砚', key: '持有', value: '琴', op: 'add' }], { chapter: 1 });
  const r = recordStates(w, [
    { subject: '林婉', key: '位置', value: '后宅' },
    { subject: '沈砚', key: '位置', value: '城外', op: 'add' },
    { subject: '沈砚', key: '持有', value: '剑' },
    { subject: '沈砚', key: '持有', value: '剑', op: 'remove' },
    { subject: '沈砚', key: '', value: 'x' },
  ], { chapter: 2 });
  assert.equal(r.written.length, 0);
  assert.match(r.errors[0], /找不到.*最像的是：林晚/);
  assert.match(r.errors[1], /单值，用 replace/);
  assert.match(r.errors[2], /列表，用 add/);
  assert.match(r.errors[3], /没有「剑」/);
  assert.match(r.errors[4], /都要有/);
  // create：真是新人物
  assert.equal(recordStates(w, [{ subject: '苏九', key: '位置', value: '酒肆' }], { create: true }).written.length, 1);
  assert.ok(w.characters.some((c) => c.name === '苏九' && c.tier === 'side'));
});

test('relations are per pair, by chapter', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚/林晚', key: '关系', value: '互相试探，未表明身份' }], { chapter: 9 });
  recordStates(w, [{ subject: '林晚/阿砚', key: '关系', value: '彼此交底' }], { chapter: 18 });
  const [a, b] = ['沈砚', '林晚'].map((n) => w.characters.find((c) => c.name === n).id);
  assert.equal(relationAt(w, a, b, 10)[0].value, '互相试探，未表明身份');
  assert.equal(relationAt(w, b, a, 18)[0].value, '彼此交底');
  assert.match(recordStates(w, [{ subject: '沈砚/路人', key: '关系', value: '仇' }]).errors[0], /找不到「路人」/);
});

test('matching: longest name wins, single-character aliases and hidden people are ignored', () => {
  const w = novel();
  const names = (t, ch = 20) => matchCharacters(w, t, ch).map((x) => x.c.name);
  assert.deepEqual(names('林晚晴推门进来，阿砚抬头。'), ['林晚晴', '沈砚']);
  assert.deepEqual(names('砚台上落了灰'), [], '「砚」alone is too easy to hit');
  assert.deepEqual(names('北境王的人到了'), [], 'secret people never auto-match');
  assert.deepEqual(names('顾长风来了', 10), [], 'not before their debut');
  assert.deepEqual(names('顾长风来了', 15), ['顾长风']);
  addCharacter(w, { name: 'Alice' });
  assert.deepEqual(names('ALICE waves'), ['Alice']);
});

test('entries: keys, secondary-key logic, chapter range, constants are not "hits"', () => {
  const w = emptyWork({ title: 't' });
  addEntry(w, { title: '腰牌', keys: ['腰牌'], secondaryKeys: ['出城', '城门'], logic: 'and-any', content: '出城凭腰牌。' });
  addEntry(w, { title: '宵禁', keys: ['夜里'], secondaryKeys: ['白天'], logic: 'not-any', content: '入夜宵禁。' });
  addEntry(w, { title: '旧城', keys: ['青州'], content: '城墙完好。', until: 9 });
  addEntry(w, { title: '常驻', keys: ['x'], constant: true, content: '世界观。' });
  const hit = (t, ch = 5) => matchEntries(w, t, ch).map((e) => e.title);
  assert.deepEqual(hit('他摸了摸腰牌'), []);
  assert.deepEqual(hit('他摸了摸腰牌准备出城'), ['腰牌']);
  assert.deepEqual(hit('夜里很冷'), ['宵禁']);
  assert.deepEqual(hit('夜里和白天一样冷'), []);
  assert.deepEqual(hit('青州', 5), ['旧城']);
  assert.deepEqual(hit('青州', 10), [], 'only true up to chapter 9');
  assert.deepEqual(hit('x'), []);
});

test('roster: ≤ 200 chars, main first, hidden and not-yet-debuted left out', () => {
  const w = novel();
  const r = roster(w, 10);
  assert.ok(r.length <= 200, r.length);
  assert.match(r, /^【《长夜》人物】沈砚（阿砚）、林晚、林晚晴。/);
  assert.doesNotMatch(r, /北境王|顾长风/);
  for (let i = 0; i < 40; i++) addCharacter(w, { name: `路人甲${i}号` });
  const big = roster(w, 10);
  assert.ok(big.length <= 200);
  assert.match(big, /等 43 人/);
  assert.equal(roster(emptyWork({ title: 'x' })), '');
});

test('per-turn text: what was mentioned, current state, relations when both are in; whole lines only, within budget', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '青州城外' }, { subject: '沈砚', key: '伤势', value: '左臂刀伤' }, { subject: '沈砚/林晚', key: '关系', value: '互相试探' }], { chapter: 12 });
  const out = compose(w, { latest: '写阿砚在青州城外遇到林晚' });
  assert.match(out.text, /^【设定 · 截至第 12 章】/);
  assert.match(out.text, /- 沈砚（阿砚、砚）：落魄琴师，嘴冷心热。｜伤势：左臂刀伤｜位置：青州城外|- 沈砚（阿砚、砚）：落魄琴师，嘴冷心热。｜位置：青州城外｜伤势：左臂刀伤/);
  assert.match(out.text, /- 林晚：/);
  assert.match(out.text, /- 青州：北境门户/);
  assert.match(out.text, /- 沈砚—林晚：互相试探/);
  assert.ok(out.text.length <= 600);
  assert.deepEqual(out, compose(w, { latest: '写阿砚在青州城外遇到林晚' }), 'deterministic');
  assert.equal(compose(w, { latest: '今天天气不错' }).text, '', 'nothing mentioned → nothing added');
  // 预算紧：整条丢，最后一行列出没放下的名字
  const tight = compose(w, { latest: '阿砚、林晚、林晚晴都在青州', budget: 160 });
  assert.ok(tight.text.length <= 160, tight.text.length);
  assert.match(tight.text, /没放下.*lore_lookup/);
  for (const line of tight.text.split('\n').slice(1, -1)) assert.ok(!line.endsWith('…'));
});

test('per-turn text: the end of the last reply and sticky names count too, after what was said', () => {
  const w = novel();
  const out = compose(w, { latest: '继续写', tail: '……林晚放下茶盏。' });
  assert.match(out.text, /- 林晚：/);
  assert.deepEqual(out.hits.chars, [w.characters[1].id]);
  const s1 = nextSticky(undefined, out.hits);
  const s2 = nextSticky(s1, { chars: [], entries: [] });
  assert.match(compose(w, { latest: '继续', sticky: s2 }).text, /- 林晚：/, 'still there one turn later');
  const s3 = nextSticky(s2, { chars: [], entries: [] });
  assert.equal(s3.chars.size, 0, 'gone after two quiet turns');
});

test('blue entries are capped so they cannot fill the whole budget', () => {
  const w = emptyWork({ title: 't' });
  for (let i = 0; i < 6; i++) addEntry(w, { title: `规则${i}`, keys: [], constant: true, content: '很长的世界观设定'.repeat(8), order: 100 - i });
  const text = compose(w, { latest: '' }).text;
  const blue = text.split('\n').filter((l) => l.startsWith('- 规则')).join('\n');
  assert.ok(blue.length <= 250, blue.length);
  assert.ok(blue.length > 0);
});

test('lookup: full card, state at a past chapter, change history, suggestions, hidden note', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '青州城外', evidence: '他出了城' }], { chapter: 11 });
  recordStates(w, [{ subject: '沈砚', key: '位置', value: '北境军营' }], { chapter: 14 });
  assert.match(lookup(w, '阿砚'), /位置：北境军营（第 14 章起）/);
  assert.match(lookup(w, '沈砚', { chapter: 12 }), /位置：青州城外/);
  assert.match(lookup(w, '沈砚', { chapter: 12 }), /外貌：左眉有疤/);
  assert.match(lookup(w, '沈砚', { history: true }), /第 11 章 位置 = 青州城外（原文：他出了城）[\s\S]*第 14 章 位置 = 北境军营/);
  assert.match(lookup(w, '林婉'), /找不到，最像的是：林晚/);
  assert.match(lookup(w, '北境王'), /隐藏人物/);
  assert.match(lookup(w, '青州'), /城门入夜即闭/);
});

test('check: facts for who appears, local hard rules, and only quotes that are really in the text survive', () => {
  const w = novel();
  recordStates(w, [{ subject: '沈砚', key: '伤势', value: '左臂刀伤' }], { chapter: 11 });
  const text = '沈砚抬起左臂，挥剑如风，毫无滞涩。北境王在帐中冷笑。顾长风策马而来。';
  const f = checkFacts(w, text, 12);
  assert.ok(f.facts.some((x) => /沈砚的伤势：左臂刀伤/.test(x.text)));
  assert.equal(f.hard.length, 2);
  assert.match(f.hard[0].problem, /隐藏人物「北境王」/);
  assert.match(f.hard[1].problem, /「顾长风」第 15 章才登场/);
  assert.equal(f.hard[1].quote, '顾长风策马而来。');
  const wound = f.facts.find((x) => /伤势/.test(x.text)).id;
  const v = verifyCheck(
    JSON.stringify({
      conflicts: [
        { fact: wound, quote: '沈砚抬起左臂， 挥剑如风,毫无滞涩', problem: '左臂有刀伤却挥剑自如' },
        { fact: wound, quote: '他的左臂流着血', problem: '编出来的原文' },
        { fact: 'F99', quote: '沈砚抬起左臂', problem: '编号不存在' },
      ],
      unrecorded: [{ subject: '沈砚', key: '位置', value: '帐外', quote: '短' }],
    }),
    f,
  );
  assert.equal(v.conflicts.length, 1, 'spaces and full/half-width punctuation are ignored when matching quotes');
  assert.equal(v.dropped, 3);
  const report = checkReport({ ...f, ...v });
  assert.match(report, /发现 3 处可能的矛盾/);
  assert.match(report, /另有 3 条因为没有原文证据被丢掉/);
  assert.equal(verifyCheck('不是 JSON', f).ok, false);
});

// ---------- 导入 ----------

const v2card = {
  spec: 'chara_card_v2',
  data: {
    name: '林晚',
    description: '{{char}}是青州知府之女。{{// 作者备注}}',
    personality: '外柔内刚，对{{user}}有戒心。',
    scenario: '{{char}}在后宅。',
    first_mes: '你来了。',
    mes_example: '<START>\n{{char}}: 茶凉了。',
    alternate_greetings: ['a', 'b'],
    system_prompt: '你是林晚',
    extensions: { regex_scripts: [{}, {}], depth_prompt: { prompt: 'x', depth: 4 } },
    character_book: {
      entries: [
        { keys: ['青州'], content: '北境门户。', insertion_order: 50, enabled: true, extensions: { position: 1, depth: 2 } },
        { keys: ['好感'], content: '好感度 {{getvar::favor}}', comment: '好感度', enabled: true },
        { keys: ['腰牌'], secondary_keys: ['出城'], selective: true, content: '@@depth 0\n出城要腰牌。', extensions: { selectiveLogic: 3 }, enabled: true },
      ],
    },
  },
};

test('card import: only lore is taken; instructions, scripts and variable entries are listed as skipped', () => {
  const plan = readImport({ kind: 'card', json: v2card, userName: '我' });
  assert.deepEqual(plan.characters.map((c) => c.name), ['林晚']);
  const c = plan.characters[0];
  assert.equal(c.card.extra, '林晚是青州知府之女。');
  assert.equal(c.card.personality, '外柔内刚，对我有戒心。');
  assert.equal(c.card.voice, '林晚: 茶凉了。');
  assert.equal(c.card.summary, undefined);
  const titles = plan.entries.map((e) => e.title);
  assert.deepEqual(titles, ['场景：林晚', '青州', '腰牌']);
  assert.equal(plan.entries[0].enabled, false, 'scenario comes in switched off');
  const yao = plan.entries[2];
  assert.equal(yao.content, '出城要腰牌。');
  assert.equal(yao.logic, 'and-all');
  assert.deepEqual(yao.st.decorators, ['@@depth 0']);
  assert.deepEqual(plan.entries[1].st, { position: 1, depth: 2 });
  assert.deepEqual(plan.skipped.vars, ['好感度']);
  assert.equal(plan.skipped.scripts, 2);
  assert.deepEqual(plan.skipped.instructions, ['system_prompt', 'first_mes', 'alternate_greetings（2 条）', 'extensions.depth_prompt']);
  const report = importReport(plan);
  assert.match(report, /将导入 1 个人物（林晚）、3 条设定/);
  assert.match(report, /用到变量的设定 1 条：「好感度」/);
  assert.match(report, /没有一句话简介/);
});

function png(chunks) {
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const [type, data] of [...chunks, ['IEND', Buffer.alloc(0)]]) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    parts.push(len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}
const tEXt = (k, v) => ['tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])];

test('PNG cards: the chara text chunk is read; ccv3 wins over chara; a plain image is refused', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  assert.equal(cardFromPng(png([tEXt('chara', b64(v2card))])).data.name, '林晚');
  const v3 = { spec: 'chara_card_v3', data: { ...v2card.data, name: '林晚（v3）', nickname: '晚晚' } };
  const both = png([tEXt('chara', b64(v2card)), tEXt('ccv3', b64(v3))]);
  const plan = readImport({ kind: 'card', png: both });
  assert.equal(plan.characters[0].name, '林晚（v3）');
  assert.deepEqual(plan.characters[0].aliases, ['晚晚']);
  assert.throws(() => cardFromPng(png([])), /没有角色卡数据/);
  assert.throws(() => cardFromPng(Buffer.from('nope')), /不是 PNG/);
});

test('world book import, name clashes, duplicates, undo, export round trip', () => {
  const w = novel();
  const book = { entries: { 0: { key: ['腰牌'], keysecondary: ['出城'], selectiveLogic: 0, comment: '腰牌', content: '{{char}}出城要腰牌。', order: 80 }, 1: { key: [], vectorized: true, comment: '向量条目', content: 'x' } } };
  const plan = readImport({ kind: 'worldbook', json: book, charFallback: '沈砚' });
  assert.equal(plan.entries[0].content, '沈砚出城要腰牌。');
  assert.deepEqual(plan.skipped.vector, ['向量条目']);
  const r = applyImport(w, plan, { jobId: 'j1' });
  assert.equal(r.ok, true);
  assert.equal(applyImport(w, plan, { jobId: 'j2' }).duplicate, true, 'same file twice into the same work is caught');
  // 重名：不选就不写
  const card = readImport({ kind: 'card', json: { ...v2card } });
  assert.deepEqual(applyImport(w, card, { jobId: 'j3' }).conflicts, ['林晚']);
  const merged = applyImport(w, card, { jobId: 'j3', onConflict: 'merge' });
  assert.deepEqual(merged.merged, ['林晚']);
  const lin = w.characters.find((c) => c.name === '林晚');
  assert.equal(lin.card.summary, '青州知府之女，暗中替北境传信。', 'existing fields are kept');
  assert.match(lin.card.personality, /外柔内刚/, 'empty fields are filled');
  // 撤销：只删这次新增的
  const before = w.lore.length;
  assert.equal(undoImport(w, 'j1').removed.entries, 1);
  assert.equal(w.lore.length, before - 1);
  assert.equal(undoImport(w, 'j1').ok, false);
  // 导出成世界书再导回来：条目和人物都在
  const back = readImport({ kind: 'worldbook', json: toWorldbook(w) });
  assert.ok(back.entries.some((e) => e.title === '沈砚' && e.keys.includes('阿砚')));
  assert.ok(back.entries.some((e) => e.title === '青州'));
});

test('macros: char / user replaced, comments dropped, anything else marks the entry', () => {
  assert.deepEqual(macros('{{char}}看着{{USER}}{{// x}}', { char: '甲', user: '乙' }), { text: '甲看着乙', vars: false });
  assert.equal(macros('{{random:a,b}}').vars, true);
  assert.equal(macros('<% if (x) { %>').vars, true);
});
