// maidsh-bond：陪伴套件的「羁绊」（好感度）面（CONTRACT.md）。
// 单独装：每轮自己判断一次感受、更新关系值，克制地注入。
// 装了心情面、没装总控：跟着心情的判断走，不再自己调模型；心情好时好感涨得多。
// 装了总控：登记给总控，判断和注入交给总控。

import { createBond } from './aspect.mjs';
import { completeText, configSchema, jsonStore, loggerOf, promptContext, storageDir, turnOf } from './shared/dsh.mjs';
import { feelingRequest, parseFeeling } from './shared/feeling.mjs';

export const name = 'maidsh-bond';
export const inject = ['systemPrompt', 'llm'];

const DEFAULTS = {
  /** 每轮变化的放大系数：越大关系变得越快。 */
  gain: 6,
  /** 中间几档每轮提一次关系的概率。 */
  hintChance: 0.6,
  provider: '',
  model: '',
  dataDir: '',
};

export const Config = configSchema(name, DEFAULTS, { gain: [0.5, 30], hintChance: [0, 1] });

export function apply(ctx, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const log = loggerOf(ctx, name);
  const store = jsonStore(storageDir(name, c.dataDir), 'bond.json', log);
  let roll = Math.random();
  const bond = createBond({
    store,
    log,
    opts: { gain: c.gain, hintChance: c.hintChance },
    moodValence: () => ctx.get('companionMood')?.get?.().valence ?? 0,
    roll: () => roll,
  });

  ctx.provide('companionBond', bond.service);

  let underCore = false;
  ctx.inject(['companion'], (sub) => {
    sub.effect(() => {
      const off = sub.companion.register(bond.aspect);
      underCore = true;
      return () => {
        underCore = false;
        off();
      };
    });
  });

  // 心情面在、总控不在：跟着心情自己判断出的感受走（source 'mood'），一轮只调一次模型
  let followMood = false;
  ctx.inject(['companionMood'], (sub) => {
    sub.effect(() => {
      const m = sub.companionMood;
      if (typeof m?.subscribe !== 'function') return () => {};
      followMood = true;
      const off = m.subscribe((e) => {
        if (underCore || e?.source !== 'mood') return;
        bond.service.interact(e.label, e.intensity, 'mood');
        roll = Math.random();
      });
      return () => {
        followMood = false;
        off();
      };
    });
  });

  ctx.effect(() => promptContext(ctx, { name: 'maidsh:bond', order: 302, text: () => (underCore ? '' : bond.hintNow(roll)) }));

  let busy = false;
  let alive = true;
  ctx.effect(() => () => {
    alive = false;
  });
  ctx.on('session/event', (a, b) => {
    if (underCore || followMood || busy || !alive) return;
    const turn = turnOf(a, b);
    if (!turn) return;
    busy = true;
    completeText(ctx, feelingRequest(turn), { session: turn.session, provider: c.provider, model: c.model, maxTokens: 60 })
      .then((text) => {
        const f = parseFeeling(text);
        if (!alive) return;
        if (f && !underCore) bond.service.interact(f.label, f.intensity, 'bond');
        else if (!f) log('感受判断的回答读不出来，这一轮跳过');
        roll = Math.random();
      })
      .catch((e) => log(`感受判断失败：${e?.message ?? e}`))
      .finally(() => {
        busy = false;
      });
  });
}
