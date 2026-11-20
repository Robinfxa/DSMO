// maidsh-mood：陪伴套件的「心情」面（CONTRACT.md）。
// 单独装：每轮结束后自己判断一次感受、更新心情，每轮注入一句心情。
// 装了总控（服务 companion）：把自己登记给总控，判断和注入都交给总控；总控卸载后自动回到单独模式。

import { createMood } from './aspect.mjs';
import { completeText, configSchema, jsonStore, loggerOf, promptContext, storageDir, turnOf } from './shared/dsh.mjs';
import { feelingRequest, parseFeeling } from './shared/feeling.mjs';

export const name = 'maidsh-mood';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = {
  /** 情绪化程度 0–1：越高起伏越大、回落越快。 */
  neuroticism: 0.5,
  /** 宜人性 0–1：越高好心情留得越久、坏心情散得越快，平时也略偏开心。 */
  agreeableness: 0.5,
  /** 心情回落一半要几小时。 */
  halfLifeHours: 2,
  /** 单独模式下判断感受用的模型；provider 和 model 要成对给，不给就用会话当前的模型。 */
  provider: '',
  model: '',
  /** 数据目录，默认 <DSH_HOME>/storages/maidsh-mood。 */
  dataDir: '',
};

export const Config = configSchema(name, DEFAULTS, { neuroticism: [0, 1], agreeableness: [0, 1], halfLifeHours: [0.1, 168] });

export function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const log = loggerOf(ctx, name);
  const store = jsonStore(storageDir(name, c.dataDir), 'mood.json', log);
  const mood = createMood({ store, log, opts: { neuroticism: c.neuroticism, agreeableness: c.agreeableness, halfLifeHours: c.halfLifeHours } });

  ctx.provide('companionMood', mood.service);

  // 总控在时交出控制
  let underCore = false;
  ctx.inject(['companion'], (sub) => {
    sub.effect(() => {
      const off = sub.companion.register(mood.aspect);
      underCore = true;
      return () => {
        underCore = false;
        off();
      };
    });
  });

  ctx.effect(() => promptContext(ctx, { name: 'maidsh:mood', order: 301, text: () => (underCore ? '' : mood.service.describe()) }));

  // 单独模式：每轮一次小判断。插件卸载后还在路上的结果直接丢掉
  let busy = false;
  let alive = true;
  ctx.effect(() => () => {
    alive = false;
  });
  ctx.on('session/event', (a, b) => {
    if (underCore || busy || !alive) return;
    const turn = turnOf(a, b);
    if (!turn) return;
    busy = true;
    completeText(ctx, feelingRequest(turn), { session: turn.session, provider: c.provider, model: c.model, maxTokens: 60 })
      .then((text) => {
        const f = parseFeeling(text);
        if (!alive) return;
        if (f && !underCore) mood.service.feel(f.label, f.intensity, 'mood');
        else if (!f) log('感受判断的回答读不出来，这一轮跳过');
      })
      .catch((e) => log(`感受判断失败：${e?.message ?? e}`))
      .finally(() => {
        busy = false;
      });
  });
}
