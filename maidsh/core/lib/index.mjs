// maidsh-core：陪伴套件的总控（CONTRACT.md §3–§4）。
// 自己什么都不注入；把装上的「面」（套件自带的和第三方的）组织起来：
// 每轮结束后一次模型调用分析所有面要的东西，下一轮把各面的提示按顺序、按预算拼成一段注入。
// 对外提供服务 companion：register(aspect) / aspects() / state()。

import { createJobs } from './jobs.mjs';
import { createCompanion } from './runtime.mjs';
import { completeText, configSchema, jsonStore, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, storageDir, textOf, trackLatest, turnOf } from './shared/dsh.mjs';

export const name = 'maidsh-core';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = {
  /** 合并分析用的模型；provider 和 model 要成对给，不给就用会话当前的模型。 */
  provider: '',
  model: '',
  /** 合并分析最多输出多少 token（截断时写完整的部分仍然有效）。 */
  maxOutputTokens: 1500,
  /** 学习任务的数据目录，默认 <DSH_HOME>/storages/maidsh-core。 */
  dataDir: '',
};

export const Config = configSchema(name, DEFAULTS, { maxOutputTokens: [200, 8000] });

export const STATE_PATH = '/api/maidsh/state';
export const LEARN_PATH = '/api/maidsh/learn';
export const JOBS_PATH = '/api/maidsh/jobs';

export function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const log = loggerOf(ctx, name);
  let alive = true;
  ctx.effect(() => () => {
    alive = false;
  });
  const companion = createCompanion({
    log,
    // 总控卸载后还在路上的分析：让它失败，结果不交给任何面
    complete: async (req, turn) => {
      const text = await completeText(ctx, req, { session: turn.session, provider: c.provider, model: c.model, maxTokens: c.maxOutputTokens });
      if (!alive) throw new Error('总控已卸载，丢弃这一轮的分析');
      return text;
    },
  });

  ctx.provide('companion', {
    version: companion.version,
    register: companion.register,
    aspects: companion.aspects,
    state: companion.state,
    learn: (body) => jobs.learn(body),
    jobs: () => jobs.list(),
    job: (action, id) => jobs.act(action, id),
  });

  const latestOf = trackLatest(ctx);
  ctx.effect(() => promptContext(ctx, { name: 'maidsh', order: 300, text: (ac) => companion.promptText(latestOf(ac)) }));

  let lastSession = null;
  ctx.on('session/event', (a, b) => {
    const turn = turnOf(a, b);
    if (!turn) return;
    lastSession = turn.session;
    companion.afterTurn(turn).catch((e) => log(`陪伴分析出错：${e?.message ?? e}`));
  });

  // 深度学习和导入（§11）：用配置的模型，否则 DSH 的默认模型，否则最近一个会话的模型
  const route = () => {
    if (c.provider && c.model) return { provider: c.provider, model: c.model };
    const d = ctx.get('agentDefaultModel')?.currentSelection?.();
    return d?.provider && d?.model ? { provider: d.provider, model: d.model } : {};
  };
  async function readSession(sessionId) {
    let session = ctx.get('sessions')?.get?.(sessionId);
    if (!session) {
      const r = await ctx.get('sessionController')?.resolveAgent?.(sessionId);
      session = r && !r.error ? r.agent?.session : null;
    }
    if (!session) throw new Error('找不到这段对话');
    const times = new Map();
    try {
      for (const e of session.ownEvents?.() ?? []) {
        const m = e?.data?.message ?? e?.data;
        if (m?.id && e.time) times.set(m.id, e.time);
      }
    } catch {
      /* 没有时间就不带 */
    }
    return session
      .deriveMessages()
      .filter((m) => (m.role === 'user' && (m.source?.kind ?? 'user') === 'user') || m.role === 'assistant')
      .map((m) => ({ role: m.role, text: textOf(m), at: times.get(m.id) }));
  }
  const jobs = createJobs({
    store: jsonStore(storageDir(name, c.dataDir), 'jobs.json', log),
    log,
    aspects: () => companion.registered(),
    safely: companion.safely,
    complete: (req) => {
      const r = route();
      if (!r.provider && !lastSession) throw Object.assign(new Error('还不知道用哪个模型：先在 DSMO 里聊一句，或在总控的设置里填 provider 和 model'), { fatal: true });
      return completeText(ctx, req, { session: lastSession, ...r, maxTokens: 3000, timeoutMs: 120_000 });
    },
    readSession,
  });
  ctx.effect(() => {
    // 等各面登记好再接着跑没跑完的
    const t = setTimeout(() => void jobs.resume(), 5000);
    t.unref?.();
    return () => {
      clearTimeout(t);
      jobs.stop();
    };
  });

  // 给 DSMO「陪伴」页的只读状态。只接本机请求；新版 DSH 的路由自带鉴权，老版本这里再问一次 connection。
  ctx.inject(['webServer'], (sub) => {
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => {
          const no = rejectRead(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          sendJson(res, 200, { ok: true, value: companion.state() });
        },
      }),
    );
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: LEARN_PATH,
        handler: async (req, res) => {
          const no = rejectWrite(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          const body = await readJsonBody(req, 2 * 1024 * 1024); // 20 万字约 600 KB，留足余量
          if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad json（内容太大时请分几次）' });
          const out = await jobs.learn(body);
          sendJson(res, out.ok ? 200 : 400, out);
        },
      }),
    );
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: JOBS_PATH,
        handler: async (req, res) => {
          if ((req.method ?? 'GET') === 'GET') {
            const no = rejectRead(ctx, req);
            if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
            return sendJson(res, 200, { ok: true, value: jobs.list() });
          }
          const no = rejectWrite(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          const body = await readJsonBody(req);
          const out = jobs.act(body?.action, body?.id);
          sendJson(res, out.ok ? 200 : 400, out);
        },
      }),
    );
  });
}
