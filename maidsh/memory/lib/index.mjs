// maidsh-memory：MaiDSH 的「记忆」面（CONTRACT.md §8）。
// 单独装：每轮结束后自己做一次小判断，记下关于对方的事和你们的经历；每轮按话题想起几件注入。
// 装了总控：提取并进总控那一次分析，不多花调用。偶尔把淡忘的旧事压成印象（额外一次小调用）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemory } from './aspect.mjs';
import { completeText, configSchema, jsonStore, trackLatest, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, storageDir, turnOf } from './shared/dsh.mjs';
import { DEFAULT_PROFILE, perProfile, profileDir, profiledAspect, removeProfileDir, requestedProfile, registerAspect } from './shared/profiles.mjs';

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
  const base = storageDir(name, c.dataDir);
  let alive = true;
  ctx.effect(() => () => {
    alive = false;
  });

  // 最近一个主会话：压印象时用它的模型路由
  let lastSession = null;
  // 要压印象的档案；一次只压一个，压的时候又来的排着（同一个档案再来也不丢）
  const pending = new Set();
  const gone = new Set();
  let consolidating = false;
  async function drain() {
    if (consolidating) return;
    consolidating = true;
    try {
      while (alive && pending.size) {
        const id = pending.values().next().value;
        pending.delete(id);
        if (gone.has(id)) continue;
        const m = memories.of(id);
        const req = m.consolidation();
        if (!req) continue;
        try {
          const text = await completeText(ctx, req, { session: lastSession, provider: c.provider, model: c.model, maxTokens: 1000, timeoutMs: 60_000 });
          if (alive && !gone.has(id) && !m.applyConsolidation(text)) log('压印象的回答读不出来，下次再试');
        } catch (e) {
          log(`压印象失败：${e?.message ?? e}`);
        }
      }
    } finally {
      consolidating = false;
    }
  }
  function consolidate(id) {
    if (!alive || gone.has(id)) return;
    pending.add(id);
    void drain();
  }

  // 每个档案一份记忆（§13）；默认档案就是原来的 memory.json。读心情、羁绊时读同一个档案的
  const memories = perProfile((id) =>
    createMemory({
      store: jsonStore(profileDir(base, id), 'memory.json', log),
      log,
      moodValence: () => ctx.get('companionMood')?.get?.(id).valence ?? 0,
      bondLevel: () => ctx.get('companionBond')?.get?.(id).level ?? 2,
      moodFeel: (label, intensity) => ctx.get('companionMood')?.feel?.(label, intensity, 'memory', id),
      onConsolidate: () => queueMicrotask(() => consolidate(id)),
      // 装了设定集、这段对话用了作品：故事世界设定以设定集为准
      hideWorld: (sessionId) => !!sessionId && !!ctx.get('lore')?.covers?.(sessionId),
    }),
  );
  const memory = memories.of(DEFAULT_PROFILE);
  const aspect = profiledAspect(
    (id) => memories.of(id).aspect,
    (id) => {
      gone.add(id);
      pending.delete(id);
      memories.forget(id);
      removeProfileDir(base, id);
    },
  );

  /** companionMemory 服务（约定 v2）：各方法多一个可选的档案参数（最后一个），不给就是默认档案。 */
  const of = (p) => memories.of(p).service;
  ctx.provide('companionMemory', {
    version: 2,
    facts: (profile) => of(profile).facts(),
    episodes: (profile) => of(profile).episodes(),
    profile: (profile) => of(profile).profile(),
    remember: (text, opts = {}) => of(opts?.profile).remember(text, opts),
    forget: (id, profile) => of(profile).forget(id),
    recall: (query, n = 3, profile) => of(profile).recall(query, n),
  });

  let underCore = false;
  ctx.inject(['companion'], (sub) => {
    sub.effect(() => {
      const off = registerAspect(sub.companion, aspect);
      underCore = true;
      return () => {
        underCore = false;
        off();
      };
    });
  });

  const latestOf = trackLatest(ctx);
  ctx.effect(() => promptContext(ctx, { name: 'maidsh:memory', order: 303, text: (ac) => (underCore ? '' : memory.compose(latestOf(ac), ac?.agent?.session?.id ?? '')) }));

  let busy = false;
  ctx.on('session/event', (a, b) => {
    const turn = turnOf(a, b);
    if (!turn || !alive) return;
    lastSession = turn.session;
    if (underCore || busy) return;
    busy = true;
    completeText(ctx, memory.standaloneRequest(turn), { session: turn.session, provider: c.provider, model: c.model, maxTokens: 1200 })
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
          const profile = requestedProfile(ctx, req);
          if (!profile) return sendJson(res, 404, { ok: false, error: '找不到这个档案' });
          sendJson(res, 200, { ok: true, value: memories.of(profile).snapshot() });
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
          const profile = requestedProfile(ctx, req, body);
          if (!profile) return sendJson(res, 404, { ok: false, error: '找不到这个档案' });
          const out = memories.of(profile).mutate(body, { importMemoryShare: readMemoryShare });
          sendJson(res, out.ok ? 200 : 400, out);
        },
      }),
    );
  });
}
