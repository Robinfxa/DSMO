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
  const coreFiber = await h.root.plugin(core, { dataDir: tmp() });
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
  await h.root.plugin(core, { dataDir: tmp() });
  h.root.emit('session/event', session(), turnEnd());
  await settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.text(), '');
});

test('config is validated', () => {
  assert.ok(mood.Config['~standard'].validate({ neuroticism: 2 }).issues);
  assert.ok(bond.Config['~standard'].validate({ gain: 'x' }).issues);
  assert.deepEqual(core.Config['~standard'].validate(undefined).value.maxOutputTokens, 1500);
});

import * as memory from '../memory/lib/index.mjs';

const memoryAnswer = {
  memory: {
    facts: [{ text: '对方养了一只猫叫团子', cat: 'stable', kw: ['团子', '猫'], quote: '我家团子' }],
    event: { title: '团子', summary: '团子打翻了杯子，对方哭笑不得', at: new Date().toLocaleDateString('sv'), kw: ['团子', '杯子'], salience: 4 },
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
  await h.root.plugin(core, { dataDir: tmp() });
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

import * as expression from '../expression/lib/index.mjs';
import * as initiative from '../initiative/lib/index.mjs';

test('expression joins the one merged call; standalone it judges for itself', async () => {
  const h = host({ extra: { expression: { learn: [{ when: '被夸', say: '哼那还用说', tone: 'playful' }], slang: [], landed: 0 } } });
  await h.root.plugin(expression, { dataDir: tmp() });
  const said = (text) => session({ deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: '嘻嘻' }] }] });
  h.root.emit('session/event', said('哼那还用说，我最厉害'), turnEnd());
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.root.get('companionExpression').list()[0].say, '哼那还用说');
  await h.root.plugin(core, { dataDir: tmp() });
  await settle();
  h.root.emit('session/event', said('哼那还用说'), turnEnd());
  await settle();
  assert.equal(h.calls.length, 2, 'one more call: the merged one');
  assert.match(h.calls[1].system, /"expression"/);
  assert.equal(h.root.get('companionExpression').list()[0].n, 2);
});

test('initiative: speaks first at the random moment with a hidden message; that turn is not analysed as hers', async (t) => {
  const T = new Date(2026, 10, 20, 10).getTime();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: T });
  const h = host();
  const sent = [];
  const agent = { id: 's1', status: 'idle', followup: (m) => sent.push(m) };
  h.root.provide('agents', { get: (id) => (id === 's1' ? agent : undefined) });
  const dir = tmp();
  await h.root.plugin(mood, { dataDir: tmp() });
  await h.root.plugin(initiative, { dataDir: dir });
  await h.root.plugin(core, { dataDir: tmp() });
  await settle();
  h.root.emit('session/event', session(), turnEnd());
  await settle();
  const calls = h.calls.length;
  const svc = h.root.get('companionInitiative');
  const next = svc.state().nextAt;
  assert.ok(next >= T + 2 * 3_600_000, 'not right after chatting');
  t.mock.timers.setTime(next + 60_000);
  const plan = await svc.check();
  assert.equal(plan.kind, 'random');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].source.kind, 'maidsh-initiative');
  assert.match(sent[0].content[0].text, /这不是对方发来的消息/);
  assert.ok(Object.isFrozen(sent[0]) && sent[0].id);
  assert.equal(svc.state().today, 1);
  // TA 主动的那一轮结束：总控不分析、不算对方说的话
  const initiated = session({
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天被夸了' }] },
      { role: 'assistant', content: [{ type: 'text', text: '真棒' }] },
      sent[0],
      { role: 'assistant', content: [{ type: 'text', text: '在干嘛呀' }] },
    ],
  });
  h.root.emit('session/event', initiated, turnEnd());
  await settle();
  assert.equal(h.calls.length, calls, 'no analysis for the turn she did not start');
  assert.equal(await svc.check(), null, 'waits for her reply before trying again');
  t.mock.timers.reset();
});

