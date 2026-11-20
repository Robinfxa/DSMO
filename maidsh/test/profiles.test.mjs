// 档案和生效范围（CONTRACT.md §13）：归属规则、迁移、每个档案各自的数据、删档案、主动的次数合计。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as core from '../core/lib/index.mjs';
import * as mood from '../mood/lib/index.mjs';
import * as bond from '../bond/lib/index.mjs';
import * as memory from '../memory/lib/index.mjs';
import * as expression from '../expression/lib/index.mjs';
import * as initiative from '../initiative/lib/index.mjs';
import { createScope, migrate } from '../core/lib/scope.mjs';
import { createCompanion } from '../core/lib/runtime.mjs';
import { createJobs } from '../core/lib/jobs.mjs';
import { emptyInitiative, due, onInitiated, onUserTurn } from '../initiative/lib/core.mjs';
import { profileDir, profileId, requestedProfile } from '../shared/profiles.mjs';

const settle = () => new Promise((r) => setTimeout(r, 30));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maidsh-profiles-'));
const memStore = (init = null) => {
  let v = init;
  return { load: () => v, save: (x) => (v = JSON.parse(JSON.stringify(x))), peek: () => v };
};

// ---------- 归属规则 ----------

test('resolution: conversation > workspace > default; Bot always off; unknown session follows the default', () => {
  const ws = { c1: 'w-novel', c2: 'w-novel', c3: 'w-work' };
  const s = createScope({ store: memStore(), workspaceOf: (id) => ws[id] ?? '' });
  const shen = s.create({ name: '沈砚', persona: '沈砚' }).value;
  assert.deepEqual(s.resolve('c9'), { profile: 'default', from: 'default', workspaceId: '' });
  assert.equal(s.setWorkspace('w-novel', shen.id), true);
  assert.equal(s.setWorkspace('w-work', 'off'), true);
  assert.deepEqual(s.resolve('c1'), { profile: shen.id, from: 'workspace', workspaceId: 'w-novel' });
  assert.equal(s.resolve('c3').profile, null);
  // 工作区里某一段单独设成默认档案；另一段单独关掉
  s.setConversation('c2', 'default');
  s.setConversation('c1', 'off');
  assert.deepEqual(s.resolve('c2'), { profile: 'default', from: 'conversation', workspaceId: 'w-novel' });
  assert.equal(s.inScope('c1'), false);
  // 跟随上一层
  s.setConversation('c1', null);
  assert.equal(s.profileOf('c1'), shen.id);
  // Bot 压过一切
  s.setConversation('b1', shen.id);
  s.setBots(['b1']);
  assert.deepEqual(s.resolve('b1'), { profile: null, from: 'bot', workspaceId: '' });
  // 默认关：没设过的对话都关；不知道是哪个对话时也按默认
  s.setDefault('off');
  assert.equal(s.profileOf('c9'), null);
  assert.equal(s.profileOf(''), null);
  assert.equal(s.profileOf('c1'), shen.id, 'the workspace still wins over the default');
  // 不存在的档案、乱填的值不收
  assert.equal(s.setConversation('c1', 'nope'), false);
  assert.equal(s.setWorkspace('w-x', '../x'), false);
  assert.equal(s.setDefault(null), false);
});

test('a workspace registry that throws or is missing just means "no workspace"', () => {
  const s = createScope({ store: memStore(), workspaceOf: () => {
    throw new Error('registry not ready');
  } });
  assert.deepEqual(s.resolve('c1'), { profile: 'default', from: 'default', workspaceId: '' });
  const finder = core.workspaceFinder({ get: (n) => (n === 'workspaceRegistry' ? { list: () => [{ id: 'w1', sessionIds: ['a'] }, { id: 'w2', sessionIds: ['b'] }] } : undefined) });
  assert.equal(finder('b'), 'w2');
  assert.equal(finder('z'), '');
  assert.equal(core.workspaceFinder({ get: () => undefined })('a'), '');
});

