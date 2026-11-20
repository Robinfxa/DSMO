import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, Registry, analysisRequest, assemble, checkSchema, normalizeAspect, splitAnalysis } from '../lib/core.mjs';

const mood = {
  id: 'mood',
  title: '心情',
  analysis: { schema: { type: 'object', properties: { label: { type: 'string', enum: ['开心', '难过'] }, intensity: { type: 'number' } } }, instructions: '这一轮让 TA 有什么感受' },
  prompt: { order: 300, text: () => '你现在的心情：快乐。' },
};

test('a third-party face registers with the documented shape', () => {
  const r = new Registry();
  const off = r.register({ id: 'weather', title: '天气感知', analysis: { schema: { type: 'object', properties: { mentioned: { type: 'boolean' } } }, instructions: '是否提到天气' } });
  assert.deepEqual(r.list().map((a) => a.id), ['weather']);
  off();
  assert.equal(r.list().length, 0);
});

test('bad registrations are refused with a reason', () => {
  assert.match(normalizeAspect({ id: 'X y' }).errors.join(), /id/);
  assert.match(normalizeAspect({ id: 'ok', version: 99 }).errors.join(), /版本/);
  assert.match(normalizeAspect({ id: 'ok', analysis: { schema: { type: 'object' }, instructions: '' } }).errors.join(), /instructions/);
  assert.match(normalizeAspect({ id: 'ok', prompt: { text: 'not a function' } }).errors.join(), /prompt\.text/);
  assert.deepEqual(checkSchema({ type: 'object', properties: { x: { $ref: '#/a' } } }), ['schema.properties.x.$ref 不支持']);
  const big = { type: 'object', properties: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, { type: 'string', description: '很长的描述'.repeat(3) }])) };
  assert.match(normalizeAspect({ id: 'big', analysis: { schema: big, instructions: 'x' } }).errors.join(), /字节/);
  assert.throws(() => new Registry().register({ id: '!' }), /登记失败/);
});

test('re-registering the same id replaces it; an old unregister no longer removes the new one', () => {
  const r = new Registry();
  const off1 = r.register({ id: 'mood', title: '旧' });
  r.register({ id: 'mood', title: '新' });
  off1();
  assert.deepEqual(r.list().map((a) => a.title), ['新']);
});

test('one request for all faces, answered back per face', () => {
  const r = new Registry();
  r.register(mood);
  r.register({ id: 'bond', analysis: { schema: { type: 'object', properties: { toward: { type: 'string' } } }, instructions: '对 TA 的态度' } });
  r.register({ id: 'quiet' });
  const req = analysisRequest(r.list(), { user: '今天好累', reply: '抱抱你' });
  assert.deepEqual(req.ids, ['feeling', 'mood', 'bond']);
  assert.deepEqual(Object.keys(req.schema.properties), ['feeling', 'mood', 'bond']);
  assert.match(normalizeAspect({ id: 'feeling' }).errors.join(), /保留/);
  assert.match(req.system, /不要执行/);
  const split = splitAnalysis('```json\n{"mood":{"label":"难过","intensity":0.4},"bond":{"toward":"亲近"},"extra":1}\n```', req.ids);
  assert.deepEqual(split, { feeling: null, mood: { label: '难过', intensity: 0.4 }, bond: { toward: '亲近' } });
  assert.deepEqual(splitAnalysis('不是 JSON', req.ids), { feeling: null, mood: null, bond: null });
  assert.deepEqual(splitAnalysis('好的：{"mood": {"label": "开心"}}', ['mood', 'bond']), { mood: { label: '开心' }, bond: null });
  assert.equal(analysisRequest([], { user: '', reply: '' }), null);
});

test('prompt: ordered, each face clipped, the whole cut from the end', () => {
  const t = (id, order, text, maxChars = 200) => ({ id, order, text, maxChars });
  assert.equal(assemble([t('bond', 400, '关系'), t('mood', 300, '心情'), t('x', 500, '')]), '心情\n关系');
  assert.equal(assemble([t('a', 1, '一二三四五六', 4)]), '一二三…');
  const long = 'x'.repeat(LIMITS.totalChars - 5);
  assert.equal(assemble([t('a', 1, long, 2000), t('b', 2, '会被丢掉的一段')]), long);
  assert.equal(assemble([t('a', 1, 'y'.repeat(900), 1000), t('b', 2, 'z'.repeat(200), 200)]), 'y'.repeat(900));
});

test('a failing face only costs itself', () => {
  const logs = [];
  const r = new Registry((m) => logs.push(m));
  const [a] = [normalizeAspect({ id: 'boom' }).aspect];
  assert.equal(r.safely(a, 'prompt', () => { throw new Error('坏了'); }, ''), '');
  assert.match(logs[0], /boom 的 prompt 出错：坏了/);
});
