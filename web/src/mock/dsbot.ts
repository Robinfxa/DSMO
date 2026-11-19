// The prototype's DS Bot: a small team on the mock host, speaking the same
// channel as the real plugin (`/api/bot` calls and the feed's events), with
// replies streamed piece by piece. Timings shortened.

import { DsBotError, type Transport } from '../bots/api';

type Sink = (event: string, data: unknown) => void;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MBot {
  id: string;
  name: string;
  role: string;
  instructions: string;
  color?: string;
  model?: string;
  effort?: string;
  sessionId: string;
  parts: string[];
  waiting: boolean;
  createdAt: number;
  workDir?: string;
}
interface MRoom {
  id: string;
  name: string;
  members: string[];
  admin: string;
  mode: string;
  relayLimit: number | null;
  notice: string;
  createdAt: number;
  workDir?: string;
  paused: { id: string }[];
}
interface MItem {
  kind: string;
  id?: string;
  text: string;
  time: number;
  botId?: string;
  name?: string;
  color?: string;
  event?: string;
  role?: string;
  roomId?: string;
}
interface MMem {
  scope: string;
  text: string;
  topic?: string;
  added: string;
  by?: string;
}

const MODELS = [
  { ref: 'deepseek/deepseek-v4-pro', name: 'DeepSeek-V4-Pro', providerName: 'DeepSeek' },
  { ref: 'deepseek/deepseek-v4-flash', name: 'DeepSeek-V4-Flash', providerName: 'DeepSeek' },
];

const REPLIES = [
  '好的，我先看一下目前的情况，再给你一个能直接用的版本。\n\n1. **先列提纲**：按「完成 / 进行中 / 下周」三段\n2. 每段不超过三条，写清楚结果而不是过程\n3. 最后一句写需要谁帮忙\n\n要我现在就按这个写吗？',
  '收到。我把要点记下来了，下次也会按这个习惯来。',
  '我查了一下，问题出在缓存没有按用户区分：同一个 key 被两个账号共用了。改法是把用户 ID 拼进 key 里，我已经在 `cache.ts` 里改好，测试也跑过了。',
];

