// 设定集在真的 cordis 里：路由建作品、按工作区用作品、名单和每轮注入、三个工具只在用了作品的对话里出现、
// MaiDSH 记忆让位、Bot 对话不用、删作品、重启后还在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as lore from '../lore/lib/index.mjs';
import * as memory from '../memory/lib/index.mjs';
import * as core from '../core/lib/index.mjs';

const settle = () => new Promise((r) => setTimeout(r, 30));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsmo-lore-'));

function host({ answer = '{}' } = {}) {
  const root = new Context();
  const sections = new Map();
  const contexts = new Map();
  const tools = new Map();
  const routes = new Map();
  const llmCalls = [];
  root.provide('systemPrompt', {
    section: (o) => (sections.set(o.name, o), () => sections.delete(o.name)),
    context: (o) => (contexts.set(o.name, o), () => contexts.delete(o.name)),
  });
  root.provide('llm', {
    async *stream(opts) {
      llmCalls.push(opts);
      yield { type: 'text-delta', index: 0, text: typeof answer === 'function' ? answer(opts) : answer };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  root.provide('tools', { register: (def, opts) => (tools.set(def.name, { def, opts }), () => tools.delete(def.name)) });
  root.provide('webServer', { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) });
  const ws = [{ id: 'w-novel', sessionIds: ['novel-1', 'novel-2'] }];
  root.provide('workspaceRegistry', { list: () => ws });
  async function call(p, body) {
    const [route] = p.split('?');
    const handler = routes.get(route);
    assert.ok(handler, `route ${route}`);
    const req = Object.assign(new EventEmitter(), {
      method: body === undefined ? 'GET' : 'POST',
      url: p,
      headers: { host: '127.0.0.1', 'content-type': 'application/json', origin: 'http://127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    setTimeout(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }, 0);
    let out;
    await handler(req, { setHeader() {}, end: (s) => (out = JSON.parse(String(s))) });
    return out;
  }
  return { root, sections, contexts, tools, routes, call, llmCalls };
}

const session = (id, user = '', reply = '') => ({
  id,
  header: {},
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  deriveMessages: () => [
    ...(user ? [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: user }] }] : []),
    ...(reply ? [{ role: 'assistant', content: [{ type: 'text', text: reply }] }] : []),
  ],
});
const ac = (s) => ({ agent: { id: s.id, session: s } });
const exec = (s) => ({ agent: { id: s.id, session: s } });

async function setup(h, dir) {
  await h.root.plugin(lore, { dataDir: dir });
  await settle();
  const w = (await h.call(`${lore.API}/mutate`, { action: 'create-work', title: '长夜' })).value;
  for (const c of [
    { name: '沈砚', aliases: ['阿砚'], tier: 'main', card: { summary: '落魄琴师，嘴冷心热。' } },
    { name: '林晚', tier: 'main', card: { summary: '青州知府之女。' } },
  ])
    assert.equal((await h.call(`${lore.API}/mutate`, { action: 'upsert-character', work: w.id, ...c })).ok, true);
  return w;
}

test('a work bound to a workspace: roster + per-turn lore there, nothing anywhere else; default is off', async () => {
  const h = host();
  const dir = tmp();
  const w = await setup(h, dir);
  const novel = session('novel-1', '写阿砚在城外遇到林晚');
  const chat = session('chat-1', '阿砚是谁');
  // 出厂默认关：还没绑，哪里都不加
  assert.equal(h.sections.get('dsmo-lore:roster').text(ac(novel)), '');
  assert.equal(h.contexts.get('dsmo-lore').text(ac(novel)), '');
  assert.equal(await h.tools.get('lore_lookup').opts.when({ agent: { session: novel } }), false, 'no tools until a work is in use');
  assert.equal((await h.call(`${lore.API}/binding`, { action: 'set-workspace', workspaceId: 'w-novel', work: w.id })).ok, true);
  assert.deepEqual((await h.call(`${lore.API}/binding?sessionId=novel-2`)).value, { sessionId: 'novel-2', work: w.id, from: 'workspace', workspaceId: 'w-novel', conversation: null });
  assert.match(h.sections.get('dsmo-lore:roster').text(ac(novel)), /^【《长夜》人物】沈砚（阿砚）、林晚。/);
  const text = h.contexts.get('dsmo-lore').text(ac(novel));
  assert.match(text, /- 沈砚（阿砚）：落魄琴师/);
  assert.match(text, /- 林晚：青州知府之女/);
  assert.equal(h.sections.get('dsmo-lore:roster').text(ac(chat)), '');
  assert.equal(h.contexts.get('dsmo-lore').text(ac(chat)), '');
  assert.equal(await h.tools.get('lore_lookup').opts.when({ agent: { session: novel } }), true);
  assert.equal(await h.tools.get('lore_lookup').opts.when({ agent: { session: chat } }), false);
  // 子代理：不注入，但工具用父会话的作品
  const sub = { ...session('sub-1', '写阿砚'), header: { origin: 'subagent', parentSession: 'novel-1' } };
  assert.equal(h.contexts.get('dsmo-lore').text(ac(sub)), '');
  assert.equal(await h.tools.get('lore_lookup').opts.when({ agent: { session: sub } }), true);
  // 单独在一段对话里关掉 / 打开
  await h.call(`${lore.API}/binding`, { action: 'set', sessionId: 'novel-2', work: 'off' });
  assert.equal(h.contexts.get('dsmo-lore').text(ac(session('novel-2', '阿砚'))), '');
  await h.call(`${lore.API}/binding`, { action: 'set', sessionId: 'chat-1', work: w.id });
  assert.match(h.contexts.get('dsmo-lore').text(ac(chat)), /沈砚/);
  // Bot 的对话一律不用
  await h.call(`${lore.API}/binding`, { action: 'set-bots', sessionIds: ['novel-1'] });
  assert.equal(h.contexts.get('dsmo-lore').text(ac(novel)), '');
  assert.equal(await h.tools.get('lore_lookup').opts.when({ agent: { session: novel } }), false);
});

test('tools: record a change (saved to disk, cursor moves), look it up, check a chapter with quotes verified', async () => {
  const h = host({
    answer: (opts) => {
      const f = opts.messages[0].content[0].text.match(/(F\d+) 沈砚的伤势/)?.[1];
      return JSON.stringify({ conflicts: [{ fact: f, quote: '沈砚抬起左臂挥剑', problem: '左臂有伤却挥剑自如' }, { fact: f, quote: '编造的原文句子', problem: 'x' }], unrecorded: [] });
    },
  });
  const dir = tmp();
  const w = await setup(h, dir);
  await h.call(`${lore.API}/binding`, { action: 'set-default', work: w.id });
  const s = session('any', '');
  const run = (name, args) => h.tools.get(name).def.execute(args, exec(s));
  const r = await run('lore_record_state', { changes: [{ subject: '阿砚', key: '伤势', value: '左臂刀伤', evidence: '刀锋划过左臂' }, { subject: '林婉', key: '位置', value: '后宅' }], chapter: 11 });
  assert.match(r.text, /记下了 1 条：\n- \[s-[a-z0-9]+\] 沈砚·伤势 = 左臂刀伤（第 11 章起）/);
  assert.match(r.text, /林婉·位置：找不到.*最像的是：林晚/);
  assert.match(r.text, /现在写到第 11 章/);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'works', `${w.id}.json`), 'utf8'));
  assert.equal(disk.cursor.chapter, 11);
  assert.equal(disk.states.length, 1);
  assert.match((await run('lore_lookup', { names: '沈砚' })).text, /伤势：左臂刀伤（第 11 章起）/);
  assert.match((await run('lore_lookup', { names: '沈砚', chapter: 3 })).text, /第 3 章时；现在写到第 11 章/);
  // 每轮注入跟着变：这一轮还没结束时作品被改，文字跟着更新
  assert.match(h.contexts.get('dsmo-lore').text(ac(session('any', '阿砚呢'))), /伤势：左臂刀伤/);
  const check = await run('lore_check', { text: '那夜沈砚抬起左臂挥剑，剑光如雪。林晚站在檐下。' });
  assert.equal(h.llmCalls.length, 1);
  assert.match(check.text, /发现 1 处可能的矛盾/);
  assert.match(check.text, /原文「沈砚抬起左臂挥剑」/);
  assert.match(check.text, /另有 1 条因为没有原文证据被丢掉/);
  assert.match((await run('lore_check', {})).text, /不到 200 字/);
  assert.match((await run('lore_lookup', { names: '沈砚', chapter: -1 })).text, /chapter 要是/);
});

