// dsmo-lore：设定集（LORE-DESIGN.md）。写小说、跑团、长篇扮演时，让 AI 记得人物是谁、写到第几章时处在什么状态、世界有哪些规矩。
// 和陪伴无关、单独可用：自己管「对话 › 工作区 › 默认」用哪部作品（默认关）。注入不调模型：
// 常驻一份人物名单（≤ 200 字），按对话里提到的名字挑设定注入（默认 ≤ 600 字），三个工具让 AI 查、记、检查。
// 每轮写完在后台整理一次这一轮的变化（§14，auto.mjs）：状态和关系直接记，新人物、新设定进待确认（自动模式时直接收下）。

import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, addCharacter, addEntry, checkFacts, checkReport, checkRequest, compose, emptyWork, entryOf, lookup, nextSticky, normalizeWork, recordStates, roster, toWorldbook, updateCharacter, verifyCheck } from './core.mjs';
import { acceptPending, applyAuto, autoRequest, chapterFromText, dismissPending, shouldRecord, undoAutoTurn, vanishedTurns } from './auto.mjs';
import { applyEdits, planEdits, reviewDetail, startPlan, undoEdits } from './edit.mjs';
import { applyImport, importReport, readImport, undoImport } from './import.mjs';
import { completeText, configSchema, jsonStore, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, storageDir, textOf, trackLatest, turnOf } from './shared/dsh.mjs';
import { OFF, createLayers, validId, workspaceFinder } from './shared/layers.mjs';

export const name = 'dsmo-lore';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = {
  /** 每轮注入的设定最多多少字。 */
  budgetChars: LIMITS.budget,
  /** 还没用作品的对话里也给 AI 一个 lore_start（约 80 字），让用户在聊天里开始一本（§15.1）。 */
  chatStart: true,
  /** 一致性检查用的模型；provider 和 model 要成对给，不给就用会话当前的模型。 */
  provider: '',
  model: '',
  /** 数据目录，默认 <DSH_HOME>/storages/dsmo-lore。 */
  dataDir: '',
};
export const Config = configSchema(name, DEFAULTS, { budgetChars: [300, 1000] });

export const API = '/api/dsmo-lore';
const WORK_ID = /^w-[a-z0-9-]{1,40}$/;
const MAX_FILE = 4 * 1024 * 1024;

