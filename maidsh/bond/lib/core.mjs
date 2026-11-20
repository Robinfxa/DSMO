// 羁绊（好感度）：一个 -1000..1000 的关系值，6 档。每轮按一个情绪标签变化，变化有人味：
//   1. 越接近两端越难再变（关系到顶了不会无限涨，跌到底也不会无限跌）；
//   2. 关系越差越难修复，关系越好越容易被伤到；
//   3. 连续的正面或负面互动会叠加放大（最多 2 倍）；
//   4. 心情好时好的事加分更多、坏的事扣分更少（要装了心情面）。
// 注入时很克制：「一般」档不说，两端总是说，其余档隔几轮说一次。
// 纯函数，不碰 DSH。设计参考 MaiBot 早期的关系模块（思路），公式与数值是这里自己定的。

/** 共用情绪标签 → 单位强度下关系值的基本变化（再乘 gain）。 */
export const IMPACT = Object.freeze({
  开心: 1.5,
  害羞: 2,
  感动: 2,
  想念: 1.5,
  平静: 0.3,
  惊讶: 0.6,
  困惑: 0,
  委屈: -0.5,
  吃醋: -0.3,
  难过: -0.5,
  生气: -2,
  害怕: -1.5,
  厌烦: -1,
});

const POSITIVE = new Set(['开心', '害羞', '感动', '想念', '惊讶']);
const NEGATIVE = new Set(['委屈', '难过', '生气', '害怕', '厌烦']);
/** 连续 n 次同向时的放大倍数（n 取绝对值，最多 7）。 */
const STREAK_GAIN = [1, 1, 1.1, 1.2, 1.4, 1.7, 1.9, 2];

export const LEVELS = Object.freeze(['厌恶', '冷淡', '一般', '亲近', '喜欢', '暧昧']);
const BOUNDS = [-227, -73, 227, 587, 900];

const HINTS = [
  '你现在有点讨厌对方，回应冷淡、简短。',
  '你对对方有些冷淡，不太想多说。',
  '',
  '你和对方挺亲近的，愿意多聊几句。',
  '你喜欢对方，会积极回应、关心对方。',
  '你和对方的关系很亲密暧昧，说话会带点亲昵和在意。',
];

export const DEFAULTS = Object.freeze({
  /** 关系值每轮变化的放大系数：「开心」强度 1 大约 +9。 */
  gain: 6,
  /** 中间几档隔几轮提一次的概率。 */
  hintChance: 0.6,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function initialBond(now) {
  return { value: 0, level: 2, levelName: LEVELS[2], streak: 0, updatedAt: now, recent: [] };
}

export function levelOf(value) {
  let level = 0;
  while (level < BOUNDS.length && value >= BOUNDS[level]) level++;
  return level;
}

/**
 * 一次互动之后的关系。[moodValence]：装了心情面时当前的愉悦度（-1..1），没有就传 0。
 * 返回新状态；recent 里留最近 20 次变化（给 DSMO 的「陪伴」页看）。
 */
export function interact(bond, label, intensity, now, moodValence = 0, opts = {}) {
  const base = IMPACT[label];
  if (base === undefined) return bond;
  const o = { ...DEFAULTS, ...opts };
  const i = clamp(Number(intensity) || 0, 0, 1);
  const old = clamp(bond.value, -1000, 1000);

  // 连续同向的互动
  let streak = bond.streak;
  if (POSITIVE.has(label)) streak = streak >= 0 ? Math.min(7, streak + 1) : 0;
  else if (NEGATIVE.has(label)) streak = streak <= 0 ? Math.max(-7, streak - 1) : 0;

  let delta = base * i * o.gain;
  // 1 + 2：两端难变；关系好时伤害放大、关系差时修复变慢
  if (old >= 0) delta *= delta >= 0 ? Math.cos((Math.PI * old) / 2000) : Math.exp(old / 2000);
  else delta *= delta >= 0 ? Math.exp(old / 2000) : Math.cos((Math.PI * old) / 2000);
  // 3：连续同向放大，反向时打折
  const g = STREAK_GAIN[Math.abs(streak)];
  if (streak !== 0) delta = Math.sign(delta) === Math.sign(streak) ? delta * g : delta / g;
  // 4：心情的影响（愉悦度的平方，同号放大、异号减弱）
  const v = clamp(Number(moodValence) || 0, -1, 1);
  if (v !== 0 && delta !== 0) delta += delta * v * v * Math.sign(delta * v);

  const value = clamp(old + delta, -1000, 1000);
  const level = levelOf(value);
  const recent = [{ at: now, label, intensity: i, delta: Math.round(delta * 10) / 10 }, ...(bond.recent ?? [])].slice(0, 20);
  return { value, level, levelName: LEVELS[level], streak, updatedAt: now, recent };
}

/**
 * 这一轮要不要提关系、提什么。[roll]：0..1 的随机数，一轮只掷一次（同一轮里每一步提示词要一致）。
 */
export function hint(bond, roll, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const text = HINTS[bond.level] ?? '';
  if (!text) return '';
  if (bond.level === 0 || bond.level === 5) return text;
  return roll < o.hintChance ? text : '';
}