test('migration: §12 switched-off conversations become "conversation = off"; nothing else changes', () => {
  const st = migrate({ v: 1, mode: 'all', off: ['x', 'y'], bots: ['b'] }, 1);
  assert.deepEqual(st.conversations, { x: 'off', y: 'off' });
  assert.deepEqual(st.bots, ['b']);
  assert.equal(st.default, 'default');
  assert.deepEqual(st.profiles.map((p) => p.id), ['default']);
  const store = memStore({ v: 1, mode: 'all', off: ['x'], bots: [] });
  const s = createScope({ store });
  assert.equal(s.inScope('x'), false);
  assert.deepEqual(s.view().off, ['x'], 'the old frontend still reads its off list');
  // §12 的旧开关：打开只去掉「关」
  s.set('x', true);
  assert.equal(s.inScope('x'), true);
  s.set('x', false);
  assert.equal(store.peek().v, 2);
  assert.deepEqual(store.peek().conversations, { x: 'off' });
});

test('profiles: create, rename, link a persona, limits, delete falls back a layer', () => {
  const s = createScope({ store: memStore(), workspaceOf: () => 'w1' });
  assert.equal(s.create({ name: '  ' }).ok, false);
  const a = s.create({ name: '沈砚' }).value;
  assert.match(a.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(s.create({ name: '沈砚' }).ok, false, 'names are unique');
  assert.equal(s.rename(a.id, '沈 砚').value.name, '沈 砚');
  assert.equal(s.linkPersona(a.id, '冷面师兄').value.persona, '冷面师兄');
  for (let i = 0; s.profiles().length < 20; i++) assert.equal(s.create({ name: `档案${i}` }).ok, true);
  assert.equal(s.create({ name: '再多一个' }).ok, false);
  s.setWorkspace('w1', a.id);
  s.setConversation('c1', a.id);
  s.setDefault(a.id);
  assert.equal(s.remove('default').ok, false);
  assert.equal(s.remove(a.id).ok, true);
  assert.deepEqual(s.resolve('c1'), { profile: 'default', from: 'default', workspaceId: 'w1' }, 'conversation, workspace and default all fall back');
  assert.equal(s.remove(a.id).ok, false);
});

test('profile ids from outside never escape the data folder', () => {
  assert.equal(profileId('../../etc'), 'default');
  assert.equal(profileId(undefined), 'default');
  assert.equal(profileDir('/d', '../x'), '/d');
  assert.equal(profileDir('/d', 'p1'), path.join('/d', 'profiles', 'p1'));
  const ctx = { get: (n) => (n === 'companion' ? { profiles: () => [{ id: 'default' }, { id: 'p1' }] } : undefined) };
  assert.equal(requestedProfile(ctx, { url: '/x?profile=p1' }), 'p1');
  assert.equal(requestedProfile(ctx, { url: '/x?profile=p2' }), null, 'unknown profile');
  assert.equal(requestedProfile(ctx, { url: '/x' }, { profile: 'p1' }), 'p1');
  assert.equal(requestedProfile(ctx, { url: '/x?profile=..%2F' }), null);
  assert.equal(requestedProfile({ get: () => undefined }, { url: '/x?profile=p1' }), null, 'no controller: only the default profile');
  assert.equal(requestedProfile({ get: () => undefined }, { url: '/x' }), 'default');
});

// ---------- 总控运行部分 ----------

test('runtime: each profile keeps its own last feeling; aspects get turn.profile, state(profile) and dropProfile', async () => {
  const seen = [];
  const dropped = [];
  let n = 0;
  const c = createCompanion({ complete: async () => JSON.stringify({ feeling: { label: n++ ? '难过' : '开心', intensity: 0.8 } }), random: () => 0.5 });
  c.register({
    id: 'probe',
    version: 2,
    analysis: { schema: { type: 'object' }, instructions: '随便' },
    onAnalysis: (_r, turn) => seen.push([turn.profile, turn.feeling?.label]),
    prompt: { order: 1, text: (turn) => `档案=${turn.profile}，感受=${turn.feeling?.label ?? '无'}` },
    state: (profile) => ({ profile }),
    dropProfile: (p) => dropped.push(p),
  });
  // v1 的面照旧能登记（它只有一份数据，所有档案共用）
  assert.equal(typeof c.register({ id: 'legacy', version: 1, prompt: { order: 2, text: () => '老面' } }), 'function');
  await c.afterTurn({ sessionId: 'a', profile: 'default', user: '嗨', reply: '嗨' });
  await c.afterTurn({ sessionId: 'b', profile: 'p1', user: '嗨', reply: '嗨' });
  assert.deepEqual(seen, [['default', '开心'], ['p1', '难过']]);
  assert.match(c.promptText('', 'default'), /档案=default，感受=开心/);
  assert.match(c.promptText('', 'p1'), /档案=p1，感受=难过/);
  assert.match(c.promptText('', 'p2'), /档案=p2，感受=无/);
  assert.match(c.promptText('', 'p2'), /老面/);
  assert.deepEqual(c.state('p1').aspects.find((a) => a.id === 'probe').state, { profile: 'p1' });
  assert.equal(c.state('p1').lastFeeling.label, '难过');
  c.dropProfile('p1');
  c.dropProfile('default');
  assert.deepEqual(dropped, ['p1'], 'the default profile is never dropped');
});

test('runtime: while one turn is analysed, each profile keeps only its newest queued turn', async () => {
  const users = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const c = createCompanion({
    complete: async (req) => {
      users.push(req.user.match(/【用户】\n(.*)/)[1]);
      if (users.length === 1) await gate;
      return '{}';
    },
  });
  c.register({ id: 'probe', analysis: { schema: { type: 'object' }, instructions: '随便' } });
  const first = c.afterTurn({ sessionId: 'a', profile: 'default', user: 'a1', reply: '' });
  c.afterTurn({ sessionId: 'a', profile: 'default', user: 'a2', reply: '' });
  c.afterTurn({ sessionId: 'b', profile: 'p1', user: 'b1', reply: '' });
  c.afterTurn({ sessionId: 'a', profile: 'default', user: 'a3', reply: '' });
  release();
  await first;
  await c.idle();
  assert.deepEqual(users, ['a1', 'a3', 'b1']);
});

test('jobs: learning goes to the conversation’s profile unless one is picked; deleting a profile cancels its jobs', async () => {
  const applied = [];
  const aspect = { id: 'memory', batch: { schema: { type: 'object' }, instructions: () => '学', apply: (_r, chunk) => (applied.push(chunk.profile), 1), undo: (jobId, profile) => applied.push(`undo ${profile}`) } };
  const profiles = { s1: 'p1', off: null };
  let hold = true;
  const jobs = createJobs({
    store: memStore(),
    aspects: () => [aspect],
    safely: (_a, _w, run, fb) => {
      try {
        return run();
      } catch {
        return fb;
      }
    },
    complete: async () => {
      while (hold) await settle();
      return JSON.stringify({ memory: {} });
    },
    readSession: async () => [{ role: 'user', text: '你好' }],
    profileFor: ({ profile, sessionId }) => (profile ? (['default', 'p1', 'p2'].includes(profile) ? profile : undefined) : sessionId in profiles ? profiles[sessionId] : 'default'),
  });
  assert.equal((await jobs.learn({ kind: 'session', sessionId: 'off' })).error, '这段对话关着陪伴：请先选一个档案再学');
  assert.equal((await jobs.learn({ textType: 'aboutme', text: '我', profile: 'zz' })).error, '找不到这个档案');
  const a = (await jobs.learn({ kind: 'session', sessionId: 's1' })).value;
  const b = (await jobs.learn({ textType: 'aboutme', text: '我是护士', profile: 'p2' })).value;
  assert.equal(a.profile, 'p1');
  assert.equal(b.profile, 'p2');
  assert.equal(jobs.dropProfile('p2'), 1);
  hold = false;
  await jobs.idle();
  assert.deepEqual(applied, ['p1']);
  assert.equal(jobs.list().find((j) => j.id === b.id).status, 'cancelled');
  jobs.act('undo', a.id);
  assert.deepEqual(applied, ['p1', 'undo p1']);
  // 同一份材料学进另一个档案不算重复
  const again = await jobs.learn({ kind: 'session', sessionId: 's1', profile: 'p2' });
  assert.equal(again.ok, true);
});

// ---------- 主动：次数合计 ----------

test('initiative: the daily cap is shared by all profiles', () => {
  const T = new Date(2026, 10, 20, 9).getTime();
  const o = { perDay: 2, minGapHours: 1, afterChatHours: 0, spreadHours: 1, quietStart: '23:30', quietEnd: '08:00', stopAfterIgnored: 2, graceHours: 2 };
  const daily = { day: '', count: 0 };
  const a = emptyInitiative();
  const b = emptyInitiative();
  onUserTurn(a, { now: T, sessionId: 'sa', o, daily, random: () => 0 });
  onUserTurn(b, { now: T, sessionId: 'sb', o, daily, random: () => 0 });
  const later = T + 3 * 3_600_000;
  onInitiated(a, later, { kind: 'random', sessionId: 'sa' }, { o, daily, random: () => 0 });
  a.pending = null;
  onInitiated(b, later, { kind: 'random', sessionId: 'sb' }, { o, daily, random: () => 0 });
  b.pending = null;
  assert.equal(daily.count, 2);
  const c = emptyInitiative();
  onUserTurn(c, { now: T, sessionId: 'sc', o, daily, random: () => 0 });
  c.nextAt = later;
  assert.equal(due(c, later + 60_000, { o, daily }), null, 'a third profile does not get a third message today');
  assert.notEqual(due(c, later + 60_000, { o }), null, 'on its own count it would have');
});

// ---------- 整套插件在 cordis 里 ----------

function host({ extra = {} } = {}) {
  const root = new Context();
  const prompts = new Map();
  const calls = [];
  root.provide('systemPrompt', { context: (o) => (prompts.set(o.name, o), () => prompts.delete(o.name)), section: (o) => (prompts.set(o.name, o), () => prompts.delete(o.name)) });
  root.provide('llm', {
    async *stream(opts) {
      calls.push(opts);
      const text = JSON.stringify({ feeling: { label: '开心', intensity: 0.9 }, ...extra });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  return { root, prompts, calls };
}
const session = (id, user = '我是护士，今天被夸了') => ({
  id,
  header: {},
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: user }] },
    { role: 'assistant', content: [{ type: 'text', text: '真棒！' }] },
  ],
});
const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } };
const jsonAt = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));