test('MaiDSH memory steps aside: in a conversation that uses a work, story-world facts are not recalled', async () => {
  const h = host();
  const dir = tmp();
  await h.root.plugin(memory, { dataDir: tmp() });
  const w = await setup(h, dir);
  await h.call(`${lore.API}/binding`, { action: 'set-workspace', workspaceId: 'w-novel', work: w.id });
  const mem = h.root.get('companionMemory');
  mem.remember('青州城门入夜即闭', { cat: 'world', kw: ['青州', '城门'] });
  mem.remember('对方喜欢下雨天', { cat: 'pref', kw: ['下雨'] });
  const memText = (s) => h.contexts.get('maidsh:memory').text(ac(s));
  const inNovel = memText(session('novel-1', '青州的城门几点关'));
  const inChat = memText(session('chat-1', '青州的城门几点关'));
  assert.doesNotMatch(inNovel, /城门入夜即闭/, 'the lore book is the source of truth there');
  assert.match(inChat, /城门入夜即闭/, 'other conversations still recall it');
  assert.match(inNovel, /下雨天/, 'facts about the user are untouched');
  assert.equal(mem.facts().filter((f) => f.cat === 'world').length, 1, 'nothing is deleted');
});

test('with the MaiDSH controller the memory face also knows the conversation', async () => {
  const h = host();
  await h.root.plugin(memory, { dataDir: tmp() });
  await h.root.plugin(core, { dataDir: tmp() });
  const w = await setup(h, tmp());
  await h.call(`${lore.API}/binding`, { action: 'set', sessionId: 'novel-1', work: w.id });
  h.root.get('companionMemory').remember('青州城门入夜即闭', { cat: 'world', kw: ['青州'] });
  const text = (id) => h.contexts.get('maidsh').text(ac(session(id, '青州')));
  assert.doesNotMatch(text('novel-1'), /城门入夜即闭/);
  assert.match(text('chat-1'), /城门入夜即闭/);
});

