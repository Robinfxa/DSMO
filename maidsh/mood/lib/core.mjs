// 心情：两条轴（愉悦 valence、唤醒 arousal，都在 -1..1），每轮按一个情绪标签推一下，
// 随时间按指数曲线回到基线。性格（神经质、宜人性，0..1）决定回落快慢和平时的底色。
// 纯函数，不碰 DSH：插件外壳（index.mjs）负责事件、存储和注入。
// 设计参考 MaiBot 早期的心情模块（思路），公式与数值是这里自己定的。

/** 共用情绪标签 → 单位强度下对 (valence, arousal) 的推动（CONTRACT.md §5）。 */
export const EMOTIONS = Object.freeze({
  开心: [0.25, 0.15],
  害羞: [0.15, 0.1],
  感动: [0.25, 0.05],
  想念: [-0.05, -0.05],
  平静: [0, -0.1],
  惊讶: [0.05, 0.25],
  困惑: [-0.05, 0.1],
  委屈: [-0.2, 0.05],
  吃醋: [-0.15, 0.2],
  难过: [-0.25, -0.15],
  生气: [-0.3, 0.3],
  害怕: [-0.25, 0.25],
  厌烦: [-0.15, 0.05],
});

/** 心情的名字：离当前 (valence, arousal) 最近的锚点。 */
const ANCHORS = [
  ['兴奋', 0.5, 0.45],
  ['快乐', 0.35, 0.25],
  ['满足', 0.25, 0.05],
  ['放松', 0.4, -0.35],
  ['安心', 0.2, -0.2],
  ['平静', 0, 0],
  ['烦躁', -0.2, 0.3],
  ['焦虑', -0.3, 0.55],
  ['生气', -0.5, 0.45],
  ['低落', -0.25, -0.25],
  ['难过', -0.5, -0.35],
  ['疲倦', -0.15, -0.55],
];

export const DEFAULTS = Object.freeze({
  /** 偏离基线的一半在这么多小时里回落。 */
  halfLifeHours: 2,
  /** 0..1；越高情绪变化越快、回落也越快。 */
  neuroticism: 0.5,
  /** 0..1；越高越容易维持好心情、坏心情消得快；很高或很低时基线偏移。 */
  agreeableness: 0.5,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function initialMood(now) {
  return { valence: 0, arousal: 0, label: '平静', updatedAt: now };
}

/** 宜人性很高或很低时，平时的心情底色。 */
export function baseline(agreeableness) {
  if (agreeableness < 0.2) return (agreeableness - 0.2) * 0.5;
  if (agreeableness > 0.8) return (agreeableness - 0.8) * 0.5;
  return 0;
}

/** [mood] 过了 now - updatedAt 之后的样子。 */
export function decay(mood, now, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hours = Math.max(0, (now - mood.updatedAt) / 3_600_000);
  if (hours === 0) return mood;
  const k = Math.LN2 / Math.max(0.05, o.halfLifeHours);
  const neuro = 1 + (o.neuroticism - 0.5) * 0.4;
  const agree = 1 + (o.agreeableness - 0.5) * 0.4;
  const base = baseline(o.agreeableness);
  // 好心情：宜人的人留得久；坏心情：宜人的人消得快。
  const kv = mood.valence >= base ? k / agree : k * agree;
  const valence = base + (mood.valence - base) * Math.exp(-kv * hours * neuro);
  const arousal = mood.arousal * Math.exp(-k * hours * neuro);
  return withLabel({ valence: clamp(valence, -1, 1), arousal: clamp(arousal, -1, 1), updatedAt: now });
}

/** 一个情绪标签（强度 0..1）推一下心情；先按时间回落，再加上这一下。未知标签不变。 */
export function feel(mood, label, intensity, now, opts = {}) {
  const push = EMOTIONS[label];
  const settled = decay(mood, now, opts);
  if (!push) return settled;
  const o = { ...DEFAULTS, ...opts };
  const i = clamp(Number(intensity) || 0, 0, 1);
  // 神经质高的人被同样的事推得更远。
  const swing = 1 + (o.neuroticism - 0.5) * 0.4;
  return withLabel({
    valence: clamp(settled.valence + push[0] * i * swing, -1, 1),
    arousal: clamp(settled.arousal + push[1] * i * swing, -1, 1),
    updatedAt: now,
  });
}

function withLabel(m) {
  let best = ANCHORS[0];
  let d = Infinity;
  for (const a of ANCHORS) {
    const dd = (a[1] - m.valence) ** 2 + (a[2] - m.arousal) ** 2;
    if (dd < d) [best, d] = [a, dd];
  }
  return { ...m, label: best[0] };
}

/** 注入用的一句话；接近平静时不说（''）。 */
export function describe(mood) {
  if (Math.abs(mood.valence) < 0.1 && Math.abs(mood.arousal) < 0.1) return '';
  let s = `你现在的心情：${mood.label}`;
  if (mood.valence > 0.5) s += '，心情很好';
  else if (mood.valence < -0.5) s += '，心情不太好';
  if (mood.arousal > 0.4) s += '，情绪有些激动';
  else if (mood.arousal < -0.4) s += '，没什么精神';
  return `${s}。说话时自然带出这种状态，不要直接说出来。`;
}
