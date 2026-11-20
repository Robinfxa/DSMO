// maidsh-initiative：MaiDSH 的「主动」面（CONTRACT.md §10）。
// TA 会在随机的时刻主动找你（避开安静时段、每天有上限、你没回就退），也会在约好的时间回来问问。
// 不用 DSH 自带的定时任务（它会留下可见的 schedule 消息）：插件自己计时，到点用隐藏消息唤醒 TA。
// 档案（§13）：每个档案各自排时间、记回访和退避，只在属于它的对话里主动；每天的次数所有档案合计。

import { randomUUID } from 'node:crypto';
import { DEFAULTS as PLAN_DEFAULTS, INITIATIVE_INSTRUCTIONS, INITIATIVE_SCHEMA, addFollowup, dayOf, due, emptyInitiative, gapLine, initiativePrompt, onInitiated, onInitiativeDone, onStartup, onUserTurn, planNext, settlePending } from './core.mjs';
import { configSchema, jsonStore, loggerOf, promptContext, readJsonBody, rejectRead, rejectWrite, sendJson, startedBy, storageDir, turnEnded, turnOf } from './shared/dsh.mjs';
import { DEFAULT_PROFILE, perProfile, profileDir, profileId, removeProfileDir, requestedProfile, registerAspect } from './shared/profiles.mjs';

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
  const base = storageDir(name, c.dataDir);

  // 每天的次数：所有档案共用一份。第一次用时从默认档案原来的计数接过来
  const dailyStore = jsonStore(base, 'daily.json', log);
  const daily = { day: '', count: 0, ...(dailyStore.load() ?? {}) };

  /** 每个档案一份安排；默认档案就是原来的 initiative.json。 */
  const stores = new Map();
  const states = perProfile((id) => {
    const store = jsonStore(profileDir(base, id), 'initiative.json', log);
    stores.set(id, store);
    let st = store.load();
    const existed = !!st;
    if (!st || st.v !== 1) st = emptyInitiative();
    if (id === DEFAULT_PROFILE && !daily.day && st.day) Object.assign(daily, { day: st.day, count: st.count });
    onStartup(st, Date.now(), { o, daily });
    if (existed) saveOne(id, st);
    return st;
  });
  function saveOne(id, st) {
    try {
      stores.get(id)?.save(st);
    } catch (e) {
      log(`主动的状态保存失败：${e?.message ?? e}`);
    }
  }
  const save = (id) => {
    saveOne(id, states.of(id));
    try {
      dailyStore.save(daily);
    } catch (e) {
      log(`主动的次数保存失败：${e?.message ?? e}`);
    }
  };
  states.of(DEFAULT_PROFILE);

  /** 总控里的档案；没装总控时只有默认档案。 */
  const profiles = () => {
    try {
      const list = ctx.get('companion')?.profiles?.();
      return Array.isArray(list) && list.length ? list.map((p) => profileId(p.id)) : [DEFAULT_PROFILE];
    } catch {
      return [DEFAULT_PROFILE];
    }
  };
  /** 这个对话归哪个档案（装了总控才有档案和范围；没装就是默认档案）；null = 关。 */
  const profileOf = (sessionId) => {
    try {
      const comp = ctx.get('companion');
      if (comp?.profileOf) return comp.profileOf(sessionId);
      return (comp?.inScope?.(sessionId) ?? true) ? DEFAULT_PROFILE : null;
    } catch {
      return DEFAULT_PROFILE;
    }
  };

  const bondLevel = (id) => {
    const l = Number(ctx.get('companionBond')?.get?.(id).level);
    return Number.isFinite(l) ? l : 2;
  };

  /** 找到这个会话的 TA：活着的直接拿，否则让 DSH 恢复（Web 组合里有 sessionController）。 */
  async function agentFor(sessionId) {
    const live = ctx.get('agents')?.get?.(sessionId);
    if (live) return live;
    const r = await ctx.get('sessionController')?.resolveAgent?.(sessionId);
    return r && !r.error ? r.agent : null;
  }

  const hooks = (id) => {
    try {
      const facts = ctx.get('companionMemory')?.facts?.(id) ?? [];
      return facts.filter((f) => f.cat === 'recent' && f.r >= 0.3).sort((a, b) => b.createdAt - a.createdAt).slice(0, 2).map((f) => f.text);
    } catch {
      return [];
    }
  };

  let firing = false;
  async function fire(id, plan) {
    if (firing) return;
    firing = true;
    const st = states.of(id);
    try {
      if (profileOf(plan.sessionId) !== id) {
        // 这个对话后来被关掉了、成了 Bot 的对话，或者换到了别的档案：不在这里主动，等下次在这个档案的对话里聊过再排
        st.sessionId = '';
        st.followups = st.followups.filter((f) => f.sessionId !== plan.sessionId);
        st.nextAt = 0;
        return;
      }
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
        mood: ctx.get('companionMood')?.describe?.(id) ?? '',
        bond: ctx.get('companionBond')?.describe?.(id) ?? '',
        hooks: hooks(id),
      });
      agent.followup(deepFreeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: SOURCE_KIND } }));
      onInitiated(st, now, plan, { o, daily });
      log(`主动（档案 ${id}）：${plan.kind === 'followup' ? '约好的回访' : '随机'}，下一次最早 ${new Date(st.nextAt).toLocaleString()}`);
    } catch (e) {
      log(`主动失败：${e?.message ?? e}`);
      st.nextAt = Date.now() + 30 * 60_000;
    } finally {
      firing = false;
      save(id);
    }
  }

  // 每分钟看一眼：各档案轮着看，一次最多主动一个
  function tick() {
    if (!c.enabled) return Promise.resolve(null);
    const now = Date.now();
    for (const id of profiles()) {
      const st = states.of(id);
      const before = JSON.stringify([st.pending, st.followups, st.ignored, st.lastTopic]);
      settlePending(st, now, { o });
      const plan = due(st, now, { bondLevel: bondLevel(id), o, daily });
      if (plan) return fire(id, plan).then(() => ({ ...plan, profile: id }));
      if (JSON.stringify([st.pending, st.followups, st.ignored, st.lastTopic]) !== before) save(id);
    }
    return Promise.resolve(null);
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
      // 哪个档案在等这段对话的回音（老存档的 pending 没记对话：按对话现在的档案）
      const waiting = profiles().filter((id) => states.of(id).pending?.sessionId === session.id);
      const fallback = profileOf(session.id);
      for (const id of waiting.length ? waiting : fallback ? [fallback] : []) {
        onInitiativeDone(states.of(id));
        save(id);
      }
      return;
    }
    const turn = turnOf(a, b);
    if (!turn) return;
    const id = profileOf(turn.sessionId);
    if (id === null) return;
    onUserTurn(states.of(id), { now: Date.now(), sessionId: turn.sessionId, topic: turn.user, o, daily });
    save(id);
  });

  // 交给总控：分析里多问一个「约好的回访」，提示里加时间感（没有总控时只做随机主动）
  const aspect = {
    id: 'initiative',
    title: '主动',
    version: 2,
    analysis: { schema: INITIATIVE_SCHEMA, instructions: INITIATIVE_INSTRUCTIONS },
    onAnalysis(result, turn) {
      const id = profileId(turn?.profile);
      if (result?.followup && addFollowup(states.of(id), result.followup, Date.now())) save(id);
    },
    prompt: { order: 250, maxChars: 40, text: (turn) => gapLine(states.of(turn?.profile), Date.now()) },
    state: (profile) => view(profile),
    dropProfile(id) {
      states.forget(id);
      stores.delete(id);
      removeProfileDir(base, id);
    },
  };
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
  ctx.effect(() => promptContext(ctx, { name: 'maidsh:initiative', order: 299, text: () => (underCore ? '' : gapLine(states.of(DEFAULT_PROFILE), Date.now())) }));

  const view = (profile) => {
    const st = states.of(profile);
    return {
      profile: profileId(profile),
      enabled: c.enabled,
      today: daily.day === dayOf(Date.now()) ? daily.count : 0,
      perDay: o.perDay,
      nextAt: st.nextAt,
      followups: st.followups.map((f) => ({ at: f.at, reason: f.reason })),
      ignored: st.ignored,
      stopped: st.ignored >= o.stopAfterIgnored,
      quiet: `${o.quietStart}–${o.quietEnd}`,
    };
  };

  /** 暂停若干小时（0 = 立刻恢复并重排）。 */
  function pause(hours = 0, profile = DEFAULT_PROFILE) {
    const id = profileId(profile);
    const st = states.of(id);
    if (hours > 0) st.nextAt = Date.now() + hours * 3_600_000;
    else planNext(st, Date.now(), { o, daily });
    save(id);
    return view(id);
  }

  ctx.provide('companionInitiative', {
    version: 2,
    state: (profile) => view(profile),
    /** 现在就检查一次该不该主动（平时每分钟自动检查）。 */
    check: () => tick(),
    pause,
  });

  ctx.inject(['webServer'], (sub) => {
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => {
          const no = rejectRead(ctx, req);
          if (no) return sendJson(res, no[0], { ok: false, error: no[1] });
          const profile = requestedProfile(ctx, req);
          if (!profile) return sendJson(res, 404, { ok: false, error: '找不到这个档案' });
          sendJson(res, 200, { ok: true, value: view(profile) });
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
          const profile = requestedProfile(ctx, req, body);
          if (!profile) return sendJson(res, 404, { ok: false, error: '找不到这个档案' });
          if (body?.action === 'pause') return sendJson(res, 200, { ok: true, value: pause(Number(body.hours) || 0, profile) });
          if (body?.action === 'resume') {
            const st = states.of(profile);
            st.ignored = 0;
            planNext(st, Date.now(), { o, daily });
            save(profile);
            return sendJson(res, 200, { ok: true, value: view(profile) });
          }
          sendJson(res, 400, { ok: false, error: '不认识的操作' });
        },
      }),
    );
  });
}