test('import a card through the route (dry run first), undo it; delete the work; everything survives a restart', async () => {
  const h = host();
  const dir = tmp();
  const w = await setup(h, dir);
  const card = { spec: 'chara_card_v2', data: { name: '苏九', description: '酒肆老板娘。', first_mes: '客官里边请', character_book: { entries: [{ keys: ['酒肆'], content: '城南的酒肆，消息灵通。', enabled: true }] } } };
  const dry = (await h.call(`${lore.API}/import`, { work: w.id, kind: 'card', json: card, dryRun: true })).value;
  assert.match(dry.report, /将导入 1 个人物（苏九）、1 条设定/);
  assert.match(dry.report, /first_mes/);
  const done = (await h.call(`${lore.API}/import`, { work: w.id, kind: 'card', json: card, filename: '苏九.json' })).value;
  assert.match(done.report, /导入了 1 个人物（苏九）、1 条设定/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
  assert.match((await h.call(`${lore.API}/import`, { kind: 'card', pngBase64: png.toString('base64') })).error, /没有角色卡数据/);
  assert.equal((await h.call(`${lore.API}/import/undo`, { work: w.id, jobId: done.jobId })).ok, true);
  assert.equal((await h.call(`${lore.API}/work?id=${w.id}`)).value.characters.length, 2);
  // 导入成一部新作品
  const fresh = (await h.call(`${lore.API}/import`, { kind: 'card', json: card })).value;
  assert.equal(fresh.work.title, '苏九');
  // 重启：作品和绑定都在
  await h.call(`${lore.API}/binding`, { action: 'set-workspace', workspaceId: 'w-novel', work: w.id });
  const h2 = host();
  await h2.root.plugin(lore, { dataDir: dir });
  await settle();
  assert.equal((await h2.call(`${lore.API}/works`)).value.length, 2);
  assert.match(h2.sections.get('dsmo-lore:roster').text(ac(session('novel-1'))), /沈砚/);
  // 删作品：绑定一起清掉
  assert.equal((await h2.call(`${lore.API}/mutate`, { action: 'delete-work', id: w.id })).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'works', `${w.id}.json`)), false);
  assert.equal((await h2.call(`${lore.API}/binding?sessionId=novel-1`)).value.work, null);
  assert.equal((await h2.call(`${lore.API}/work?id=${w.id}`)).ok, false);
});
