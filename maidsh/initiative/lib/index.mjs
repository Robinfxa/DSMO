// maidsh-initiative：MaiDSH 的「主动」面（CONTRACT.md §10）。
// TA 会在随机的时刻主动找你（避开安静时段、每天有上限、你没回就退），也会在约好的时间回来问问。
// 不用 DSH 自带的定时任务（它会留下可见的 schedule 消息）：插件自己计时，到点用隐藏消息唤醒 TA。

import { randomUUID } from 'node:crypto';
import { DEFAULTS as PLAN_DEFAULTS, INITIATIVE_INSTRUCTIONS, INITIATIVE_SCHEMA, addFollowup, due, emptyInitiative, gapLine, initiativePrompt, onInitiated, onInitiativeDone, onStartup, onUserTurn, planNext, settlePending } from './core.mjs';
import { configSchema, jsonStore, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, startedBy, storageDir, turnEnded, turnOf } from './shared/dsh.mjs';

export const name = 'maidsh-initiative';
export const inject = ['systemPrompt'];

/** TA 主动时那条隐藏消息的来源；DSMO 据此不显示它，并给 TA 的回复标上「TA 先开口」。 */
export const SOURCE_KIND = 'maidsh-initiative';

const DEFAULTS = {
  enabled: true,
  perDay: PLAN_DEFAULTS.perDay,
  minGapHours: PLAN_DEFAULTS.minGapHours,
  quietStart: PLAN_DEFAULTS.quietStart,
  quietEnd: PLAN_DEFAULTS.quietEnd,
  dataDir: '',
};
export const Config = configSchema(name, DEFAULTS, { perDay: [0, 10], minGapHours: [1, 72] });

