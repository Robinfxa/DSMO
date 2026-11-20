// 心情面：服务 companionMood + 交给总控的面登记 + 单独模式下的一轮。
// DSH 相关（存储读写、调模型、事件）由插件外壳以参数传入。

import { DEFAULTS, decay, describe, feel, initialMood } from './core.mjs';

/**
 * [store]：{ load() → 状态或 null, save(状态) }（同步；外壳负责落盘）。
 * [opts]：性格参数（neuroticism、agreeableness、halfLifeHours）。
 */
export function createMood({ store, opts = {}, now = Date.now, log = () => {} }) {
  const o = { ...DEFAULTS, ...opts };
  let mood = store.load() ?? initialMood(now());
  const listeners = new Set();

  const current = () => decay(mood, now(), o);

  function apply(label, intensity, source = 'unknown') {
    const next = feel(mood, label, intensity, now(), o);
    if (next.valence === mood.valence && next.arousal === mood.arousal) return;
    mood = next;
    try {
      store.save(mood);
    } catch (e) {
      log(`心情保存失败：${e?.message ?? e}`);
    }
    for (const fn of listeners) {
      try {
        fn({ label, intensity, source, mood: current() });
      } catch (e) {
        log(`心情订阅者出错：${e?.message ?? e}`);
      }
    }
  }

  /** CONTRACT.md §2 的 companionMood 服务。全部同步、不抛异常。 */
  const service = {
    version: 1,
    get: () => {
      const { valence, arousal, label, updatedAt } = current();
      return { valence, arousal, label, updatedAt };
    },
    feel: (label, intensity, source) => apply(label, intensity, source),
    describe: () => describe(current()),
    /** 订阅心情变化（羁绊在没有总控时用它拿同一份感受，不用再调一次模型）。返回退订函数。 */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  /** 交给总控的面登记。 */
  const aspect = {
    id: 'mood',
    title: '心情',
    version: 1,
    onAnalysis: (_result, turn) => {
      if (turn.feeling) apply(turn.feeling.label, turn.feeling.intensity, 'companion');
    },
    prompt: { order: 300, maxChars: 120, text: () => describe(current()) },
    state: () => ({ ...service.get(), personality: { neuroticism: o.neuroticism, agreeableness: o.agreeableness } }),
  };

  return { service, aspect };
}
