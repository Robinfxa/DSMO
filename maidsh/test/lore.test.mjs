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

// ---------- 聊天时自动整理（LORE-DESIGN §14） ----------

const REPLY = '夜里，沈砚被刀锋划过左臂，血顺着袖口往下淌。他咬着牙把林晚的玉佩塞进怀里，翻身出了青州城。城外的苏九牵着马等他，'.repeat(6) + '北境的规矩是见血不追。';
const talk = (id, msgs) => ({
  id,
  header: {},
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  deriveMessages: () => msgs.map(([role, mid, text]) => ({ id: mid, role, ...(role === 'user' ? { source: { kind: 'user' } } : {}), content: [{ type: 'text', text }] })),
});
const turnDone = { type: 'turn/end', data: { reason: { kind: 'completed' } } };

test('auto: a finished turn is sorted into the work; new names wait; short replies and other conversations cost nothing; a regenerated reply is undone', async () => {
  const h = host({
    answer: (opts) =>
      /小说设定整理员/.test(opts.system)
        ? JSON.stringify(
            opts.messages[0].content[0].text.includes('翻身出了青州城')
              ? {
                  changes: [{ subject: '阿砚', key: '伤势', value: '左臂刀伤', op: 'replace', quote: '沈砚被刀锋划过左臂' }],
                  relations: [{ a: '沈砚', b: '林晚', key: '关系', value: '托付信物', quote: '把林晚的玉佩塞进怀里' }],
                  newCharacters: [{ name: '苏九', summary: '城外接应的人。', quote: '城外的苏九牵着马等他' }],
                  newEntries: [],
                }
              : { changes: [], relations: [], newCharacters: [], newEntries: [] },
          )
        : '{}',
  });
  const dir = tmp();
  const w = await setup(h, dir);
  await h.call(`${lore.API}/binding`, { action: 'set-workspace', workspaceId: 'w-novel', work: w.id });
  const lo = h.root.get('lore');
  h.root.emit('session/event', talk('novel-1', [['user', 'u1', '写第十二章：阿砚出城'], ['assistant', 'a1', REPLY]]), turnDone);
  await settle();
  await lo.idle();
  let full = (await h.call(`${lore.API}/work?id=${w.id}`)).value;
  assert.equal(full.cursor.chapter, 12, 'the author said 第十二章');
  assert.deepEqual(full.states.map((s) => [s.key, s.value, s.from, s.source]), [['伤势', '左臂刀伤', 12, 'auto:a1']]);
  assert.equal(full.relations[0].value, '托付信物');
  assert.deepEqual(full.pending.map((p) => p.data.name), ['苏九']);
  const sum = (await h.call(`${lore.API}/works`)).value[0];
  assert.equal(sum.pending, 1);
  assert.deepEqual([sum.lastAuto.sessionId, sum.lastAuto.recorded, sum.lastAuto.pending], ['novel-1', 2, 1]);
  assert.equal(h.llmCalls.length, 1);
  // 闲聊（回复太短）和没用作品的对话：不调模型
  h.root.emit('session/event', talk('novel-1', [['user', 'u1', '写第十二章'], ['assistant', 'a1', REPLY], ['user', 'u2', '好'], ['assistant', 'a2', '嗯嗯']]), turnDone);
  h.root.emit('session/event', talk('chat-1', [['user', 'u9', '写'], ['assistant', 'a9', REPLY]]), turnDone);
  await settle();
  await lo.idle();
  assert.equal(h.llmCalls.length, 1);
  // 收下待确认（走接口）
  assert.equal((await h.call(`${lore.API}/mutate`, { action: 'accept-pending', work: w.id, id: 'all' })).value.accepted, 1);
  // 重新生成：a1 不在了 → 那一轮自动记的（连同收下的苏九）都撤掉
  h.root.emit('session/event', talk('novel-1', [['user', 'u1', '写第十二章：阿砚出城'], ['assistant', 'a1b', '另一个版本。'.repeat(60)]]), turnDone);
  await settle();
  await lo.idle();
  full = (await h.call(`${lore.API}/work?id=${w.id}`)).value;
  assert.equal(full.states.length, 0, 'the regenerated reply’s records are gone');
  assert.equal(full.relations.length, 0);
  assert.ok(!full.characters.some((c) => c.name === '苏九'));
  // 档位和自动模式（走接口）；自动模式下新人物直接收下
  assert.equal((await h.call(`${lore.API}/mutate`, { action: 'settings', work: w.id, autoAccept: true, autoRecord: 'every' })).value.autoAccept, true);
  assert.equal((await h.call(`${lore.API}/mutate`, { action: 'settings', work: w.id, autoRecord: 'sometimes' })).ok, false);
  h.root.emit('session/event', talk('novel-2', [['user', 'u5', '继续'], ['assistant', 'a5', REPLY]]), turnDone);
  await settle();
  await lo.idle();
  full = (await h.call(`${lore.API}/work?id=${w.id}`)).value;
  assert.ok(full.characters.some((c) => c.name === '苏九' && c.source === 'auto:a5'));
  assert.equal(full.pending.length, 0);
  // 撤销这一轮（走接口）
  assert.equal((await h.call(`${lore.API}/mutate`, { action: 'undo-auto', work: w.id, turnId: 'a5' })).ok, true);
  full = (await h.call(`${lore.API}/work?id=${w.id}`)).value;
  assert.ok(!full.characters.some((c) => c.name === '苏九') && !full.states.length);
  assert.equal((await h.call(`${lore.API}/mutate`, { action: 'undo-auto', work: w.id, turnId: 'a5' })).ok, false);
});