export function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const log = loggerOf(ctx, name);
  const base = storageDir(name, c.dataDir);
  const worksDir = path.join(base, 'works');

  // ---- 作品 ----
  const works = new Map();
  try {
    for (const f of fs.readdirSync(worksDir)) {
      if (!f.endsWith('.json')) continue;
      const w = normalizeWork(jsonStore(worksDir, f, log).load());
      if (w && WORK_ID.test(w.id) && `${w.id}.json` === f) works.set(w.id, w);
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') log(`读作品目录失败：${e?.message ?? e}`);
  }
  function saveWork(w) {
    const size = Buffer.byteLength(JSON.stringify(w));
    if (size > MAX_FILE) throw new Error(`《${w.title}》太大了（${Math.round(size / 1024)} KB，上限 4 MB）：删掉一些设定或拆成两部`);
    jsonStore(worksDir, `${w.id}.json`, log).save(w);
  }
  /** 改一部作品：fn 抛错时不落盘（内存里的改动也撤回）。 */
  function mutateWork(id, fn) {
    const w = works.get(id);
    if (!w) throw new Error('找不到这部作品');
    const snapshot = JSON.stringify(w);
    try {
      const out = fn(w);
      saveWork(w);
      return out;
    } catch (e) {
      works.set(id, normalizeWork(JSON.parse(snapshot)));
      throw e;
    }
  }

  // ---- 哪段对话用哪部作品（对话 › 工作区 › 默认，Bot 一律关；默认出厂是关）----
  const bindStore = jsonStore(base, 'bindings.json', log);
  const bindings = { v: 1, default: OFF, workspaces: {}, conversations: {}, bots: [], ...(bindStore.load() ?? {}) };
  const layers = createLayers(bindings, {
    usable: (id) => works.has(id),
    fallback: OFF,
    workspaceOf: workspaceFinder(ctx),
    save: () => {
      try {
        bindStore.save(bindings);
      } catch (e) {
        log(`绑定保存失败：${e?.message ?? e}`);
      }
    },
  });
  /** 子代理用它父会话的作品。 */
  const rootId = (session) => session?.header?.parentSession ?? session?.id ?? '';
  const binding = (sessionId) => {
    const r = layers.resolve(sessionId);
    return { work: r.value === OFF ? null : r.value, from: r.from, workspaceId: r.workspaceId };
  };
  const workFor = (sessionId) => {
    if (!validId(sessionId)) return null;
    const id = binding(sessionId).work;
    return id ? works.get(id) ?? null : null;
  };

  // ---- 注入 ----
  const sessionOf = (ac) => ac?.agent?.session ?? null;
  const isSub = (s) => s?.header?.origin === 'subagent' || !!s?.header?.parentSession;
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'dsmo-lore:roster',
      order: 150,
      interpolate: false,
      text: (ac) => {
        const s = sessionOf(ac);
        const w = s && !isSub(s) ? workFor(s.id) : null;
        return w ? roster(w) : '';
      },
    }),
  );

  const latestOf = trackLatest(ctx);
  /** 每段对话：这一轮的输入（对方的话 + 上一条回复结尾）、这一轮用的粘性、下一轮的粘性、缓存的文字。 */
  const turns = new Map();
  let alive = true;
  ctx.effect(() => () => {
    alive = false;
  });
  const lastReply = (s) => {
    try {
      return textOf(s.deriveMessages().findLast((m) => m?.role === 'assistant'));
    } catch {
      return '';
    }
  };
  function perTurn(ac) {
    const s = sessionOf(ac);
    if (!s || isSub(s)) return '';
    const w = workFor(s.id);
    if (!w) return '';
    const latest = latestOf(ac);
    const tail = lastReply(s).slice(-(Number(w.settings.scanTail) || LIMITS.scanTail));
    const key = `${w.id}\u0000${latest}\u0000${tail.length}\u0000${tail.slice(-40)}`;
    let t = turns.get(s.id);
    if (!t || t.key !== key) {
      // 新的一轮：用上一轮留下的粘性，算完再推进
      const sticky = t?.next;
      t = { key, sticky, next: null, at: -1, text: '' };
      turns.set(s.id, t);
      if (turns.size > 200) turns.delete(turns.keys().next().value);
    }
    // 同一轮里作品被改了（工具记了状态）：用同一份粘性重算，粘性不重复推进
    if (t.at !== w.updatedAt) {
      const out = compose(w, { latest, tail, sticky: t.sticky, budget: c.budgetChars });
      t.text = out.text;
      t.at = w.updatedAt;
      if (!t.next) t.next = nextSticky(t.sticky, out.hits);
    }
    return t.text;
  }
  ctx.effect(() => promptContext(ctx, { name: 'dsmo-lore', order: 320, text: perTurn }));

  // ---- 三个工具（只在用了作品的对话里出现）----
  const textOut = { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, v) => [{ type: 'text', text: v.text }] };
  const NO_WORK = '这段对话没有用设定集：在 DSMO 的「设定集」里给它（或它的工作区）选一部作品。';
  const execWork = (exec) => workFor(rootId(exec?.agent?.session));
  const intArg = (v) => (v === undefined || v === null ? undefined : Number.isInteger(v) && v >= 0 ? v : NaN);
  const tools = [
    {
      name: 'lore_lookup',
      description: '查设定集：人物的完整卡片、某一章时的状态和关系、相关设定；names 写「第 N 章」查那一章的情节。回溯旧章节时给 chapter（默认是现在写到的章节）。',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'string', description: '人物或设定的名字 / 别名，多个用「、」隔开（最多 5 个）' },
          chapter: { type: 'integer', description: '查第几章时的样子' },
          history: { type: 'boolean', description: '列出每一项状态的变化线' },
        },
        required: ['names'],
      },
      output: textOut,
      async execute(args, exec) {
        const w = execWork(exec);
        if (!w) return { text: NO_WORK };
        const ch = intArg(args?.chapter);
        if (Number.isNaN(ch)) return { text: 'chapter 要是 0 或正整数' };
        return { text: lookup(w, String(args?.names ?? ''), { chapter: ch, history: !!args?.history }) };
      },
    },
    {
      name: 'lore_record_state',
      description: '记下人物或设定的变化（受伤、换地方、得失物品、身份、立场、关系），从某一章起为真。subject 写「甲/乙」记两人关系。单值用 replace，列表（持有物等）用 add / remove。尽量附正文原句。',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            description: '1–10 条变化',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: '人物 / 设定的名字或别名；关系写「甲/乙」' },
                key: { type: 'string', description: '哪一项：位置、伤势、持有、境界、身份、立场、关系……（≤12 字）' },
                value: { type: 'string', description: '新值（≤60 字）' },
                op: { type: 'string', enum: ['replace', 'add', 'remove'] },
                until: { type: 'integer', description: '到第几章为止（含）' },
                evidence: { type: 'string', description: '正文原句（≤60 字）' },
              },
              required: ['subject', 'key', 'value'],
            },
          },
          chapter: { type: 'integer', description: '从第几章起（默认现在写到的章节；更大时光标自动前进）' },
          create: { type: 'boolean', description: '主体不存在时新建一个次要人物（默认否）' },
        },
        required: ['changes'],
      },
      output: textOut,
      async execute(args, exec) {
        const w = execWork(exec);
        if (!w) return { text: NO_WORK };
        const ch = intArg(args?.chapter);
        if (Number.isNaN(ch)) return { text: 'chapter 要是 0 或正整数' };
        if (!Array.isArray(args?.changes) || !args.changes.length) return { text: 'changes 至少要有一条' };
        // 改早于现在章节的状态是重要改动：先复核（§15.4）
        if (ch !== undefined && ch < w.cursor.chapter) return edit(exec, w, [{ kind: 'state', chapter: ch, create: !!args.create, changes: args.changes }]);
        let r;
        try {
          r = mutateWork(w.id, (x) => recordStates(x, args.changes, { chapter: ch, create: !!args.create, source: 'tool' }));
        } catch (e) {
          return { text: `没记上：${e.message}` };
        }
        const lines = r.written.map((x) => `- [${x.id}] ${x.subject}·${x.key} ${{ replace: '=', add: '+', remove: '−' }[x.op]} ${x.value}（第 ${x.from} 章起${x.replaced ? '，改了这一章原来的记录' : ''}）`);
        return {
          text: [
            r.written.length ? `记下了 ${r.written.length} 条：\n${lines.join('\n')}` : '一条都没记上。',
            r.errors.length ? `没记上的：\n${r.errors.map((e) => `- ${e}`).join('\n')}` : '',
            r.cursorMoved ? `现在写到第 ${r.chapter} 章（光标已前进）。` : '',
          ].filter(Boolean).join('\n'),
        };
      },
    },
    {
      name: 'lore_check',
      description: '拿一段正文对照「那一章时的设定」查矛盾，结论都附原文。只报告，不改正文也不改设定。不给 text 就查这段对话最后一条回复。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要检查的正文（≤2 万字）' },
          chapter: { type: 'integer', description: '这段正文是第几章（默认现在写到的章节）' },
        },
      },
      output: textOut,
      async execute(args, exec) {
        const w = execWork(exec);
        if (!w) return { text: NO_WORK };
        const ch = intArg(args?.chapter);
        if (Number.isNaN(ch)) return { text: 'chapter 要是 0 或正整数' };
        const session = exec?.agent?.session;
        let text = String(args?.text ?? '');
        if (!text.trim()) {
          text = session ? lastReply(session) : '';
          if (text.length < 200) return { text: '最后一条回复太短（不到 200 字），请把要检查的正文放进 text。' };
        }
        const f = checkFacts(w, text, ch);
        if (!f.facts.length) return { text: checkReport({ ...f, facts: [] }) + (f.hard.length ? '' : '\n（正文里没有认出设定集里的人物或设定。）') };
        let answer;
        try {
          answer = await completeText(ctx, checkRequest(f), { session, provider: c.provider, model: c.model, maxTokens: 800, timeoutMs: 90_000 });
        } catch (e) {
          return { text: `${checkReport({ ...f })}\n\n（模型对照那一步失败：${e?.message ?? e}；上面只有本地规则查出的问题。）` };
        }
        const v = verifyCheck(answer, f);
        if (!v.ok) return { text: `${checkReport({ ...f })}\n\n（模型的回答读不出来，上面只有本地规则查出的问题。）` };
        return { text: checkReport({ ...f, ...v }) };
      },
    },
  ];

  // ---- 在聊天里建设定、记情节（§15）：小改直接生效，重要改动先复核 ----
  /** 这段对话里你说过几句（复核退回「下一轮确认」时，用来防止 AI 在同一轮里自己确认）。 */
  const userTurns = (session) => {
    try {
      return session.deriveMessages().filter((m) => m?.role === 'user' && (m.source?.kind ?? 'user') === 'user').length;
    } catch {
      return 0;
    }
  };
  /** 弹复核卡片（DSH 的「问用户」，DSMO 的聊天里能显示）；返回 'yes' | 'no' | 'pending'（弹不出卡片）。 */
  async function review(exec, title, lines) {
    const uq = ctx.get('userQuestions');
    if (typeof uq?.ask !== 'function' || !exec?.agent) return 'pending';
    try {
      const r = await uq.ask({
        agent: exec.agent,
        signal: exec.signal,
        questions: [
          {
            id: 'lore-review',
            header: '设定集',
            question: title,
            detail: lines,
            multiSelect: false,
            options: [
              { label: '确认', description: '照这样改' },
              { label: '不要', description: '什么都不改' },
            ],
            intent: { kind: 'approval', approve: '确认', reject: '不要' },
          },
        ],
      });
      return (r?.answers?.[0]?.selected ?? []).includes('确认') ? 'yes' : 'no';
    } catch (e) {
      if (exec.signal?.aborted) return 'no';
      log(`复核卡片弹不出来，改成下一轮确认：${e?.message ?? e}`);
      return 'pending';
    }
  }
  /** 等「下一轮确认」的：作品里的（work.pending，kind 'edit'）和还没有作品的开头（startPending）。 */
  const startPending = new Map();
  const pendingNote = (id, texts) =>
    `这些改动要用户确认（${id}）：\n${texts.map((x) => `- ${x}`).join('\n')}\n把它们原样告诉用户，问要不要这样改；用户在下一句里同意了再调 lore_confirm（id: ${id}）。同一轮里不能确认。`;

  /** 一批改动：小改直接生效，重要的先复核。 */
  async function edit(exec, w, changes) {
    const plan = planEdits(w, changes);
    const out = [];
    const minor = plan.items.filter((i) => !i.important);
    const major = plan.items.filter((i) => i.important);
    const sid = rootId(exec?.agent?.session);
    if (minor.length) {
      const r = mutateWork(w.id, (x) => applyEdits(x, minor, { sessionId: sid, source: 'chat' }));
      if (r.done.length) out.push(`已经改好（第 ${r.batchId} 批，可以用 lore_edit 的 undo 撤销）：\n${r.done.map((x) => `- ${x}`).join('\n')}`);
      if (r.failed.length) out.push(`没改成：\n${r.failed.map((x) => `- ${x}`).join('\n')}`);
    }
    if (major.length) {
      const verdict = await review(exec, '设定集：要这样改吗？', reviewDetail(major));
      if (verdict === 'yes') {
        // 用户点的那一刻作品可能又变了：按原话重新排一次再改
        const again = planEdits(works.get(w.id), major.map((i) => i.raw));
        const r = mutateWork(w.id, (x) => applyEdits(x, again.items, { sessionId: sid, source: 'chat-reviewed' }));
        if (r.done.length) out.push(`用户确认了，已经改好（第 ${r.batchId} 批）：\n${r.done.map((x) => `- ${x}`).join('\n')}`);
        if (r.failed.length || again.errors.length) out.push(`没改成：\n${[...r.failed, ...again.errors].map((x) => `- ${x}`).join('\n')}`);
      } else if (verdict === 'no') out.push(`用户没同意，这些没改：\n${major.map((i) => `- ${i.text}`).join('\n')}`);
      else {
        const id = `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        mutateWork(w.id, (x) => {
          x.pending = [...x.pending, { id, kind: 'edit', data: { changes: major.map((i) => i.raw), texts: major.map((i) => i.text) }, quote: '', turnId: '', sessionId: sid, userTurns: userTurns(exec?.agent?.session), at: Date.now() }].slice(-50);
          x.updatedAt = Date.now();
        });
        out.push(pendingNote(id, major.map((i) => i.text)));
      }
    }
    if (plan.errors.length) out.push(`看不懂的改动：\n${plan.errors.map((x) => `- ${x}`).join('\n')}`);
    return { text: out.join('\n\n') || '没有要改的。' };
  }

  /** 新建作品并让这段对话用它（总是复核）。 */
  function startWork(sid, plan) {
    const w = createWork(plan.title);
    layers.setConversation(sid, w.id);
    const p = planEdits(w, plan.changes);
    const r = mutateWork(w.id, (x) => applyEdits(x, p.items, { sessionId: sid, source: 'chat-start' }));
    return { w, r, errors: p.errors };
  }
  const startText = ({ w, r, errors }) =>
    [`建好了《${w.title}》，这段对话从现在起用它。`, r.done.length ? `一起建好的：\n${r.done.map((x) => `- ${x}`).join('\n')}` : '', [...r.failed, ...errors].length ? `没建成：\n${[...r.failed, ...errors].map((x) => `- ${x}`).join('\n')}` : ''].filter(Boolean).join('\n');

  const CHANGE = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['character', 'entry', 'plot', 'remove', 'rename', 'chapter'] },
      name: { type: 'string', description: 'character：人物名（已有的就是改它）' },
      newName: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string', description: 'character：一句话简介；plot：这一章的梗概（≤300 字）' },
      appearance: { type: 'string' },
      personality: { type: 'string' },
      background: { type: 'string' },
      voice: { type: 'string', description: '说话方式 / 台词样本' },
      main: { type: 'boolean', description: '主要人物' },
      secret: { type: 'boolean', description: '隐藏人物（揭晓前不进名单）' },
      debut: { type: 'integer', description: '第几章登场' },
      title: { type: 'string', description: 'entry：设定标题；rename：新书名；plot：这一章的小标题' },
      newTitle: { type: 'string' },
      keys: { type: 'array', items: { type: 'string' }, description: 'entry：对话里出现就带上这条的关键词' },
      content: { type: 'string', description: 'entry：设定内容' },
      constant: { type: 'boolean', description: 'entry：每轮都带' },
      from: { type: 'integer', description: 'plot / entry：从第几章' },
      to: { type: 'integer', description: 'plot：到第几章（几章合一条时）' },
      until: { type: 'integer', description: 'entry：到第几章为止' },
      target: { type: 'string', description: 'remove：人物名、设定标题或「第 N 章」' },
      chapter: { type: 'integer', description: 'chapter：现在写到第几章' },
    },
    required: ['kind'],
  };
  const editTools = [
    {
      tool: {
        name: 'lore_start',
        description: '用户想写小说、想建人物设定时：新建一本作品并让这段对话用它，可顺带建人物、设定、已有情节。会先请用户确认。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '书名' },
            characters: { type: 'array', items: CHANGE },
            entries: { type: 'array', items: CHANGE },
            plot: { type: 'array', items: CHANGE, description: '已有情节：每章一条（from / to / summary）' },
            chapter: { type: 'integer', description: '现在写到第几章' },
          },
          required: ['title'],
        },
        output: textOut,
        async execute(args, exec) {
          const session = exec?.agent?.session;
          const sid = rootId(session);
          if (workFor(sid)) return { text: '这段对话已经在用一本作品了，用 lore_edit 改它。' };
          let plan;
          try {
            plan = startPlan(args ?? {});
          } catch (e) {
            return { text: e.message };
          }
          const p = planEdits({ ...emptyWork({ title: plan.title }) }, plan.changes);
          const lines = [`· 新建作品《${plan.title}》，这段对话用它`, ...p.items.map((i) => `· ${i.text}`)].join('\n');
          const verdict = await review(exec, '设定集：建这本作品吗？', lines);
          if (verdict === 'no') return { text: '用户没同意，没有建。' };
          if (verdict === 'yes') {
            try {
              return { text: startText(startWork(sid, plan)) };
            } catch (e) {
              return { text: `没建成：${e.message}` };
            }
          }
          const id = `s-${Date.now().toString(36)}`;
          startPending.set(sid, { id, plan, userTurns: userTurns(session) });
          return { text: pendingNote(id, [`新建作品《${plan.title}》，这段对话用它`, ...p.items.map((i) => i.text)]) };
        },
      },
      when: (sid) => c.chatStart && !workFor(sid) && !layers.isBot(sid),
    },
    {
      tool: {
        name: 'lore_edit',
        description: '按用户说的改设定集：新建或修改人物、设定，记某一章的情节，删除，改书名，把章节往回拨。新增少量直接生效；改掉已有内容、删除、一次加很多会先请用户确认。undo 填批号可整批撤销。',
        parameters: {
          type: 'object',
          properties: {
            changes: { type: 'array', items: CHANGE, description: '1–40 条改动' },
            undo: { type: 'string', description: '要撤销的批号（之前返回的「第 b-… 批」）' },
          },
        },
        output: textOut,
        async execute(args, exec) {
          const w = execWork(exec);
          if (!w) return { text: NO_WORK };
          if (args?.undo) {
            try {
              const r = mutateWork(w.id, (x) => {
                const u = undoEdits(x, String(args.undo));
                if (!u.ok) throw new Error(u.error);
                return u;
              });
              return { text: `撤销了：\n${r.undone.map((x) => `- ${x}`).join('\n')}` };
            } catch (e) {
              return { text: e.message };
            }
          }
          if (!Array.isArray(args?.changes) || !args.changes.length) return { text: 'changes 至少要有一条（或者给 undo）' };
          try {
            return await edit(exec, w, args.changes);
          } catch (e) {
            return { text: `没改成：${e.message}` };
          }
        },
      },
      when: (sid) => !!workFor(sid),
    },
    {
      tool: {
        name: 'lore_confirm',
        description: '只在设定集说「等用户确认」、而用户在下一句里同意了时用：确认那批改动。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        output: textOut,
        async execute(args, exec) {
          const session = exec?.agent?.session;
          const sid = rootId(session);
          const id = String(args?.id ?? '');
          const now = userTurns(session);
          const st = startPending.get(sid);
          if (st && st.id === id) {
            if (now <= st.userTurns) return { text: '要等用户在下一句里同意了才能确认。' };
            startPending.delete(sid);
            try {
              return { text: startText(startWork(sid, st.plan)) };
            } catch (e) {
              return { text: `没建成：${e.message}` };
            }
          }
          const w = execWork(exec);
          const p = w?.pending.find((x) => x.id === id && x.kind === 'edit');
          if (!p) return { text: '找不到这批待确认的改动（可能已经确认或不要了）。' };
          if (p.sessionId === sid && now <= (p.userTurns ?? 0)) return { text: '要等用户在下一句里同意了才能确认。' };
          const again = planEdits(w, p.data.changes);
          const r = mutateWork(w.id, (x) => {
            x.pending = x.pending.filter((y) => y.id !== id);
            return applyEdits(x, again.items, { sessionId: sid, source: 'chat-reviewed' });
          });
          return { text: [r.done.length ? `确认了，已经改好（第 ${r.batchId} 批）：\n${r.done.map((x) => `- ${x}`).join('\n')}` : '', [...r.failed, ...again.errors].length ? `没改成：\n${[...r.failed, ...again.errors].map((x) => `- ${x}`).join('\n')}` : ''].filter(Boolean).join('\n') || '没有要改的。' };
        },
      },
      when: (sid) => !!workFor(sid) || startPending.has(sid),
    },
  ];

  ctx.inject(['tools'], (sub) => {
    for (const t of tools)
      sub.effect(() =>
        sub.tools.register(t, {
          when: ({ agent }) => !!workFor(rootId(agent?.session)),
        }),
      );
    for (const { tool, when } of editTools)
      sub.effect(() =>
        sub.tools.register(tool, {
          when: ({ agent }) => !!agent?.session && !isSub(agent.session) && when(rootId(agent.session)),
        }),
      );
  });

  // ---- 给别的插件的服务（MaiDSH 记忆用它让位：用了作品的对话里，故事世界设定以设定集为准）----
  ctx.provide('lore', {
    version: 1,
    covers: (sessionId) => !!workFor(sessionId),
    workFor: (sessionId) => {
      const w = workFor(sessionId);
      return w ? { id: w.id, title: w.title, chapter: w.cursor.chapter } : null;
    },
    lookup: (sessionId, names, chapter) => {
      const w = workFor(sessionId);
      return w ? lookup(w, names, { chapter }) : '';
    },
    /** 等后台的自动整理做完（测试用）。 */
    idle: async () => {
      while (autoRuns.size) await Promise.all([...autoRuns]);
    },
  });

  // ---- 接口（给 DSMO 的「设定集」页）----
  const summary = (w) => ({ id: w.id, title: w.title, chapter: w.cursor.chapter, characters: w.characters.length, entries: w.lore.length, states: w.states.length, updatedAt: w.updatedAt, pending: w.pending.length, lastAuto: w.lastAuto });

  // ---- 聊天时自动整理（§14）：每部作品一次只整理一轮，整理中又来的只留最新一轮 ----
  const autoQ = new Map();
  const autoRuns = new Set();
  async function runAuto(workId, j) {
    const w = works.get(workId);
    if (!w) return;
    const named = chapterFromText(j.user);
    const chapter = named !== null && named > w.cursor.chapter ? named : w.cursor.chapter;
    const { req } = autoRequest(w, { user: j.user, reply: j.reply, chapter });
    const answer = await completeText(ctx, req, { session: j.session, provider: c.provider, model: c.model, maxTokens: 800, timeoutMs: 90_000 });
    if (!alive || !works.has(workId)) return;
    mutateWork(workId, (x) => {
      if (named !== null && named > x.cursor.chapter) x.cursor.chapter = named;
      const r = applyAuto(x, answer, { user: j.user, reply: j.reply, chapter, turnId: j.turnId, sessionId: j.sessionId });
      if (!r.ok) log('自动整理设定：模型的回答读不出来，这一轮跳过');
    });
  }
  function queueAuto(workId, job) {
    const q = autoQ.get(workId);
    if (q) {
      q.next = job;
      return;
    }
    const state = { next: null };
    autoQ.set(workId, state);
    const run = (async () => {
      await null;
      let j = job;
      try {
        while (j && alive) {
          await runAuto(workId, j).catch((e) => log(`自动整理设定失败：${e?.message ?? e}`));
          j = state.next;
          state.next = null;
        }
      } finally {
        autoQ.delete(workId);
      }
    })();
    autoRuns.add(run);
    void run.finally(() => autoRuns.delete(run));
  }
  ctx.on('session/event', (a, b) => {
    const turn = turnOf(a, b);
    if (!turn || !alive) return;
    const w = workFor(turn.sessionId);
    if (!w) return;
    let msgs;
    try {
      msgs = turn.session.deriveMessages();
    } catch {
      return;
    }
    // 重新生成 / 回退掉的回复：那一轮自动记的东西撤掉
    const gone = vanishedTurns(w, turn.sessionId, msgs.map((m) => m?.id).filter(Boolean));
    if (gone.length) {
      try {
        mutateWork(w.id, (x) => {
          for (const t of gone) undoAutoTurn(x, t);
        });
      } catch (e) {
        log(`撤销重新生成前的自动整理失败：${e?.message ?? e}`);
      }
    }
    const turnId = msgs.findLast((m) => m?.role === 'assistant')?.id;
    if (!turnId || !shouldRecord(works.get(w.id), turn.reply)) return;
    queueAuto(w.id, { sessionId: turn.sessionId, user: turn.user, reply: turn.reply, turnId, session: turn.session });
  });
  function createWork(title) {
    if (works.size >= LIMITS.works) throw new Error(`最多 ${LIMITS.works} 部作品`);
    const t = String(title ?? '').trim();
    if (!t) throw new Error('作品要有名字');
    if ([...works.values()].some((w) => w.title === t)) throw new Error('已经有同名的作品');
    const w = emptyWork({ title: t });
    saveWork(w);
    works.set(w.id, w);
    return w;
  }
  function deleteWork(id) {
    if (!works.has(id)) throw new Error('找不到这部作品');
    works.delete(id);
    fs.rmSync(path.join(worksDir, `${id}.json`), { force: true });
    layers.forget(id, OFF);
  }
  const find = (list, id, what) => {
    const x = list.find((y) => y.id === id);
    if (!x) throw new Error(`找不到这个${what}`);
    return x;
  };
  const MUTATIONS = {
    'create-work': (b) => summary(createWork(b.title)),
    'rename-work': (b) =>
      mutateWork(b.id, (w) => {
        const t = String(b.title ?? '').trim().slice(0, 40);
        if (!t) throw new Error('作品要有名字');
        w.title = t;
        w.updatedAt = Date.now();
        return summary(w);
      }),
    'delete-work': (b) => (deleteWork(b.id), { id: b.id }),
    'set-cursor': (b) =>
      mutateWork(b.work, (w) => {
        if (!Number.isInteger(b.chapter) || b.chapter < 0) throw new Error('chapter 要是 0 或正整数');
        w.cursor.chapter = b.chapter;
        w.updatedAt = Date.now();
        return summary(w);
      }),
    settings: (b) =>
      mutateWork(b.work, (w) => {
        if (b.userName !== undefined) w.settings.userName = String(b.userName).trim().slice(0, 20) || '主角';
        if (b.scanTail !== undefined) w.settings.scanTail = Math.min(4000, Math.max(0, Number(b.scanTail) || 0));
        if (b.autoRecord !== undefined) {
          if (!['long', 'every', 'off'].includes(b.autoRecord)) throw new Error('autoRecord 只能是 long / every / off');
          w.settings.autoRecord = b.autoRecord;
        }
        if (b.autoAccept !== undefined) w.settings.autoAccept = !!b.autoAccept;
        w.updatedAt = Date.now();
        return w.settings;
      }),
    'upsert-character': (b) => mutateWork(b.work, (w) => (b.id ? updateCharacter(w, b.id, b) : addCharacter(w, b))),
    'delete-character': (b) =>
      mutateWork(b.work, (w) => {
        find(w.characters, b.id, '人物');
        w.characters = w.characters.filter((x) => x.id !== b.id);
        w.states = w.states.filter((s) => s.subject !== b.id);
        w.relations = w.relations.filter((r) => r.a !== b.id && r.b !== b.id);
        w.updatedAt = Date.now();
        return { id: b.id };
      }),
    'upsert-entry': (b) =>
      mutateWork(b.work, (w) => {
        if (!b.id) return addEntry(w, b);
        const e = find(w.lore, b.id, '设定');
        Object.assign(e, entryOf({ ...e, ...b }), { id: e.id, source: e.source });
        w.updatedAt = Date.now();
        return e;
      }),
    'delete-entry': (b) =>
      mutateWork(b.work, (w) => {
        find(w.lore, b.id, '设定');
        w.lore = w.lore.filter((x) => x.id !== b.id);
        w.states = w.states.filter((s) => s.subject !== b.id);
        w.updatedAt = Date.now();
        return { id: b.id };
      }),
    'record-states': (b) => mutateWork(b.work, (w) => recordStates(w, b.changes, { chapter: b.chapter, create: !!b.create, source: 'user' })),
    'delete-state': (b) =>
      mutateWork(b.work, (w) => {
        find(w.states, b.id, '状态');
        w.states = w.states.filter((x) => x.id !== b.id);
        for (const s of w.states) if (s.supersededBy === b.id) delete s.supersededBy;
        w.updatedAt = Date.now();
        return { id: b.id };
      }),
    'undo-edits': (b) =>
      mutateWork(b.work, (w) => {
        const r = undoEdits(w, String(b.batchId ?? ''));
        if (!r.ok) throw new Error(r.error);
        return r;
      }),
    'upsert-plot': (b) => mutateWork(b.work, (w) => applyEdits(w, planEdits(w, [{ ...b, kind: 'plot' }]).items, { source: 'user' })),
    'accept-pending': (b) => mutateWork(b.work, (w) => acceptPending(w, b.id === 'all' ? 'all' : String(b.id ?? ''))),
    'dismiss-pending': (b) => mutateWork(b.work, (w) => dismissPending(w, b.id === 'all' ? 'all' : String(b.id ?? ''))),
    'undo-auto': (b) =>
      mutateWork(b.work, (w) => {
        if (!w.autoTurns.some((t) => t.turnId === b.turnId)) throw new Error('找不到这一轮自动整理（可能已经撤销了）');
        return undoAutoTurn(w, b.turnId);
      }),
    'delete-relation': (b) =>
      mutateWork(b.work, (w) => {
        find(w.relations, b.id, '关系');
        w.relations = w.relations.filter((x) => x.id !== b.id);
        for (const r of w.relations) if (r.supersededBy === b.id) delete r.supersededBy;
        w.updatedAt = Date.now();
        return { id: b.id };
      }),
  };

  async function doImport(b) {
    let png;
    if (typeof b.pngBase64 === 'string') png = Buffer.from(b.pngBase64, 'base64');
    let w = b.work ? works.get(b.work) : null;
    if (b.work && !w) throw new Error('找不到这部作品');
    const userName = String(b.userName ?? w?.settings.userName ?? '主角');
    const firstMain = w?.characters.find((x) => x.tier === 'main')?.name ?? '';
    const plan = readImport({ kind: b.kind === 'worldbook' ? 'worldbook' : 'card', json: b.json, png, userName, charFallback: firstMain });
    const conflicts = w ? plan.characters.filter((p) => w.characters.some((x) => x.name === p.name)).map((p) => p.name) : [];
    const duplicate = !!w?.imports.some((j) => j.hash === plan.hash && !j.undone);
    if (b.dryRun) return { report: importReport(plan, { conflicts }), characters: plan.characters.length, entries: plan.entries.length, conflicts, duplicate, skipped: plan.skipped };
    if (!w) w = createWork(String(b.title ?? '').trim() || plan.characters[0]?.name || String(b.filename ?? '').replace(/\.[^.]+$/, '') || '导入的设定');
    if (b.userName !== undefined) w.settings.userName = userName.slice(0, 20);
    const jobId = `imp${Date.now().toString(36)}`;
    const r = mutateWork(w.id, (x) => applyImport(x, plan, { jobId, filename: b.filename, onConflict: b.onConflict, force: !!b.force }));
    if (r.duplicate) throw new Error('这份文件已经导入过这部作品了（要再导一次就带 force）');
    if (!r.ok) return { needsChoice: true, conflicts: r.conflicts, report: importReport(plan, { conflicts: r.conflicts }) };
    return { work: summary(works.get(w.id)), jobId, report: importReport(plan, r), ...r };
  }

  const route = (sub, p, handler, { write = false, limit } = {}) =>
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: `${API}${p}`,
        handler: async (req, res) => {
          const isGet = (req.method ?? 'GET') === 'GET';
          const no = isGet ? rejectRead(ctx, req) : rejectWrite(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          if (!isGet && !write) return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          const q = new URL(req.url ?? '/', 'http://x').searchParams;
          let body = null;
          if (!isGet) {
            body = await readJsonBody(req, limit);
            if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad json（或者内容太大）' });
          }
          try {
            const value = await handler({ q, body, isGet });
            sendJson(res, 200, { ok: true, value });
          } catch (e) {
            sendJson(res, e?.status ?? 400, { ok: false, error: String(e?.message ?? e) });
          }
        },
      }),
    );
  const notFound = (msg) => Object.assign(new Error(msg), { status: 404 });

  ctx.inject(['webServer'], (sub) => {
    route(sub, '/works', () => [...works.values()].map(summary).sort((a, b) => b.updatedAt - a.updatedAt));
    route(sub, '/work', ({ q }) => {
      const w = works.get(q.get('id') ?? '');
      if (!w) throw notFound('找不到这部作品');
      return w;
    });
    route(
      sub,
      '/mutate',
      ({ body }) => {
        const fn = MUTATIONS[body.action];
        if (!fn) throw new Error(`不认识的操作；可用：${Object.keys(MUTATIONS).join(' / ')}`);
        return fn(body);
      },
      { write: true },
    );
    route(
      sub,
      '/binding',
      ({ q, body, isGet }) => {
        if (isGet) {
          const sid = q.get('sessionId');
          return sid ? { sessionId: sid, ...binding(sid), conversation: layers.conversation(sid) } : layers.view();
        }
        const ok =
          body.action === 'set'
            ? layers.setConversation(body.sessionId, body.work)
            : body.action === 'set-workspace'
              ? layers.setWorkspace(body.workspaceId, body.work)
              : body.action === 'set-default'
                ? layers.setDefault(body.work)
                : body.action === 'set-bots'
                  ? (layers.setBots(body.sessionIds), true)
                  : null;
        if (ok === null) throw new Error('要 set（sessionId + work）、set-workspace（workspaceId + work）、set-default（work）或 set-bots（sessionIds）；work 是作品 id、"off" 或 null（跟随上一层）');
        if (!ok) throw new Error('设置不对：对话 / 工作区 id 或作品 id 无效');
        return body.action === 'set' ? { sessionId: body.sessionId, ...binding(body.sessionId) } : layers.view();
      },
      { write: true },
    );
    route(sub, '/import', ({ body }) => doImport(body), { write: true, limit: 12 * 1024 * 1024 });
    route(sub, '/import/undo', ({ body }) => mutateWork(body.work, (w) => {
      const r = undoImport(w, body.jobId);
      if (!r.ok) throw new Error(r.error);
      return r;
    }), { write: true });
    route(sub, '/export', ({ q }) => {
      const w = works.get(q.get('work') ?? '');
      if (!w) throw notFound('找不到这部作品');
      return q.get('format') === 'st-worldbook' ? toWorldbook(w) : w;
    });
  });
}