test('full suite: a conversation in another profile only touches that profile’s data; deleting it removes the data', async () => {
  const h = host({ extra: { memory: { facts: [{ text: '对方是护士', cat: 'identity', kw: ['护士'], quote: '我是护士' }], episodes: [] }, expression: { learn: [], slang: [] } } });
  const ws = [{ id: 'w-novel', sessionIds: ['novel-1'] }];
  h.root.provide('workspaceRegistry', { list: () => ws });
  const dirs = { mood: tmp(), bond: tmp(), memory: tmp(), expression: tmp(), initiative: tmp(), core: tmp() };
  await h.root.plugin(mood, { dataDir: dirs.mood });
  await h.root.plugin(bond, { dataDir: dirs.bond });
  await h.root.plugin(memory, { dataDir: dirs.memory });
  await h.root.plugin(expression, { dataDir: dirs.expression });
  await h.root.plugin(initiative, { dataDir: dirs.initiative });
  await h.root.plugin(core, { dataDir: dirs.core });
  await settle();
  const svc = h.root.get('companion');
  // 走 DSMO 会用的接口：建一个档案，绑到小说工作区
  const prof = await fetchLike(h.root, core.PROFILES_PATH, { action: 'create', name: '沈砚' });
  assert.equal(prof.ok, true, JSON.stringify(prof));
  const id = prof.value.id;
  assert.equal((await fetchLike(h.root, core.SCOPE_PATH, { action: 'set-workspace', workspaceId: 'w-novel', profile: id })).ok, true);
  assert.equal(svc.profileOf('novel-1'), id);
  assert.equal(svc.profileOf('chat-1'), 'default');

  h.root.emit('session/event', session('novel-1'), turnEnd);
  await settle();
  assert.equal(h.calls.length, 1);
  // 沈砚的数据进了 profiles/<id>/，默认档案一点没动
  assert.ok(jsonAt(dirs.mood, 'profiles', id, 'mood.json').valence > 0);
  assert.ok(jsonAt(dirs.bond, 'profiles', id, 'bond.json').value > 0);
  assert.equal(jsonAt(dirs.memory, 'profiles', id, 'memory.json').facts[0].text, '对方是护士');
  assert.ok(!fs.existsSync(path.join(dirs.mood, 'mood.json')), 'default mood untouched');
  assert.equal(h.root.get('companionMemory').facts().length, 0, 'default memory untouched');
  assert.equal(h.root.get('companionMemory').facts(id).length, 1);
  assert.equal(h.root.get('companionInitiative').state(id).nextAt > 0, true, 'her schedule is planned in her own profile');
  assert.equal(h.root.get('companionInitiative').state().nextAt, 0, 'the default profile has nothing planned');
  // 注入按对话的档案：小说对话想起沈砚的记忆，闲聊对话没有
  const ac = (sid) => ({ agent: { id: sid, session: { id: sid } } });
  assert.match(h.prompts.get('maidsh').text(ac('novel-1')), /护士/);
  assert.doesNotMatch(h.prompts.get('maidsh').text(ac('chat-1')), /护士/);
  // 状态按档案给
  const st = await getLike(h.root, `${core.STATE_PATH}?profile=${id}`);
  assert.equal(st.value.profile, id);
  assert.ok(st.value.aspects.find((a) => a.id === 'memory').state.facts === 1);
  assert.equal((await getLike(h.root, `${memory.LIST_PATH}?profile=${id}`)).value.facts.length, 1);
  assert.equal((await getLike(h.root, `${memory.LIST_PATH}?profile=nope`)).ok, false);

  // 删档案：数据一起删，对话退回默认
  assert.equal((await fetchLike(h.root, core.PROFILES_PATH, { action: 'delete', id })).ok, true);
  for (const d of ['mood', 'bond', 'memory', 'initiative']) assert.ok(!fs.existsSync(path.join(dirs[d], 'profiles', id)), `${d} data removed`);
  assert.equal(svc.profileOf('novel-1'), 'default');
});

