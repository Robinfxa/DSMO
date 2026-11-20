// maidsh-core：陪伴套件的总控（CONTRACT.md §3–§4）。
// 自己什么都不注入；把装上的「面」（套件自带的和第三方的）组织起来：
// 每轮结束后一次模型调用分析所有面要的东西，下一轮把各面的提示按顺序、按预算拼成一段注入。
// 对外提供服务 companion：register(aspect) / aspects() / state()。

import { createCompanion } from './runtime.mjs';
import { completeText, configSchema, trackLatest, loggerOf, promptContext, rejectRead, sendJson, turnOf } from './shared/dsh.mjs';

export const name = 'maidsh-core';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = {
  /** 合并分析用的模型；provider 和 model 要成对给，不给就用会话当前的模型。 */
  provider: '',
  model: '',
  /** 合并分析最多输出多少 token。 */
  maxOutputTokens: 600,
};

export const Config = configSchema(name, DEFAULTS, { maxOutputTokens: [100, 4000] });

export const STATE_PATH = '/api/maidsh/state';

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
  });

  const latestOf = trackLatest(ctx);
  ctx.effect(() => promptContext(ctx, { name: 'maidsh', order: 300, text: (ac) => companion.promptText(latestOf(ac)) }));

  ctx.on('session/event', (a, b) => {
    const turn = turnOf(a, b);
    if (turn) companion.afterTurn(turn).catch((e) => log(`陪伴分析出错：${e?.message ?? e}`));
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
  });
}
