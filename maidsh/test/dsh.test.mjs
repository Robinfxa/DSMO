// 在真的 cordis 4.1.0（DSH 0.2.2-rc.1 用的版本）里加载三个插件，用假的 systemPrompt / llm 服务和假会话，
// 测单独、组合、第三方接入和总控热插拔。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as core from '../core/lib/index.mjs';
import * as mood from '../mood/lib/index.mjs';
import * as bond from '../bond/lib/index.mjs';

const settle = () => new Promise((r) => setTimeout(r, 30));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));

function host({ feeling = { label: '开心', intensity: 0.9 }, extra = {}, prepareCall = false } = {}) {
  const root = new Context();
  const prompts = new Map();
  const calls = [];
  const sp = {
    context: (o) => (prompts.set(o.name, o), () => prompts.delete(o.name)),
    section: (o) => (prompts.set(o.name, o), () => prompts.delete(o.name)),
  };
  async function* reply(opts) {
    calls.push(opts);
    const merged = opts.system.includes('JSON Schema');
    const body = merged ? { feeling, ...extra } : feeling;
    const text = '```json\n' + JSON.stringify(body) + '\n```';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (let i = 0; i < text.length; i += 7) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 7) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const llm = prepareCall
    ? { prepareCall: async (config, signal, configure) => ({ config: configure(config, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }), stream: reply }) }
    : { stream: reply };
  root.provide('systemPrompt', sp);
  root.provide('llm', llm);
  const text = () =>
    [...prompts.values()]
      .sort((a, b) => a.order - b.order)
      .map((p) => (typeof p.text === 'function' ? p.text({}) : p.text))
      .filter(Boolean)
      .join('\n');
  return { root, prompts, calls, text };
}

const session = (over = {}) => ({
  id: 's1',
  header: {},
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: '系统' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天被夸了，好开心' }] },
    { role: 'assistant', content: [{ type: 'thinking', text: '...' }, { type: 'text', text: '真为你高兴！' }] },
  ],
  ...over,
});
const turnEnd = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } } });

test('mood alone: one small call per turn, mood shows up in the prompt and on disk', async () => {
  const h = host({ prepareCall: true });
  const dir = tmp();
  await h.root.plugin(mood, { dataDir: dir });
  assert.equal(h.text(), '');
  h.root.emit('session/event', session(), turnEnd());
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].reasoningEffort, 'low');
  assert.equal(h.calls[0].provider, 'deepseek-official');
  assert.match(h.calls[0].messages[0].content[0].text, /好开心/);
  assert.match(h.text(), /^你现在的心情：/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'mood.json'), 'utf8')).valence > 0);
});

test('ignored turns: aborted, subagent, or no user text', async () => {
  const h = host();
  await h.root.plugin(mood, { dataDir: tmp() });
  h.root.emit('session/event', session(), turnEnd('aborted'));
  h.root.emit('session/event', session({ header: { origin: 'subagent' } }), turnEnd());
  h.root.emit('session/event', session({ deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] }), turnEnd());
  h.root.emit('session/event', session(), { type: 'assistant/message', data: {} });
  await settle();
  assert.equal(h.calls.length, 0);
});

test('mood + bond without the controller: still one call per turn, both move', async () => {
  const h = host();
  await h.root.plugin(mood, { dataDir: tmp() });
  await h.root.plugin(bond, { dataDir: tmp(), hintChance: 1 });
  for (let i = 0; i < 3; i++) {
    h.root.emit('session/event', session(), turnEnd());
    await settle();
  }
  assert.equal(h.calls.length, 3);
  const b = h.root.get('companionBond').get();
  assert.ok(b.value > 0 && b.streak === 3, JSON.stringify(b));
  assert.ok(h.root.get('companionMood').get().valence > 0);
});

test('bond alone judges for itself', async () => {
  const h = host();
  await h.root.plugin(bond, { dataDir: tmp() });
  h.root.emit('session/event', session(), turnEnd());
  await settle();
  assert.equal(h.calls.length, 1);
  assert.ok(h.root.get('companionBond').get().value > 0);
});

test('full suite + a third-party face: one merged call, one prompt block; unplugging the controller hands control back', async () => {
  const h = host({ extra: { weather: { mentioned: false } } });
  const seen = [];
  const thirdParty = {
    name: 'weather-aspect',
    apply(ctx) {
      ctx.inject(['companion'], (sub) => {
        sub.effect(() =>
          sub.companion.register({
            id: 'weather',
            title: '天气感知',
            analysis: { schema: { type: 'object', properties: { mentioned: { type: 'boolean' } } }, instructions: '用户是否提到天气' },
            onAnalysis: (r, t) => seen.push({ r, feeling: t.feeling }),
            prompt: { order: 500, text: () => '（天气插件在这里）' },
          }),
        );
      });
    },
  };
  await h.root.plugin(mood, { dataDir: tmp() });
  await h.root.plugin(bond, { dataDir: tmp(), hintChance: 1 });
  await h.root.plugin(thirdParty);
  const coreFiber = await h.root.plugin(core, {});
  await settle();

  const svc = h.root.get('companion');
  assert.deepEqual(svc.aspects().map((a) => a.id).sort(), ['bond', 'mood', 'weather']);

  h.root.emit('session/event', session(), turnEnd());
  await settle();
  assert.equal(h.calls.length, 1, 'one merged call');
  assert.match(h.calls[0].system, /"weather"/);
  assert.deepEqual(seen, [{ r: { mentioned: false }, feeling: { label: '开心', intensity: 0.9 } }]);
  assert.equal(h.prompts.get('maidsh:mood').text({}), '', 'faces stay quiet under the controller');
  const block = h.prompts.get('maidsh').text({});
  assert.match(block, /^你现在的心情：[\s\S]*（天气插件在这里）$/);
  assert.equal(svc.state().aspects.find((a) => a.id === 'mood').state.personality.neuroticism, 0.5);

  coreFiber.dispose();
  await settle();
  assert.equal(h.prompts.has('maidsh'), false);
  assert.match(h.prompts.get('maidsh:mood').text({}), /^你现在的心情：/, 'mood speaks for itself again');
  h.root.emit('session/event', session(), turnEnd());
  await settle();
  assert.equal(h.calls.length, 2, 'back to one small call (mood judges, bond follows)');
});

