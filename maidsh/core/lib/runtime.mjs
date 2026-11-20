// 总控的运行部分：登记表 + 每轮一次分析 + 注入文字。DSH 相关的东西（调模型、事件、注入）
// 由插件外壳以参数传进来，这样这里可以脱离 DSH 测试。

import { Registry, analysisRequest, assemble, splitAnalysis, withFeeling } from './core.mjs';

/**
 * [complete]：async ({ system, user }, turn) => 模型的回答文字（插件外壳用 DSH 的模型调用实现，
 * turn 是 afterTurn 收到的那一轮，外壳可以从里面拿会话来选模型）。
 * [log]：(msg) => void。[random]：() => 0..1，测试时可固定。
 */
export function createCompanion({ complete, log = () => {}, now = Date.now, random = Math.random }) {
  const registry = new Registry(log);
  let lastFeeling = null;
  let lastTurnAt = 0;
  let roll = random();
  let lastError = '';
  // 一次只分析一轮；分析中又来一轮时只留最新的一轮排队（中间的跳过，状态变化不会差太多）
  let running = null;
  let queued = null;

  const ordered = () => registry.list().sort((a, b) => (a.prompt?.order ?? 500) - (b.prompt?.order ?? 500) || a.id.localeCompare(b.id));

  async function analyze(turn) {
    const aspects = ordered();
    const req = analysisRequest(aspects, turn);
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
    lastFeeling = feeling;
    lastTurnAt = now();
    roll = random();
    // 交给面的只有文字和会话 id，不给会话对象本身
    const ctx = { sessionId: turn.sessionId, user: turn.user, reply: turn.reply, feeling };
    for (const a of aspects) if (a.onAnalysis) registry.safely(a, 'onAnalysis', () => a.onAnalysis(results[a.id] ?? null, ctx), undefined);
  }

  async function pump(turn) {
    try {
      await analyze(turn);
    } finally {
      const next = queued;
      queued = null;
      running = next ? pump(next) : null;
    }
  }

  return {
    version: 1,
    register: (aspect) => registry.register(aspect),
    aspects: () => registry.list().map(({ id, title, version }) => ({ id, title, version })),
    /** 给 DSMO「陪伴」页的整体状态（JSON 可序列化）。 */
    state: () => ({
      lastFeeling,
      lastTurnAt,
      lastError,
      aspects: ordered().map((a) => ({ id: a.id, title: a.title, state: a.state ? registry.safely(a, 'state', () => JSON.parse(JSON.stringify(a.state() ?? null)), null) : null })),
    }),
    /** 一轮结束后调用；返回这一轮分析结束的 Promise（测试用，外壳不必等）。 */
    afterTurn(turn) {
      if (!running) running = pump(turn);
      else queued = turn;
      return running;
    },
    /** 现在的陪伴段落；同一轮里多次调用结果一致（随机数一轮只掷一次）。 */
    promptText() {
      const ctx = { feeling: lastFeeling, roll };
      return assemble(
        ordered()
          .filter((a) => a.prompt)
          .map((a) => ({ id: a.id, order: a.prompt.order, maxChars: a.prompt.maxChars, text: registry.safely(a, 'prompt', () => a.prompt.text(ctx), '') })),
      );
    },
    /** 等当前分析做完（测试和停用时用）。 */
    async idle() {
      while (running) await running;
    },
  };
}