export const STATE_PATH = '/api/maidsh-initiative/state';
export const MUTATE_PATH = '/api/maidsh-initiative/mutate';

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const o = { ...PLAN_DEFAULTS, perDay: c.perDay, minGapHours: c.minGapHours, quietStart: c.quietStart, quietEnd: c.quietEnd };
  const log = loggerOf(ctx, name);
  const store = jsonStore(storageDir(name, c.dataDir), 'initiative.json', log);
  let st = store.load();
  if (!st || st.v !== 1) st = emptyInitiative();
  const save = () => {
    try {
      store.save(st);
    } catch (e) {
      log(`主动的状态保存失败：${e?.message ?? e}`);
    }
  };
  onStartup(st, Date.now(), { o });
  save();

  const bondLevel = () => {
    const l = Number(ctx.get('companionBond')?.get?.().level);
    return Number.isFinite(l) ? l : 2;
  };

  /** 找到这个会话的 TA：活着的直接拿，否则让 DSH 恢复（Web 组合里有 sessionController）。 */
  async function agentFor(sessionId) {
    const live = ctx.get('agents')?.get?.(sessionId);
    if (live) return live;
    const r = await ctx.get('sessionController')?.resolveAgent?.(sessionId);
    return r && !r.error ? r.agent : null;
  }

  const hooks = () => {
    try {
      const facts = ctx.get('companionMemory')?.facts?.() ?? [];
      return facts.filter((f) => f.cat === 'recent' && f.r >= 0.3).sort((a, b) => b.createdAt - a.createdAt).slice(0, 2).map((f) => f.text);
    } catch {
      return [];
    }
  };

  let firing = false;
  async function fire(plan) {
    if (firing) return;
    firing = true;
    try {
      const agent = await agentFor(plan.sessionId);
      if (!agent) {
        st.nextAt = Date.now() + 30 * 60_000;
        log(`主动：找不到会话 ${plan.sessionId}，半小时后再试`);
        return;
      }
      if (agent.status === 'running') {
        // TA 正在回复，不插话
        if (plan.kind === 'random') st.nextAt = Date.now() + 10 * 60_000;
        else st.followups = st.followups.map((f) => (f.at <= Date.now() ? { ...f, at: Date.now() + 10 * 60_000 } : f));
        return;
      }
      const now = Date.now();
      const text = initiativePrompt(st, now, plan, {
        mood: ctx.get('companionMood')?.describe?.() ?? '',
        bond: ctx.get('companionBond')?.describe?.() ?? '',
        hooks: hooks(),
      });
      agent.followup(deepFreeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: SOURCE_KIND } }));
      onInitiated(st, now, plan, { o });
      log(`主动：${plan.kind === 'followup' ? '约好的回访' : '随机'}，下一次最早 ${new Date(st.nextAt).toLocaleString()}`);
    } catch (e) {
      log(`主动失败：${e?.message ?? e}`);
      st.nextAt = Date.now() + 30 * 60_000;
    } finally {
      firing = false;
      save();
    }
  }

  // 每分钟看一眼
  function tick() {
    if (!c.enabled) return Promise.resolve(null);
    const now = Date.now();
    const before = JSON.stringify([st.pending, st.followups, st.ignored, st.lastTopic]);
    settlePending(st, now, { o });
    const plan = due(st, now, { bondLevel: bondLevel(), o });
    if (!plan && JSON.stringify([st.pending, st.followups, st.ignored, st.lastTopic]) !== before) save();
    return plan ? fire(plan).then(() => plan) : Promise.resolve(null);
  }
  ctx.effect(() => {
    const timer = setInterval(() => void tick(), 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  // 一轮结束：对方说的 → 记下、重排；TA 主动的那一轮 → 等对方回话
  ctx.on('session/event', (a, b) => {
    // 不论这一轮是正常结束、出错还是被中止：TA 主动的那一轮结束了就不再等它
    const ended = turnEnded(a, b);
    if (!ended) return;
    const { session } = ended;
    let kind = '';
    try {
      kind = startedBy(session.deriveMessages());
    } catch {
      return;
    }
    if (kind === SOURCE_KIND) {
      onInitiativeDone(st);
      save();
      return;
    }
    const turn = turnOf(a, b);
    if (!turn) return;
    onUserTurn(st, { now: Date.now(), sessionId: turn.sessionId, topic: turn.user, o });
    save();
  });

  // 交给总控：分析里多问一个「约好的回访」，提示里加时间感（没有总控时只做随机主动）
  const aspect = {
    id: 'initiative',
    title: '主动',
    version: 1,
    analysis: { schema: INITIATIVE_SCHEMA, instructions: INITIATIVE_INSTRUCTIONS },
    onAnalysis(result) {
      if (result?.followup && addFollowup(st, result.followup, Date.now())) save();
    },
    prompt: { order: 250, maxChars: 40, text: () => gapLine(st, Date.now()) },
    state: () => view(),
  };
  let underCore = false;
  ctx.inject(['companion'], (sub) => {
    sub.effect(() => {
      const off = sub.companion.register(aspect);
      underCore = true;
      return () => {
        underCore = false;
        off();
      };
    });
  });
  ctx.effect(() => promptContext(ctx, { name: 'maidsh:initiative', order: 299, text: () => (underCore ? '' : gapLine(st, Date.now())) }));

  const view = () => ({
    enabled: c.enabled,
    today: st.day ? st.count : 0,
    perDay: o.perDay,
    nextAt: st.nextAt,
    followups: st.followups.map((f) => ({ at: f.at, reason: f.reason })),
    ignored: st.ignored,
    stopped: st.ignored >= o.stopAfterIgnored,
    quiet: `${o.quietStart}–${o.quietEnd}`,
  });

  ctx.provide('companionInitiative', {
    version: 1,
    state: view,
    /** 现在就检查一次该不该主动（平时每分钟自动检查）。 */
    check: () => tick(),
    /** 暂停若干小时（0 = 立刻恢复并重排）。 */
    pause(hours = 0) {
      if (hours > 0) st.nextAt = Date.now() + hours * 3_600_000;
      else planNext(st, Date.now(), { o });
      save();
      return view();
    },
  });

  ctx.inject(['webServer'], (sub) => {
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => {
          const no = rejectRead(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          sendJson(res, 200, { ok: true, value: view() });
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
          if (body?.action === 'pause') return sendJson(res, 200, { ok: true, value: ctx.get('companionInitiative').pause(Number(body.hours) || 0) });
          if (body?.action === 'resume') {
            st.ignored = 0;
            planNext(st, Date.now(), { o });
            save();
            return sendJson(res, 200, { ok: true, value: view() });
          }
          sendJson(res, 400, { ok: false, error: '不认识的操作' });
        },
      }),
    );
  });
}