test('import and deep learning run through the controller: one call per chunk, memory and expression together, undo', async () => {
  const h = host({
    extra: {
      memory: { facts: [{ text: '对方叫小林，是护士', cat: 'identity', kw: ['小林', '护士'], quote: '我是护士' }], episodes: [{ summary: '你们第一次聊到深夜', at: '2026-11-01', kw: ['深夜'], salience: 6 }] },
      expression: { learn: [{ when: '撒娇', say: '抱抱嘛', tone: 'soft' }], slang: [] },
    },
  });
  h.root.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) });
  await h.root.plugin(memory, { dataDir: tmp() });
  await h.root.plugin(expression, { dataDir: tmp() });
  await h.root.plugin(core, { dataDir: tmp() });
  await settle();
  const svc = h.root.get('companion');
  const dry = await svc.learn({ textType: 'aboutme', text: '我叫小林，是护士。', dryRun: true });
  assert.equal(dry.value.est.calls, 2);
  assert.equal(h.calls.length, 0, 'a dry run costs nothing');
  const r = await svc.learn({ textType: 'aboutme', title: '自我介绍', text: '我叫小林，是护士。' });
  assert.equal(r.ok, true);
  for (let i = 0; i < 20 && svc.jobs()[0].status !== 'done'; i++) await settle();
  assert.equal(svc.jobs()[0].status, 'done');
  assert.match(h.calls[0].system, /关于对方的介绍/);
  assert.doesNotMatch(h.calls[0].system, /"expression"/, 'expression sits out an about-me text');
  const facts = h.root.get('companionMemory').facts();
  assert.ok(facts[0].pinned && facts[0].jobId);
  // 深度学习一段对话：记忆和表达一起学（表达只认她的原话）
  const s = await svc.learn({ kind: 'session', messages: [{ role: 'user', text: '我是护士，抱抱嘛', at: Date.now() }, { role: 'assistant', text: '抱抱你' }] });
  for (let i = 0; i < 20 && svc.jobs().at(-1).status !== 'done'; i++) await settle();
  assert.equal(svc.jobs().at(-1).status, 'done');
  const call = h.calls.find((c) => /你们的一段对话/.test(c.system));
  assert.match(call.system, /"memory"[\s\S]*"expression"/);
  assert.equal(h.root.get('companionExpression').list()[0].say, '抱抱嘛');
  svc.job('undo', s.value.id);
  assert.equal(h.root.get('companionExpression').list().length, 0);
});

test('no model known yet: the import stops at once with a clear reason', async () => {
  const h = host();
  await h.root.plugin(memory, { dataDir: tmp() });
  await h.root.plugin(core, { dataDir: tmp() });
  await settle();
  const svc = h.root.get('companion');
  await svc.learn({ textType: 'aboutme', text: '我叫小林。' });
  for (let i = 0; i < 10 && svc.jobs()[0].status === 'running'; i++) await settle();
  assert.equal(svc.jobs()[0].status, 'failed');
  assert.match(svc.jobs()[0].error, /先在 DSMO 里聊一句/);
});

test('DSH context messages (skill catalog, time) inside a turn do not hide who started it', async () => {
  const h = host();
  await h.root.plugin(mood, { dataDir: tmp() });
  const firstTurn = session({
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天被夸了' }] },
      { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'ctx' }] },
      { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: 'skills' }] },
      { role: 'user', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'time' }] },
      { role: 'assistant', content: [{ type: 'text', text: '真棒' }] },
    ],
  });
  h.root.emit('session/event', firstTurn, turnEnd());
  await settle();
  assert.equal(h.calls.length, 1);
});

test('scope: switched-off and Bot conversations get no analysis, no injection, and no initiative', async (t) => {
  const T = new Date(2026, 10, 20, 10).getTime();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: T });
  const h = host();
  const sent = [];
  h.root.provide('agents', { get: (id) => ({ id, status: 'idle', followup: (m) => sent.push([id, m]) }) });
  await h.root.plugin(mood, { dataDir: tmp() });
  await h.root.plugin(initiative, { dataDir: tmp() });
  await h.root.plugin(core, { dataDir: tmp() });
  await settle();
  const svc = h.root.get('companion');
  const ac = (id) => ({ agent: { id, session: session({ id }) } });
  // 先在一个陪伴对话里聊一轮，让心情有内容
  h.root.emit('session/event', session({ id: 'chat' }), turnEnd());
  await settle();
  assert.equal(h.calls.length, 1);
  assert.match(h.prompts.get('maidsh').text(ac('chat')), /你现在的心情/);
  // 你关掉一个工作对话；DSMO 同步过来一个 Bot 对话
  svc.setScope('work', false);
  svc.setBotSessions(['bot-1']);
  const so = svc.scopeOf('bot-1');
  assert.deepEqual({ sessionId: so.sessionId, enabled: so.enabled, bot: so.bot, off: so.off, profile: so.profile, from: so.from }, { sessionId: 'bot-1', enabled: false, bot: true, off: false, profile: null, from: 'bot' });
  for (const id of ['work', 'bot-1']) {
    assert.equal(h.prompts.get('maidsh').text(ac(id)), '', `no injection in ${id}`);
    h.root.emit('session/event', session({ id }), turnEnd());
  }
  await settle();
  assert.equal(h.calls.length, 1, 'no analysis in work or bot conversations');
  // 主动只认生效的对话：最后在工作对话里聊过，TA 还是去陪伴对话找你
  const ini = h.root.get('companionInitiative');
  t.mock.timers.setTime(ini.state().nextAt + 60_000);
  await ini.check();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'chat');
  // 陪伴对话后来被关掉：不在那里主动
  svc.setScope('work', true);
  svc.setScope('chat', false);
  assert.equal(svc.inScope('work'), true);
  t.mock.timers.reset();
});