test('the controller alone injects nothing and calls nothing', async () => {
  const h = host();
  await h.root.plugin(core, {});
  h.root.emit('session/event', session(), turnEnd());
  await settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.text(), '');
});

test('config is validated', () => {
  assert.ok(mood.Config['~standard'].validate({ neuroticism: 2 }).issues);
  assert.ok(bond.Config['~standard'].validate({ gain: 'x' }).issues);
  assert.deepEqual(core.Config['~standard'].validate(undefined).value.maxOutputTokens, 600);
});

import * as memory from '../memory/lib/index.mjs';

const memoryAnswer = {
  memory: {
    facts: [{ text: '对方养了一只猫叫团子', cat: 'stable', kw: ['团子', '猫'], quote: '我家团子' }],
    event: { title: '团子', summary: '团子打翻了杯子，对方哭笑不得', at: '2026-11-20', kw: ['团子', '杯子'], salience: 4 },
    cue: '聊团子的糗事，气氛轻松',
  },
};
const catSession = (text) =>
  session({
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      { role: 'assistant', content: [{ type: 'text', text: '哈哈，团子真可爱' }] },
    ],
  });
const assembleWith = (text) => ({ agent: { id: 's1', session: catSession(text) } });

test('memory alone: one call per turn, remembers, and recalls when the topic comes back', async () => {
  const h = host({ extra: memoryAnswer });
  const dir = tmp();
  await h.root.plugin(memory, { dataDir: dir });
  h.root.emit('session/event', catSession('我家团子今天把杯子打翻了'), turnEnd());
  await settle();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].system, /"memory"/);
  const svc = h.root.get('companionMemory');
  assert.equal(svc.facts()[0].cat, 'stable', 'quote found in the user message');
  assert.equal(svc.episodes()[0].feeling.label, '开心');
  // DSH 组装提示时这一轮的话还在收件箱：从 agent/inbox/claimed 里拿
  h.root.emit('agent/inbox/claimed', { agent: { id: 's1' }, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '团子又调皮了' }] }, turn: 2 });
  const text = h.prompts.get('maidsh:memory').text(assembleWith('（上一轮的话）'));
  assert.match(text, /【关于对方】\n- 对方养了一只猫叫团子/);
  assert.match(text, /【此刻想起】\n- 今天，团子打翻了杯子/);
  assert.ok(fs.existsSync(path.join(dir, 'memory.json')));
});

test('full suite with memory: still one merged call; memory sits in the one block after mood', async () => {
  const h = host({ extra: memoryAnswer });
  await h.root.plugin(mood, { dataDir: tmp() });
  await h.root.plugin(bond, { dataDir: tmp() });
  await h.root.plugin(memory, { dataDir: tmp() });
  await h.root.plugin(core, {});
  await settle();
  h.root.emit('session/event', catSession('我家团子今天把杯子打翻了'), turnEnd());
  await settle();
  assert.equal(h.calls.length, 1, 'one merged call for mood + bond + memory');
  assert.match(h.calls[0].system, /"memory"/);
  assert.match(h.calls[0].system, /今天是 \d{4}-\d{2}-\d{2}/);
  assert.equal(h.prompts.get('maidsh:memory').text(assembleWith('团子')), '', 'quiet under the controller');
  const block = h.prompts.get('maidsh').text(assembleWith('团子又调皮了'));
  assert.match(block, /^你现在的心情：[\s\S]*【关于对方】[\s\S]*【此刻想起】/);
  const st = h.root.get('companion').state().aspects.find((a) => a.id === 'memory').state;
  assert.equal(st.facts, 1);
});

test('memory page: add / pin / edit / delete through the same object the routes use', async () => {
  const h = host();
  await h.root.plugin(memory, { dataDir: tmp() });
  const svc = h.root.get('companionMemory');
  const f = svc.remember('对方的生日是 3 月 12 日', { cat: 'identity' });
  assert.equal(f.pinned, true);
  assert.equal(svc.facts().length, 1);
  assert.equal(svc.forget(f.id), true);
  assert.equal(svc.facts().length, 0);
  assert.equal(svc.remember('对方的银行卡密码是 123'), null);
});