// 直接调插件登记的路由处理函数（不起 HTTP 服务）
const routes = new Map();
function attachWebServer(root) {
  root.provide('webServer', { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) });
}
async function call(pathAndQuery, method, body) {
  const [p] = pathAndQuery.split('?');
  const handler = routes.get(p);
  assert.ok(handler, `route ${p}`);
  const req = Object.assign(new EventEmitter(), {
    method,
    url: pathAndQuery,
    headers: { host: '127.0.0.1', 'content-type': 'application/json', origin: 'http://127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  let out = null;
  const res = { statusCode: 0, setHeader() {}, end(s) { out = JSON.parse(String(s)); } };
  await handler(req, res);
  return out;
}
async function fetchLike(root, p, body) {
  if (!routes.size) attachWebServer(root);
  await settle();
  return call(p, 'POST', body);
}
async function getLike(root, p) {
  if (!routes.size) attachWebServer(root);
  await settle();
  return call(p, 'GET');
}

test('new aspects still register with an old controller (contract v1), as the default profile', async () => {
  const h = host();
  const seen = [];
  // 老总控：约定 v1，只收 version 1 的面，turn 里没有 profile
  h.root.plugin({
    name: 'old-core',
    apply(ctx) {
      ctx.provide('companion', {
        version: 1,
        register(a) {
          if (a.version !== 1) throw new Error('约定版本 2 不受支持');
          seen.push(a.id);
          return () => {};
        },
      });
    },
  });
  await h.root.plugin(mood, { dataDir: tmp() });
  await h.root.plugin(initiative, { dataDir: tmp() });
  await settle();
  assert.deepEqual(seen.sort(), ['initiative', 'mood']);
});