// ---------- 在聊天里建设定、记情节（LORE-DESIGN §15） ----------

const chatSession = (id, userCount = 1) => ({
  id,
  header: {},
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  deriveMessages: () => Array.from({ length: userCount }, (_, i) => ({ id: `u${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '……' }] })),
});

test('chat: start a work from a conversation (review card), then edit it — light edits apply, heavy ones wait for 确认', async () => {
  const h = host();
  const asked = [];
  let answer = '确认';
  h.root.provide('userQuestions', { ask: async (req) => (asked.push(req), { answers: [{ id: req.questions[0].id, selected: [answer] }] }) });
  const dir = tmp();
  await h.root.plugin(lore, { dataDir: dir });
  await settle();
  const s = chatSession('chat-9');
  const vis = (name, sess = s) => h.tools.get(name).opts.when({ agent: { session: sess } });
  assert.equal(await vis('lore_start'), true, 'no work yet: lore_start is there');
  assert.equal(await vis('lore_edit'), false);
  const run = (name, args, sess = s) => h.tools.get(name).def.execute(args, { agent: { id: sess.id, session: sess } });
  let r = await run('lore_start', {
    title: '长夜',
    characters: [{ name: '沈砚', aliases: ['阿砚'], summary: '落魄琴师，嘴冷心热。', main: true }],
    entries: [{ title: '青州', keys: ['青州'], content: '北境门户。' }],
    plot: [{ from: 1, to: 8, summary: '沈砚在青州卖琴为生。' }],
    chapter: 9,
  });
  assert.equal(asked.length, 1, 'creating a work always asks');
  assert.equal(asked[0].questions[0].intent.kind, 'approval');
  assert.match(asked[0].questions[0].detail, /新建作品《长夜》[\s\S]*新人物：沈砚[\s\S]*新设定：青州[\s\S]*情节 第 1–8 章/);
  assert.match(r.text, /建好了《长夜》，这段对话从现在起用它/);
  const w = (await h.call(`${lore.API}/works`)).value[0];
  assert.equal(w.chapter, 9);
  assert.equal((await h.call(`${lore.API}/binding?sessionId=chat-9`)).value.from, 'conversation');
  assert.equal(await vis('lore_start'), false, 'now it uses a work: lore_edit instead');
  assert.equal(await vis('lore_edit'), true);
  assert.match(h.contexts.get('dsmo-lore').text(ac(session('chat-9', '写阿砚'))), /- 前情：第 1–8 章，沈砚在青州卖琴为生。/);
  // 小改直接生效；改已有的性格要复核，这次点「不要」
  answer = '不要';
  r = await run('lore_edit', { changes: [{ kind: 'character', name: '林晚', summary: '知府之女。' }, { kind: 'character', name: '沈砚', appearance: '左眉有疤' }, { kind: 'character', name: '沈砚', summary: '冷面琴师。' }] });
  assert.match(r.text, /已经改好（第 b-[a-z0-9]+ 批[\s\S]*新人物：林晚[\s\S]*补 沈砚 的外貌/);
  assert.match(r.text, /用户没同意，这些没改：\n- 改 沈砚 的简介/);
  assert.equal(asked.length, 2);
  let full = (await h.call(`${lore.API}/work?id=${w.id}`)).value;
  assert.equal(full.characters.find((c) => c.name === '沈砚').card.summary, '落魄琴师，嘴冷心热。');
  // 这次点「确认」
  answer = '确认';
  r = await run('lore_edit', { changes: [{ kind: 'character', name: '沈砚', summary: '冷面琴师。' }, { kind: 'remove', target: '青州' }] });
  assert.match(r.text, /用户确认了，已经改好/);
  full = (await h.call(`${lore.API}/work?id=${w.id}`)).value;
  assert.equal(full.characters.find((c) => c.name === '沈砚').card.summary, '冷面琴师。');
  assert.equal(full.lore.length, 0);
  // 整批撤销
  const batch = /第 (b-[a-z0-9]+) 批/.exec(r.text)[1];
  r = await run('lore_edit', { undo: batch });
  assert.match(r.text, /撤销了/);
  full = (await h.call(`${lore.API}/work?id=${w.id}`)).value;
  assert.equal(full.lore[0].title, '青州');
  // 记早于现在章节的状态：也要复核
  const before = asked.length;
  r = await run('lore_record_state', { chapter: 3, changes: [{ subject: '沈砚', key: '位置', value: '青州城内' }] });
  assert.equal(asked.length, before + 1);
  assert.match(r.text, /改第 3 章的状态/);
  // Bot 的对话、关掉 chatStart：没有 lore_start
  await h.call(`${lore.API}/binding`, { action: 'set-bots', sessionIds: ['bot-1'] });
  assert.equal(await vis('lore_start', chatSession('bot-1')), false);
});

test('chat: no card to show → the change waits; confirming in the same turn is refused, the next turn works', async () => {
  const h = host(); // 没有 userQuestions：弹不出卡片
  await h.root.plugin(lore, { dataDir: tmp() });
  await settle();
  const run = (name, args, sess) => h.tools.get(name).def.execute(args, { agent: { id: sess.id, session: sess } });
  let r = await run('lore_start', { title: '雾港' }, chatSession('c1', 1));
  const sid = /lore_confirm（id: (s-[a-z0-9]+)）/.exec(r.text)[1];
  assert.match(r.text, /同一轮里不能确认/);
  assert.equal((await h.call(`${lore.API}/works`)).value.length, 0, 'nothing created yet');
  assert.equal(await h.tools.get('lore_confirm').opts.when({ agent: { session: chatSession('c1') } }), true);
  r = await run('lore_confirm', { id: sid }, chatSession('c1', 1));
  assert.match(r.text, /要等用户在下一句里同意/);
  r = await run('lore_confirm', { id: sid }, chatSession('c1', 2));
  assert.match(r.text, /建好了《雾港》/);
  // 作品里的重要改动：同样等下一轮；也能在页面的「待确认」里收下
  r = await run('lore_edit', { changes: [{ kind: 'rename', title: '雾港夜话' }] }, chatSession('c1', 2));
  const pid = /lore_confirm（id: (p-[a-z0-9]+)）/.exec(r.text)[1];
  const w = (await h.call(`${lore.API}/works`)).value[0];
  assert.equal(w.pending, 1);
  r = await run('lore_confirm', { id: pid }, chatSession('c1', 2));
  assert.match(r.text, /要等用户/);
  assert.equal((await h.call(`${lore.API}/mutate`, { action: 'accept-pending', work: w.id, id: pid })).value.accepted, 1);
  assert.equal((await h.call(`${lore.API}/works`)).value[0].title, '雾港夜话');
});

test('chat: chatStart off hides lore_start', async () => {
  const h = host();
  await h.root.plugin(lore, { dataDir: tmp(), chatStart: false });
  await settle();
  assert.equal(await h.tools.get('lore_start').opts.when({ agent: { session: chatSession('x') } }), false);
});