export function createMockDsBot(): () => Transport {
  const t0 = Date.now() - 3 * 3600_000;
  let seq = 0;
  let revision = 7;
  let noticeSeq = 0;
  const boot = 'boot-' + Math.random().toString(36).slice(2, 8);
  const sinks = new Set<Sink>();
  const notices: Record<string, unknown>[] = [];
  const bots: MBot[] = [
    { id: 'b-main', name: '小助理', role: '日常事务', instructions: '帮我安排日程、整理信息，能自己做的就直接做。', color: 'deepseek', model: MODELS[0].ref, effort: 'medium', sessionId: 'b-main', parts: [], waiting: false, createdAt: t0 },
    { id: 'b-writer', name: '写手', role: '写周报和文章', instructions: '语气平实，少用形容词。', color: 'orange', model: MODELS[0].ref, sessionId: 'b-writer', parts: [], waiting: false, createdAt: t0 + 60_000 },
    { id: 'b-coder', name: '程序员', role: '看代码、修 bug', instructions: '改动前先读相关文件，改完跑测试。', color: 'blue', model: MODELS[1].ref, sessionId: 'b-coder', parts: ['b-coder-1'], waiting: false, createdAt: t0 + 120_000, workDir: '/root/projects/api-demo' },
    { id: 'b-new', name: '研究员', role: '查资料', instructions: '', color: 'green', sessionId: 'b-new', parts: [], waiting: true, createdAt: Date.now() - 600_000 },
  ];
  const mains = ['b-main'];
  const rooms: MRoom[] = [{ id: 'r-weekly', name: '周报小组', members: ['b-main', 'b-writer', 'b-coder'], admin: 'b-main', mode: 'admin', relayLimit: null, notice: '每周五下午出周报', createdAt: t0 + 300_000, paused: [] }];
  const chats = new Map<string, MItem[]>([
    [
      'b-main',
      [
        { kind: 'bot', text: '你好，我是小助理。日程、提醒、整理资料都可以交给我。', time: t0 },
        { kind: 'user', text: '明天上午十点提醒我交实验报告', time: t0 + 3600_000 },
        { kind: 'bot', text: '好的，已经设好了：**明天 10:00** 提醒你交实验报告。', time: t0 + 3605_000 },
      ],
    ],
    [
      'b-writer',
      [
        { kind: 'bot', text: '我是写手。周报、文章、邮件都可以找我。', time: t0 + 60_000 },
        { kind: 'user', text: '帮我写这周的周报', time: Date.now() - 900_000 },
        { kind: 'event', role: 'request', name: '程序员', text: '', time: Date.now() - 880_000, botId: 'b-coder' },
        { kind: 'bot', text: '我先问清楚一件事再动笔。', time: Date.now() - 860_000 },
      ],
    ],
    [
      'b-coder',
      [
        { kind: 'divider', text: '', time: t0 + 1000_000 },
        { kind: 'user', text: '登录后偶尔看到别人的头像，帮我查一下', time: Date.now() - 7200_000 },
        { kind: 'bot', text: REPLIES[2], time: Date.now() - 7000_000 },
      ],
    ],
    ['b-new', []],
  ]);
  const roomItems = new Map<string, MItem[]>([
    [
      'r-weekly',
      [
        { kind: 'user', id: '1', text: '这周的周报大家分工一下', time: Date.now() - 5400_000 },
        { kind: 'bot', id: '2', botId: 'b-main', name: '小助理', color: 'deepseek', text: '好的。@写手 负责成文，@程序员 把这周合进去的改动列一下给写手。', time: Date.now() - 5380_000 },
        { kind: 'event', id: '3', event: 'working', botId: 'b-coder', name: '程序员', text: '', time: Date.now() - 5370_000 },
        { kind: 'bot', id: '4', botId: 'b-coder', name: '程序员', color: 'blue', text: '这周合了 6 个 PR：修了头像串号、加了分享码导入、终端支持了 Ctrl 键。详细列表我发给写手了。', time: Date.now() - 5200_000 },
        { kind: 'event', id: '5', event: 'done', botId: 'b-coder', name: '程序员', text: '', time: Date.now() - 5190_000 },
      ],
    ],
  ]);
  const questions: Record<string, unknown> = {
    'b-writer': { id: 'q1', question: '这份周报写给谁看？', detail: '不同的读者，我会写得详略不同。', options: [{ label: '团队内部' }, { label: '导师' }, { label: '自己留档' }], multiSelect: false, allowCustom: true, askedAt: Date.now() - 850_000 },
  };
  const views: Record<string, unknown> = {};
  const approvals: Record<string, unknown>[] = [{ id: 'ap1', sessionId: 'r-weekly-b-coder', botId: 'b-coder', roomId: 'r-weekly', tool: 'bash', reason: 'git log --since=last.friday --oneline', at: Date.now() - 60_000, answerable: true }];
  const work: { bots: Record<string, unknown>; rooms: Record<string, unknown[]> } = { bots: {}, rooms: {} };
  const memory = new Map<string, MMem[]>([
    ['b-main', [{ scope: 'own', text: '用户是大二学生，在多伦多', added: '2026-11-02', by: 'user' }, { scope: 'team', text: '周报每周五下午交', added: '2026-11-10' }]],
    ['b-writer', [{ scope: 'own', text: '周报不超过一页', added: '2026-11-11' }]],
    ['r-weekly', [{ scope: 'group', text: '写手负责成文，程序员提供改动列表', added: '2026-11-12' }]],
  ]);

  const emit = (event: string, data: unknown) => sinks.forEach((s) => s(event, data));
  const bump = () => (revision++, emit('revision', { revision }));
  const notice = (kind: string, botId: string, text: string, roomId?: string) => {
    const n = { seq: ++noticeSeq, kind, botId, name: bots.find((b) => b.id === botId)?.name ?? '', roomId, title: rooms.find((r) => r.id === roomId)?.name, text, time: Date.now() };
    notices.push(n);
    emit('notice', n);
  };
  // A couple of notices waiting from before.
  notice('message', 'b-main', '好的，已经设好了：明天 10:00 提醒你交实验报告。');
  notice('question', 'b-writer', '这份周报写给谁看？');
  notice('group', 'b-coder', '这周合了 6 个 PR：修了头像串号、加了分享码导入…', 'r-weekly');

  const botJson = (b: MBot) => ({ ...b, avatar: {}, appliedModel: b.model });
  const roomJson = (r: MRoom) => {
    const items = roomItems.get(r.id) ?? [];
    const last = [...items].reverse().find((i) => i.kind === 'user' || i.kind === 'bot');
    return { ...r, relayLimitDefault: 3 * r.members.length, preview: last ? (last.kind === 'user' ? last.text : `${last.name}：${last.text}`) : undefined, parts: r.members.map((m) => `${r.id}-${m}`) };
  };
  const state = (since?: number) => {
    const live = { activity: {}, work: { ...work, approvals } };
    if (since === revision) return { unchanged: true, revision, ...live };
    return { revision, mainBotIds: mains, bots: bots.map(botJson), rooms: rooms.map(roomJson), questions, views, models: MODELS, defaultModel: MODELS[0].ref, modelsKey: 'm1', memory: true, ...live };
  };
  const bot = (id: unknown) => {
    const b = bots.find((x) => x.id === id);
    if (!b) throw new DsBotError('no such bot', 'bot/not-found');
    return b;
  };
  const room = (id: unknown) => {
    const r = rooms.find((x) => x.id === id);
    if (!r) throw new DsBotError('no such room', 'bot/not-found');
    return r;
  };

  async function reply(b: MBot, text: string) {
    const attemptId = 'a' + ++seq;
    work.bots[b.id] = { since: Date.now() };
    emit('live', {});
    await wait(500);
    emit('stream', { botId: b.id, sessionId: b.sessionId, attemptId, phase: 'start' });
    const full = /记住|习惯/.test(text) ? REPLIES[1] : /bug|代码|报错/.test(text) ? REPLIES[2] : REPLIES[0];
    for (let i = 0; i < full.length; i += 6) {
      await wait(45);
      emit('stream', { botId: b.id, sessionId: b.sessionId, attemptId, text: full.slice(i, i + 6) });
    }
    emit('stream', { botId: b.id, sessionId: b.sessionId, attemptId, phase: 'end' });
    const item: MItem = { kind: 'bot', text: full, time: Date.now() };
    chats.get(b.id)!.push(item);
    emit('message', { botId: b.id, sessionId: b.sessionId, item });
    delete work.bots[b.id];
    emit('live', {});
    notice('message', b.id, full.replace(/\s+/g, ' ').slice(0, 60));
  }

  async function roomRound(r: MRoom) {
    const items = roomItems.get(r.id)!;
    const add = (i: Omit<MItem, 'id' | 'time'>) => {
      items.push({ ...i, id: String(items.length + 1), time: Date.now() });
      emit('room', { roomId: r.id });
    };
    const speaker = bots.find((b) => b.id === r.admin)!;
    work.rooms[r.id] = [{ botId: speaker.id, speaking: true, since: Date.now() }];
    emit('live', {});
    await wait(900);
    add({ kind: 'bot', botId: speaker.id, name: speaker.name, color: speaker.color, text: '收到，我让 @写手 先出一版，十分钟后发到群里。' });
    work.rooms[r.id] = [{ botId: 'b-writer', tool: 'write', since: Date.now() }];
    work.bots['b-writer'] = { roomId: r.id, tool: 'write', since: Date.now() };
    emit('live', {});
    add({ kind: 'event', event: 'working', botId: 'b-writer', name: '写手', text: '' });
    await wait(1500);
    add({ kind: 'bot', botId: 'b-writer', name: '写手', color: 'orange', text: '初稿好了：\n\n**完成**：修复头像串号；上线分享码导入\n**进行中**：DS Bot 网页版\n**下周**：安全模式页面' });
    add({ kind: 'event', event: 'done', botId: 'b-writer', name: '写手', text: '' });
    delete work.rooms[r.id];
    delete work.bots['b-writer'];
    emit('live', {});
    notice('group', 'b-writer', '初稿好了：完成：修复头像串号；上线分享码导入…', r.id);
  }

  const handle = async (endpoint: string, p: Record<string, any>): Promise<unknown> => {
    await wait(80);
    switch (endpoint) {
      case 'hello':
        return { api: 1, apiMin: 1, apiMax: 1, plugin: { version: '0.3.1' }, capabilities: ['memory-edit', 'usage', 'folders'], boot, seq: noticeSeq, revision, memory: true };
      case 'state':
        return state(p.since);
      case 'avatar':
        return { ref: null, image: null };
      case 'notices': {
        const list = notices.filter((n) => (n.seq as number) > (p.since ?? 0));
        return { boot, seq: noticeSeq, reset: false, notices: list };
      }
      case 'chat': {
        const b = bot(p.botId);
        return { sessionId: b.sessionId, items: chats.get(b.id) ?? [], cursor: null };
      }
      case 'room-chat': {
        const r = room(p.roomId);
        return { roomId: r.id, items: roomItems.get(r.id) ?? [], cursor: null, running: !!work.rooms[r.id], speaking: (work.rooms[r.id]?.[0] as { botId?: string } | undefined)?.botId };
      }
      case 'send': {
        const text = String(p.text ?? '');
        const r = rooms.find((x) => x.id === p.sessionId);
        if (r) {
          const items = roomItems.get(r.id)!;
          items.push({ kind: 'user', id: String(items.length + 1), text, time: Date.now() });
          r.paused = [];
          emit('room', { roomId: r.id });
          void roomRound(r);
          return null;
        }
        const b = bot(p.sessionId);
        if (b.waiting) throw new DsBotError('pick a model first', 'bot/needs-model');
        const item: MItem = { kind: 'user', text, time: Date.now() };
        chats.get(b.id)!.push(item);
        emit('message', { botId: b.id, sessionId: b.sessionId, item });
        if (text.startsWith('[dsh-ui reply]')) delete questions[b.sessionId];
        void reply(b, text);
        return null;
      }
      case 'create-bot': {
        const id = 'b-' + ++seq;
        const b: MBot = { id, name: String(p.name), role: p.role ?? '', instructions: p.instructions ?? '', color: p.color, model: p.model, effort: p.effort, sessionId: id, parts: [], waiting: !p.model, createdAt: Date.now() };
        bots.push(b);
        chats.set(id, []);
        bump();
        if (b.model) setTimeout(() => void reply(b, '打个招呼'), 300);
        return botJson(b);
      }
      case 'duplicate-bot': {
        const src = bot(p.id);
        const id = 'b-' + ++seq;
        const b: MBot = { ...src, id, name: `${src.name} 2`, sessionId: id, parts: [], createdAt: Date.now() };
        bots.push(b);
        chats.set(id, []);
        bump();
        return botJson(b);
      }
      case 'update-bot': {
        const b = bot(p.id);
        for (const k of ['name', 'role', 'instructions', 'color'] as const) if (typeof p[k] === 'string') b[k] = p[k];
        if (typeof p.model === 'string') {
          b.model = p.model || undefined;
          if (b.waiting && b.model) {
            b.waiting = false;
            setTimeout(() => void reply(b, '打个招呼'), 300);
          }
        }
        if (typeof p.effort === 'string') b.effort = p.effort || undefined;
        if (typeof p.workDir === 'string') b.workDir = p.workDir || undefined;
        bump();
        return null;
      }
      case 'delete-bot':
        bots.splice(bots.indexOf(bot(p.id)), 1);
        for (const r of rooms) r.members = r.members.filter((m) => m !== p.id);
        bump();
        return null;
      case 'set-main': {
        bot(p.id);
        const i = mains.indexOf(p.id);
        if (p.main && i < 0) mains.push(p.id);
        if (!p.main && i >= 0) mains.splice(i, 1);
        bump();
        return null;
      }
      case 'folders':
        return { team: '/root/workspace', folders: [{ path: '/root/workspace', title: 'workspace' }, { path: '/root/projects/api-demo', title: 'api-demo' }, { path: '/root/projects/blog', title: 'blog' }] };
      case 'create-room': {
        const id = 'r-' + ++seq;
        const members = (p.members as string[]).filter((m) => bots.some((b) => b.id === m));
        const r: MRoom = { id, name: p.name || members.map((m) => bot(m).name).join('、'), members, admin: members.find((m) => mains.includes(m)) ?? members[0], mode: 'admin', relayLimit: null, notice: '', createdAt: Date.now(), paused: [] };
        rooms.push(r);
        roomItems.set(id, []);
        bump();
        setTimeout(() => {
          const a = bot(r.admin);
          roomItems.get(id)!.push({ kind: 'bot', id: '1', botId: a.id, name: a.name, color: a.color, text: '大家好，这个群打算用来做什么？', time: Date.now() });
          emit('room', { roomId: id });
        }, 600);
        return roomJson(r);
      }
      case 'update-room': {
        const r = room(p.id);
        for (const k of ['name', 'notice', 'mode', 'admin'] as const) if (typeof p[k] === 'string') r[k] = p[k];
        if (Array.isArray(p.add)) r.members.push(...p.add.filter((x: string) => !r.members.includes(x)));
        if (Array.isArray(p.remove)) r.members = r.members.filter((m) => !p.remove.includes(m));
        if ('relayLimit' in p) r.relayLimit = p.relayLimit;
        if (typeof p.workDir === 'string') r.workDir = p.workDir || undefined;
        bump();
        return null;
      }
      case 'delete-room':
        rooms.splice(rooms.indexOf(room(p.id)), 1);
        bump();
        return null;
      case 'room-continue':
        room(p.roomId).paused = [];
        bump();
        return null;
      case 'stop-member-work': {
        const was = !!work.bots[p.botId];
        delete work.bots[p.botId];
        emit('live', {});
        return was;
      }
      case 'approval-answer': {
        const i = approvals.findIndex((a) => a.id === p.id);
        if (i >= 0) {
          const a = approvals.splice(i, 1)[0];
          const items = roomItems.get(String(a.roomId));
          if (items) {
            items.push({ kind: 'event', id: String(items.length + 1), event: p.choice === 'allow' ? 'working' : 'stopped', botId: String(a.botId), name: bot(a.botId).name, text: '', time: Date.now() });
            emit('room', { roomId: a.roomId });
          }
        }
        emit('live', {});
        return null;
      }
      case 'answer-question': {
        delete questions[p.sessionId];
        const b = bots.find((x) => x.sessionId === p.sessionId)!;
        const answer = [...(p.answer?.selected ?? []), p.answer?.custom].filter(Boolean).join('、');
        chats.get(b.id)!.push({ kind: 'answer', text: answer, time: Date.now() });
        emit('message', { botId: b.id, sessionId: b.sessionId, item: { kind: 'answer', text: answer, time: Date.now() } });
        bump();
        void reply(b, answer);
        return null;
      }
      case 'dismiss-question':
        delete questions[p.sessionId];
        bump();
        return null;
      case 'view-reply':
      case 'dismiss-view':
        delete views[p.sessionId];
        bump();
        return null;
      case 'memory-view':
        return { entries: memory.get(p.roomId ?? p.botId) ?? [], summary: { text: (memory.get(p.roomId ?? p.botId) ?? []).length ? '记得的事不多，主要是作息和交周报的时间。' : undefined } };
      case 'memory-add': {
        const key = p.roomId ?? p.botId;
        memory.set(key, [...(memory.get(key) ?? []), { scope: p.roomId ? 'group' : 'own', text: p.text, added: new Date().toISOString().slice(0, 10), by: 'user' }]);
        return handle('memory-view', p);
      }
      case 'memory-edit':
      case 'memory-forget': {
        const key = p.roomId ?? p.botId;
        const list = memory.get(key) ?? [];
        const i = list.findIndex((e) => e.text === p.text && e.scope === p.scope);
        if (i >= 0) {
          if (endpoint === 'memory-edit') list[i] = { ...list[i], text: p.next, by: 'user' };
          else list.splice(i, 1);
        }
        return handle('memory-view', p);
      }
      case 'usage-summary': {
        const t = (k: number) => ({ input: 18000 * k, cacheRead: 52000 * k, cacheWrite: 0, output: 6100 * k, calls: 14 * k });
        return { scanning: false, day: t(1), week: t(5), month: t(17), models: [{ key: MODELS[0].ref, name: MODELS[0].name, ...t(15) }, { key: MODELS[1].ref, name: MODELS[1].name, ...t(2) }] };
      }
      case 'file-text':
        return { text: '（原型里没有长消息的全文）', whole: true };
    }
    throw new DsBotError(`unknown endpoint ${endpoint}`, 'bot/unknown');
  };

  return () => ({
    call: (endpoint, payload) => handle(endpoint, payload as Record<string, any>),
    openFeed(onEvent, onEnd) {
      const sink: Sink = (e, d) => onEvent(e, d);
      sinks.add(sink);
      setTimeout(() => onEvent('hello', { revision, api: 1, boot, seq: noticeSeq }), 30);
      return () => {
        sinks.delete(sink);
        onEnd();
      };
    },
  });
}
