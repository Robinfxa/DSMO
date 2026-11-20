// dsmo-lore：设定集（LORE-DESIGN.md）。写小说、跑团、长篇扮演时，让 AI 记得人物是谁、写到第几章时处在什么状态、世界有哪些规矩。
// 和陪伴无关、单独可用：自己管「对话 › 工作区 › 默认」用哪部作品（默认关）。每轮不调模型：
// 常驻一份人物名单（≤ 200 字），按对话里提到的名字挑设定注入（默认 ≤ 600 字），三个工具让 AI 查、记、检查。

import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, addCharacter, addEntry, checkFacts, checkReport, checkRequest, compose, emptyWork, entryOf, lookup, nextSticky, normalizeWork, recordStates, roster, toWorldbook, updateCharacter, verifyCheck } from './core.mjs';
import { applyImport, importReport, readImport, undoImport } from './import.mjs';
import { completeText, configSchema, jsonStore, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, storageDir, textOf, trackLatest } from './shared/dsh.mjs';
import { OFF, createLayers, validId, workspaceFinder } from './shared/layers.mjs';

export const name = 'dsmo-lore';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = {
  /** 每轮注入的设定最多多少字。 */
  budgetChars: LIMITS.budget,
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
      description: '查设定集：人物的完整卡片、某一章时的状态和关系、相关设定。回溯旧章节时给 chapter（默认是现在写到的章节）。',
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
  ctx.inject(['tools'], (sub) => {
    for (const t of tools)
      sub.effect(() =>
        sub.tools.register(t, {
          when: ({ agent }) => !!workFor(rootId(agent?.session)),
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
  });

  // ---- 接口（给 DSMO 的「设定集」页）----
  const summary = (w) => ({ id: w.id, title: w.title, chapter: w.cursor.chapter, characters: w.characters.length, entries: w.lore.length, states: w.states.length, updatedAt: w.updatedAt });
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
