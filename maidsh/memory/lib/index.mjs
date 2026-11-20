// maidsh-memory：MaiDSH 的「记忆」面（CONTRACT.md §8）。
// 单独装：每轮结束后自己做一次小判断，记下关于对方的事和你们的经历；每轮按话题想起几件注入。
// 装了总控：提取并进总控那一次分析，不多花调用。偶尔把淡忘的旧事压成印象（额外一次小调用）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemory } from './aspect.mjs';
import { completeText, configSchema, jsonStore, trackLatest, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, storageDir, turnOf } from './shared/dsh.mjs';

export const name = 'maidsh-memory';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = {
  /** 判断和压印象用的模型；provider 和 model 要成对给，不给就用会话当前的模型。 */
  provider: '',
  model: '',
  /** 数据目录，默认 <DSH_HOME>/storages/maidsh-memory。 */
  dataDir: '',
};

export const Config = configSchema(name, DEFAULTS);

export const LIST_PATH = '/api/maidsh-memory/list';
export const MUTATE_PATH = '/api/maidsh-memory/mutate';

/** dsh-plugin-memory-share 的全局（user）记忆，只读。 */
function readMemoryShare() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'memory-share', 'memories.json'), 'utf8'));
    return (Array.isArray(raw?.entries) ? raw.entries : []).filter((e) => (e?.scope ?? 'user') === 'user' && typeof e.text === 'string').map((e) => e.text);
  } catch {
    return [];
  }
}

export function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const log = loggerOf(ctx, name);
  const store = jsonStore(storageDir(name, c.dataDir), 'memory.json', log);
  let alive = true;
  ctx.effect(() => () => {
    alive = false;
  });

  // 最近一个主会话：压印象时用它的模型路由
  let lastSession = null;
  let consolidating = false;
  function consolidate() {
    if (consolidating || !alive) return;
    const req = memory.consolidation();
    if (!req) return;
    consolidating = true;
    completeText(ctx, req, { session: lastSession, provider: c.provider, model: c.model, maxTokens: 600, timeoutMs: 60_000 })
      .then((text) => {
        if (alive && !memory.applyConsolidation(text)) log('压印象的回答读不出来，下次再试');
      })
      .catch((e) => log(`压印象失败：${e?.message ?? e}`))
      .finally(() => {
        consolidating = false;
      });
  }

  const memory = createMemory({
    store,
    log,
    moodValence: () => ctx.get('companionMood')?.get?.().valence ?? 0,
    bondLevel: () => ctx.get('companionBond')?.get?.().level ?? 2,
    moodFeel: (label, intensity) => ctx.get('companionMood')?.feel?.(label, intensity, 'memory'),
    onConsolidate: () => queueMicrotask(consolidate),
  });

  ctx.provide('companionMemory', memory.service);

  let underCore = false;
  ctx.inject(['companion'], (sub) => {
    sub.effect(() => {
      const off = sub.companion.register(memory.aspect);
      underCore = true;
      return () => {
        underCore = false;
        off();
      };
    });
  });

  const latestOf = trackLatest(ctx);
  ctx.effect(() => promptContext(ctx, { name: 'maidsh:memory', order: 303, text: (ac) => (underCore ? '' : memory.compose(latestOf(ac))) }));

  let busy = false;
  ctx.on('session/event', (a, b) => {
    const turn = turnOf(a, b);
    if (!turn || !alive) return;
    lastSession = turn.session;
    if (underCore || busy) return;
    busy = true;
    completeText(ctx, memory.standaloneRequest(turn), { session: turn.session, provider: c.provider, model: c.model, maxTokens: 500 })
      .then((text) => {
        if (alive && !underCore && !memory.standaloneApply(text, turn)) log('记忆判断的回答读不出来，这一轮跳过');
      })
      .catch((e) => log(`记忆判断失败：${e?.message ?? e}`))
      .finally(() => {
        busy = false;
      });
  });

  // 给 DSMO「陪伴 › 记忆」页
  ctx.inject(['webServer'], (sub) => {
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: LIST_PATH,
        handler: (req, res) => {
          const no = rejectRead(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          sendJson(res, 200, { ok: true, value: memory.snapshot() });
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
          const out = memory.mutate(body, { importMemoryShare: readMemoryShare });
          sendJson(res, out.ok ? 200 : 400, out);
        },
      }),
    );
  });
}
