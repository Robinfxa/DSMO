// 羁绊面：服务 companionBond + 交给总控的面登记。DSH 相关由插件外壳传入。

import { DEFAULTS, LEVELS, hint, initialBond, interact } from './core.mjs';

/**
 * [store]：{ load(), save(状态) }。[moodValence]：() => -1..1，装了心情面时读它，没有返回 0。
 * [roll]：() => 0..1，这一轮的随机数（有总控时用总控的，单独时外壳每轮换一个）。
 */
export function createBond({ store, opts = {}, now = Date.now, log = () => {}, moodValence = () => 0, roll = Math.random }) {
  const o = { ...DEFAULTS, ...opts };
  let bond = store.load() ?? initialBond(now());

  function apply(label, intensity, source = 'unknown') {
    let v = 0;
    try {
      v = Number(moodValence()) || 0;
    } catch {
      v = 0;
    }
    const next = interact(bond, label, intensity, now(), v, o);
    if (next === bond) return;
    next.recent[0].source = source;
    bond = next;
    try {
      store.save(bond);
    } catch (e) {
      log(`羁绊保存失败：${e?.message ?? e}`);
    }
  }

  const view = () => {
    const { value, level, levelName, streak, updatedAt } = bond;
    return { value: Math.round(value * 10) / 10, level, levelName, streak, updatedAt };
  };

  /** CONTRACT.md §2 的 companionBond 服务。 */
  const service = {
    version: 1,
    get: view,
    interact: (label, intensity, source) => apply(label, intensity, source),
    describe: () => hint(bond, 0, o),
  };

  const aspect = {
    id: 'bond',
    title: '羁绊',
    version: 1,
    onAnalysis: (_result, turn) => {
      if (turn.feeling) apply(turn.feeling.label, turn.feeling.intensity, 'companion');
    },
    prompt: { order: 400, maxChars: 80, text: (turn) => hint(bond, turn?.roll ?? roll(), o) },
    state: () => ({ ...view(), levels: LEVELS, recent: bond.recent.slice(0, 10) }),
  };

  return { service, aspect, hintNow: (r) => hint(bond, r, o) };
}
