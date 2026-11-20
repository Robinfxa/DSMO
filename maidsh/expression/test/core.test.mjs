import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPRESSION_INSTRUCTIONS, EXPRESSION_SCHEMA, LIMITS, addStyle, emptyExpression, learn, maintain, markUsed, render, select, weight } from '../lib/core.mjs';
import { createExpression } from '../lib/aspect.mjs';
import { normalizeAspect } from '../../core/lib/core.mjs';

const D = 24 * 3_600_000;
const T0 = new Date(2026, 10, 20, 12).getTime();

const seed = (st) => {
  const user = '哼那还用说 小狗勾来啦 嘿嘿嘿 你个笨蛋 呜呜呜 好耶 绝绝子';
  for (const [when, say, tone] of [
    ['被夸', '哼那还用说', 'playful'],
    ['撒娇', '小狗勾来啦', 'playful'],
    ['开心', '嘿嘿嘿', 'soft'],
    ['被逗', '你个笨蛋', 'soft'],
    ['委屈', '呜呜呜', 'soft'],
    ['成功', '好耶', 'neutral'],
  ])
    addStyle(st, { when, say, tone }, { now: T0, user });
};

test('learns only what she actually said, mirrors repeats, merges near-duplicates', () => {
  const st = emptyExpression();
  learn(st, { learn: [{ when: '被夸的时候', say: '哼，那还用说', tone: 'playful' }, { when: '编的', say: '她根本没说过这句' }] }, { now: T0, user: '哼，那还用说！' });
  assert.equal(st.items.length, 1);
  learn(st, { learn: [{ when: '被表扬', say: '哼 那还用说', tone: 'playful' }] }, { now: T0 + D, user: '哼 那还用说' });
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].n, 2);
  assert.deepEqual(st.items[0].when, ['被夸的时候', '被表扬']);
  learn(st, { slang: [{ word: '小狗勾', means: '撒娇时对自己的称呼' }] }, { now: T0, user: '小狗勾饿了' });
  assert.equal(st.items.find((x) => x.kind === 'slang').means, '撒娇时对自己的称呼');
  learn(st, { learn: [{ when: '告诉密码', say: '密码是123456' }] }, { now: T0, user: '密码是123456' });
  assert.equal(st.items.length, 2);
});

test('fades by half in three weeks; feedback moves it', () => {
  const st = emptyExpression();
  const x = addStyle(st, { when: '被夸', say: '哼那还用说' }, { now: T0, user: '哼那还用说' });
  assert.ok(Math.abs(weight(x, T0 + 21 * D) - 0.5) < 0.01);
  st.lastInjected = [x.id];
  learn(st, { landed: 1 }, { now: T0 });
  assert.equal(x.w, 0.3);
  maintain(st, T0 + 200 * D);
  assert.equal(st.items.length, 1, 'w keeps it');
  x.w = 0;
  maintain(st, T0 + 200 * D);
  assert.equal(st.items.length, 0);
});

test('follows the relationship: understand slang early, borrow phrases when close, playful only when 暧昧', () => {
  const st = emptyExpression();
  seed(st);
  learn(st, { slang: [{ word: '小狗勾', means: '撒娇时对自己的称呼' }] }, { now: T0, user: '小狗勾' });
  const r = () => 0.5;
  const far = select(st, { latest: '小狗勾回来啦', now: T0, bondLevel: 2, random: r });
  assert.equal(far.style.length, 0);
  assert.equal(far.slang[0].say, '小狗勾');
  const close = select(st, { latest: '今天被老板夸了', now: T0, bondLevel: 3, random: r });
  assert.equal(close.style.length, 2);
  assert.ok(close.style.every((x) => x.tone !== 'playful'));
  const intimate = select(st, { latest: '今天被老板夸了', now: T0, bondLevel: 5, random: r });
  assert.equal(intimate.style[0].say, '哼那还用说', 'the situation matches');
  assert.ok(select(st, { latest: '今天被老板夸了', now: T0, bondLevel: 5, moodValence: -0.6, random: r }).style.every((x) => x.tone !== 'playful'));
});

test('quiet until it knows her; no repeats within 3 turns; fits 150 chars', () => {
  const st = emptyExpression();
  addStyle(st, { when: '被夸', say: '哼那还用说' }, { now: T0, user: '哼那还用说' });
  assert.deepEqual(select(st, { now: T0, bondLevel: 5 }), { slang: [], style: [] });
  seed(st);
  const picked = select(st, { latest: '被夸了', now: T0, bondLevel: 5, random: () => 0.5 });
  const { text, used } = render(picked);
  assert.match(text, /^对方说话的小习惯（和人设不冲突时可以自然借用，不必每句都用）：\n- 被夸的时候，对方会说「哼那还用说」/);
  assert.ok(text.length <= LIMITS.budget);
  markUsed(st, used);
  assert.ok(!select(st, { latest: '被夸了', now: T0, bondLevel: 5, random: () => 0.5 }).style.some((x) => used.includes(x)));
  assert.equal(render({}).text, '');
});

test('aspect: same text within a turn, batch import counts and undo', () => {
  let v = null;
  const ex = createExpression({ store: { load: () => v, save: (x) => (v = JSON.parse(JSON.stringify(x))) }, now: () => T0, bondLevel: () => 5, random: () => 0.4 });
  const n = ex.batchApply(
    { learn: [{ when: '被夸', say: '哼那还用说', tone: 'soft' }, { when: '撒娇', say: '抱抱嘛' }, { when: '没说过', say: '不存在的话' }], slang: [{ word: '小狗勾', means: '撒娇时的自称' }] },
    { jobId: 'job1', userText: '哼那还用说……抱抱嘛' },
  );
  assert.equal(n, 3);
  assert.ok(ex.service.list().every((x) => x.jobId === 'job1' && x.freshUntil > T0));
  ex.undoJob('job1');
  assert.equal(ex.service.list().length, 0);
  assert.equal(ex.compose('x'), ex.compose('x'));
});

test('the analysis contract fits the controller’s limits', () => {
  assert.ok(EXPRESSION_INSTRUCTIONS.length <= 300, `${EXPRESSION_INSTRUCTIONS.length}`);
  assert.deepEqual(normalizeAspect({ id: 'expression', analysis: { schema: EXPRESSION_SCHEMA, instructions: EXPRESSION_INSTRUCTIONS } }).errors, []);
});
