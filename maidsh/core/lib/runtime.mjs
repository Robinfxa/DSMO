// 总控的运行部分：登记表 + 每轮一次分析 + 注入文字。DSH 相关的东西（调模型、事件、注入）
// 由插件外壳以参数传进来，这样这里可以脱离 DSH 测试。
// 档案（§13）：每个档案各有自己最近的感受和这一轮的随机数；一轮带着 turn.profile 交给各面。

import { Registry, analysisRequest, assemble, splitAnalysis, withFeeling } from './core.mjs';
import { DEFAULT_PROFILE, profileId } from './shared/profiles.mjs';

/**
 * [complete]：async ({ system, user }, turn) => 模型的回答文字（插件外壳用 DSH 的模型调用实现，
 * turn 是 afterTurn 收到的那一轮，外壳可以从里面拿会话来选模型）。
 * [log]：(msg) => void。[random]：() => 0..1，测试时可固定。
 */
export function createCompanion({ complete, log = () => {}, now = Date.now, random = Math.random }) {
  const registry = new Registry(log);
  /** 每个档案：最近的感受、上一轮分析的时间、这一轮的随机数。 */
  const perProfile = new Map();
  const live = (profile) => {
    const id = profileId(profile);
    let p = perProfile.get(id);
    if (!p) {
      p = { lastFeeling: null, lastTurnAt: 0, roll: random() };
      perProfile.set(id, p);
    }
    return p;
  };
  let lastError = '';
  // 一次只分析一轮；分析中又来的：每个档案只留最新的一轮排队（中间的跳过，状态变化不会差太多）
  let running = null;
  const queued = new Map();

  const ordered = () => registry.list().sort((a, b) => (a.prompt?.order ?? 500) - (b.prompt?.order ?? 500) || a.id.localeCompare(b.id));

  async function analyze(turn) {
    const profile = profileId(turn.profile);
    const aspects = ordered();
    const req = analysisRequest(aspects, turn, now());
    if (!req) return;
    let text = '';
    try {
      text = await complete({ system: req.system, user: req.user }, turn);
      lastError = '';
    } catch (e) {
      lastError = String(e?.message ?? e);
      log(`陪伴分析调用失败：${lastError}`);
      return;
    }
    const { feeling, results } = withFeeling(splitAnalysis(text, req.ids));
    if (!feeling && Object.values(results).every((r) => r === null)) log('陪伴分析的回答读不出 JSON，这一轮跳过');
    const p = live(profile);
    p.lastFeeling = feeling;
    p.lastTurnAt = now();
    p.roll = random();
    // 交给面的只有文字、会话 id 和档案，不给会话对象本身
    const ctx = { sessionId: turn.sessionId, profile, user: turn.user, reply: turn.reply, feeling };
    for (const a of aspects) if (a.onAnalysis) registry.safely(a, 'onAnalysis', () => a.onAnalysis(results[a.id] ?? null, ctx), undefined);
  }

  async function pump(turn) {
    try {
      await analyze(turn);
    } finally {
      const [key, next] = queued.entries().next().value ?? [];
      if (key !== undefined) queued.delete(key);
      running = next ? pump(next) : null;
    }
  }

  const stateOf = (profile) => {
    const id = profileId(profile);
    const p = live(id);
    return {
      profile: id,
      lastFeeling: p.lastFeeling,
      lastTurnAt: p.lastTurnAt,
      lastError,
      aspects: ordered().map((a) => ({ id: a.id, title: a.title, state: a.state ? registry.safely(a, 'state', () => JSON.parse(JSON.stringify(a.state(id) ?? null)), null) : null })),
    };
  };

  return {
    version: 2,
    register: (aspect) => registry.register(aspect),
    aspects: () => registry.list().map(({ id, title, version }) => ({ id, title, version })),
    /** 登记的面（完整对象，只给总控自己用，比如批量学习）。 */
    registered: () => registry.list(),
    safely: (aspect, what, run, fallback) => registry.safely(aspect, what, run, fallback),
    /** 给 DSMO「陪伴」页的整体状态（JSON 可序列化）；不给档案就是默认档案。 */
    state: (profile = DEFAULT_PROFILE) => stateOf(profile),
    /** 一轮结束后调用（turn.profile 是这一轮的档案）；返回这一轮分析结束的 Promise（测试用，外壳不必等）。 */
    afterTurn(turn) {
      if (!running) running = pump(turn);
      else queued.set(profileId(turn.profile), turn);
      return running;
    },
    /** 现在的陪伴段落；同一轮里多次调用结果一致（随机数一轮只掷一次）。[latest]：这一轮对方的话。 */
    promptText(latest = '', profile = DEFAULT_PROFILE) {
      const id = profileId(profile);
      const p = live(id);
      const ctx = { profile: id, feeling: p.lastFeeling, roll: p.roll, latest: String(latest ?? '') };
      return assemble(
        ordered()
          .filter((a) => a.prompt)
          .map((a) => ({ id: a.id, order: a.prompt.order, maxChars: a.prompt.maxChars, text: registry.safely(a, 'prompt', () => a.prompt.text(ctx), '') })),
      );
    },
    /** 删一个档案时：让各面清掉它的数据（不认识档案的面没有 dropProfile，跳过）。 */
    dropProfile(profile) {
      const id = profileId(profile);
      if (id === DEFAULT_PROFILE) return;
      perProfile.delete(id);
      queued.delete(id);
      for (const a of registry.list()) if (a.dropProfile) registry.safely(a, 'dropProfile', () => a.dropProfile(id), undefined);
    },
    /** 等当前分析做完（测试和停用时用）。 */
    async idle() {
      while (running) await running;
    },
  };
}
