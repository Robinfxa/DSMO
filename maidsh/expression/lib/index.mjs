// maidsh-expression：MaiDSH 的「表达」面（CONTRACT.md §9）。
// 学对方的说话方式（口头禅、句式、你们之间的黑话），按关系和心情挑几条注入。
// 单独装：每轮一次小判断；装了总控：并进那一次分析，不多花调用。

import { createExpression } from './aspect.mjs';
import { completeText, configSchema, jsonStore, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, storageDir, trackLatest, turnOf } from './shared/dsh.mjs';

export const name = 'maidsh-expression';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = { provider: '', model: '', dataDir: '' };
export const Config = configSchema(name, DEFAULTS);

export const LIST_PATH = '/api/maidsh-expression/list';
export const MUTATE_PATH = '/api/maidsh-expression/mutate';

export function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const log = loggerOf(ctx, name);
  let alive = true;
  ctx.effect(() => () => {
    alive = false;
  });
  const expression = createExpression({
    store: jsonStore(storageDir(name, c.dataDir), 'expression.json', log),
    log,
    moodValence: () => ctx.get('companionMood')?.get?.().valence ?? 0,
    bondLevel: () => ctx.get('companionBond')?.get?.().level ?? 2,
  });

  ctx.provide('companionExpression', { ...expression.service, batchApply: expression.batchApply, undoJob: expression.undoJob });

  let underCore = false;
  ctx.inject(['companion'], (sub) => {
    sub.effect(() => {
      const off = sub.companion.register(expression.aspect);
      underCore = true;
      return () => {
        underCore = false;
        off();
      };
    });
  });

  const latestOf = trackLatest(ctx);
  ctx.effect(() => promptContext(ctx, { name: 'maidsh:expression', order: 304, text: (ac) => (underCore ? '' : expression.compose(latestOf(ac))) }));

  let busy = false;
  ctx.on('session/event', (a, b) => {
    if (underCore || busy || !alive) return;
    const turn = turnOf(a, b);
    if (!turn) return;
    busy = true;
    completeText(ctx, expression.standaloneRequest(turn), { session: turn.session, provider: c.provider, model: c.model, maxTokens: 300 })
      .then((text) => {
        if (alive && !underCore && !expression.standaloneApply(text, turn)) log('表达判断的回答读不出来，这一轮跳过');
      })
      .catch((e) => log(`表达判断失败：${e?.message ?? e}`))
      .finally(() => {
        busy = false;
      });
  });

  ctx.inject(['webServer'], (sub) => {
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: LIST_PATH,
        handler: (req, res) => {
          const no = rejectRead(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          sendJson(res, 200, { ok: true, value: expression.snapshot() });
        },
      }),
    );
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: MUTATE_PATH,
        handler: async (req, res) => {
          const no = rejectWrite(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          const body = await readJsonBody(req);
          if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad json' });
          const out = expression.mutate(body);
          sendJson(res, out.ok ? 200 : 400, out);
        },
      }),
    );
  });
}
