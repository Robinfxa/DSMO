// 表达面的纯逻辑（CONTRACT.md §9）：学对方的说话方式（说法和黑话），按关系和心情挑几条注入。
// 设计参考 MaiBot 0.10–0.11 的表达方式学习和黑话学习（只学别人的话、按次数加权抽样、长期不用就淡），代码从头写。

import { sameThing, similarity, squash, tokens } from './shared/text.mjs';

const DAY = 24 * 3_600_000;
const SENSITIVE = /密码|验证码|身份证|证件号|银行卡|卡号|\d{6,}/i;
export const TONES = Object.freeze(['playful', 'soft', 'neutral']);

export const LIMITS = Object.freeze({
  perTurn: 2,
  items: 120,
  minToInject: 5,
  noRepeatTurns: 3,
  budget: 150,
  halfLifeDays: 21,
  freshDays: 30,
});

export function emptyExpression() {
  return { v: 1, items: [], turn: 0, lastInjected: [], seq: 0 };
}

const clip = (s, n) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) : t;
};
const norm = (s) => squash(s);
const newId = (st, now) => `x${now.toString(36)}${(++st.seq).toString(36)}`;

/** 有效分量：次数按三周半衰，加上反馈分；钉住的最高；导入后 30 天内不淡。 */
export function weight(x, now) {
  if (x.pinned) return 99;
  const days = Math.max(0, now - x.seen) / DAY;
  const decay = x.freshUntil && now < x.freshUntil ? 1 : Math.pow(0.5, days / LIMITS.halfLifeDays);
  return x.n * decay + (x.w ?? 0);
}

/** 记一条说法；只收真的出现在对方话里的（source 为 import 时由调用方保证）。 */
export function addStyle(st, raw, { now, user = '', source = 'auto', jobId } = {}) {
  const say = clip(raw?.say, 16);
  const when = clip(raw?.when, 12);
  if (say.length < 2 || !when || SENSITIVE.test(say)) return null;
  if (source === 'auto' && !norm(user).includes(norm(say))) return null;
  const tone = TONES.includes(raw?.tone) ? raw.tone : 'neutral';
  for (const x of st.items) {
    if (x.kind !== 'style') continue;
    if (norm(x.say) !== norm(say) && !(similarity(x.say, say) >= 0.6)) continue;
    x.n += 1;
    x.seen = now;
    if (!x.when.some((w) => sameThing(w, when) || similarity(w, when) >= 0.6)) x.when = [...x.when, when].slice(-3);
    if (jobId) x.contrib = { ...(x.contrib ?? {}), [jobId]: (x.contrib?.[jobId] ?? 0) + 1 };
    return x;
  }
  const x = { id: newId(st, now), kind: 'style', when: [when], say, tone, n: 1, w: 0, first: now, seen: now, lastUsedTurn: -99, pinned: false, source };
  if (jobId) x.jobId = jobId;
  if (source !== 'auto') x.freshUntil = now + LIMITS.freshDays * DAY;
  st.items.push(x);
  return x;
}

/** 记一个黑话（词和意思）。 */
export function addSlang(st, raw, { now, user = '', source = 'auto', jobId } = {}) {
  const word = clip(raw?.word, 8);
  const means = clip(raw?.means, 24);
  if (!word || !means || SENSITIVE.test(word)) return null;
  if (source === 'auto' && !norm(user).includes(norm(word))) return null;
  const old = st.items.find((x) => x.kind === 'slang' && norm(x.say) === norm(word));
  if (old) {
    old.n += 1;
    old.seen = now;
    if (means.length > old.means.length) old.means = means;
    if (jobId) old.contrib = { ...(old.contrib ?? {}), [jobId]: (old.contrib?.[jobId] ?? 0) + 1 };
    return old;
  }
  const x = { id: newId(st, now), kind: 'slang', when: [], say: word, means, tone: 'neutral', n: 1, w: 0, first: now, seen: now, lastUsedTurn: -99, pinned: false, source };
  if (jobId) x.jobId = jobId;
  if (source !== 'auto') x.freshUntil = now + LIMITS.freshDays * DAY;
  st.items.push(x);
  return x;
}

/** 一轮分析的结果入库：学、按反馈调整上一轮用过的说法。 */
export function learn(st, result, { now, user = '' }) {
  st.turn += 1;
  const added = [];
  if (!result || typeof result !== 'object') return added;
  for (const r of (Array.isArray(result.learn) ? result.learn : []).slice(0, LIMITS.perTurn)) {
    const x = addStyle(st, r, { now, user });
    if (x) added.push(x);
  }
  for (const r of (Array.isArray(result.slang) ? result.slang : []).slice(0, LIMITS.perTurn)) {
    const x = addSlang(st, r, { now, user });
    if (x) added.push(x);
  }
  const landed = Number(result.landed);
  if (landed === 1 || landed === -1)
    for (const id of st.lastInjected) {
      const x = st.items.find((i) => i.id === id);
      if (x) x.w = Math.max(-2, Math.min(3, (x.w ?? 0) + 0.3 * landed));
    }
  return added;
}

/** 淡掉的删掉，超过上限删最弱的。 */
export function maintain(st, now) {
  st.items = st.items.filter((x) => x.pinned || weight(x, now) >= 0.2 || now - x.seen < 30 * DAY);
  if (st.items.length > LIMITS.items) {
    const keep = [...st.items].sort((a, b) => weight(b, now) - weight(a, now)).slice(0, LIMITS.items);
    const ids = new Set(keep.map((x) => x.id));
    st.items = st.items.filter((x) => ids.has(x.id));
  }
}

/** 情境和对方这轮的话的重合度（二元组）。 */
const overlap = (whens, latest) => {
  const L = new Set(tokens(latest));
  if (!L.size) return 0;
  let best = 0;
  for (const w of whens) {
    const W = tokens(w);
    if (!W.length) continue;
    best = Math.max(best, W.filter((t) => L.has(t)).length / W.length);
  }
  return best;
};

/** 好感度档位（0–5）→ 这一轮最多借用几条说法。 */
const styleBudget = (bondLevel) => (bondLevel >= 5 ? 3 : bondLevel >= 3 ? 2 : 0);

/**
 * 这一轮挑什么（不调模型）。返回 { slang: [...], style: [...] }。
 * [random]：() => 0..1，测试时可固定。
 */
export function select(st, { latest = '', now, bondLevel = 2, moodValence = 0, random = Math.random }) {
  const live = st.items.filter((x) => weight(x, now) >= 0.2);
  if (live.length < LIMITS.minToInject) return { slang: [], style: [] };
  const fresh = (x) => st.turn - x.lastUsedTurn >= LIMITS.noRepeatTurns;
  const l = norm(latest);

  // 黑话：这一轮对方说到的优先（听得懂），否则最常用的一个
  const slangs = live.filter((x) => x.kind === 'slang');
  let slang = slangs.filter((x) => l && l.includes(norm(x.say))).slice(0, 2);
  if (!slang.length) slang = slangs.filter(fresh).sort((a, b) => weight(b, now) - weight(a, now)).slice(0, 1);

  // 说法：按关系决定几条；心情低落去掉俏皮的；「暧昧」以下不用俏皮的
  const k = styleBudget(bondLevel);
  let styles = live.filter((x) => x.kind === 'style' && fresh(x));
  if (moodValence < -0.3 || bondLevel < 5) styles = styles.filter((x) => x.tone !== 'playful');
  if (!k || !styles.length) return { slang, style: [] };
  const ws = styles.map((x) => weight(x, now));
  const lo = Math.min(...ws);
  const hi = Math.max(...ws);
  const scored = styles.map((x, i) => {
    const w = hi > lo ? 1 + (4 * (ws[i] - lo)) / (hi - lo) : 3; // 映射到 1–5 [MaiBot]
    return { x, score: 2 * overlap(x.when, latest) + Math.pow(random(), 1 / w) };
  });
  return { slang, style: scored.sort((a, b) => b.score - a.score).slice(0, k).map((s) => s.x) };
}

/** 拼注入文字（≤ 150 字）；什么都没有时返回 ''。 */
export function render({ slang = [], style = [] }, budget = LIMITS.budget) {
  let st = [...style];
  let sl = [...slang];
  const build = () => {
    const lines = [...st.map((x) => `- ${x.when[0]}的时候，对方会说「${x.say}」`), ...sl.map((x) => `- 「${x.say}」是${x.means}`)];
    if (!lines.length) return '';
    const head = st.length ? '对方说话的小习惯（和人设不冲突时可以自然借用，不必每句都用）：' : '对方的一些说法（听懂就好，不用模仿）：';
    return `${head}\n${lines.join('\n')}`;
  };
  let text = build();
  while (text.length > budget && st.length) {
    st.pop();
    text = build();
  }
  while (text.length > budget && sl.length) {
    sl.pop();
    text = build();
  }
  return { text, used: [...st, ...sl] };
}

/** 这一轮注入过的：记下第几轮用的（3 轮内不重复），说法留给下一轮按反馈调整。 */
export function markUsed(st, used) {
  for (const x of used) x.lastUsedTurn = st.turn;
  st.lastInjected = used.filter((x) => x.kind === 'style').map((x) => x.id);
}

export const EXPRESSION_INSTRUCTIONS =
  '只从对方这一轮的话里学，AI 说的不学。learn：对方有辨识度的说法（口头禅、句式），when 是什么情境 ≤12 字，say 是对方原话里的说法 ≤16 字，tone 选 playful/soft/neutral，最多 2 条；' +
  'slang：只在你们之间才懂的词和意思，最多 2 个；不写人名和具体事物，普通措辞（好的、哈哈）不学，没有就给空数组。' +
  'landed：上一轮 AI 的话对方受用吗，1 受用 / 0 看不出 / -1 不受用。';

export const EXPRESSION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    learn: {
      type: 'array',
      items: { type: 'object', properties: { when: { type: 'string' }, say: { type: 'string' }, tone: { type: 'string', enum: [...TONES] } } },
    },
    slang: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, means: { type: 'string' } } } },
    landed: { type: 'integer', minimum: -1, maximum: 1 },
  },
});

// ---------- 深度学习和导入（§11）：只从聊天记录里学对方的话 ----------

export const EXPRESSION_BATCH_SCHEMA = Object.freeze({
  type: 'object',
  properties: { learn: EXPRESSION_SCHEMA.properties.learn, slang: EXPRESSION_SCHEMA.properties.slang },
});
export const expressionBatchInstructions = (textType) =>
  textType === 'chatlog' || textType === 'session'
    ? '只从【对方】的话里学，【TA】说的不学。learn：对方有辨识度的说法（口头禅、句式），when ≤12 字，say 必须是【对方】原话里的说法 ≤16 字，tone 选 playful/soft/neutral，最多 10 条；slang：只在你们之间才懂的词和意思，最多 5 个；不写人名和具体事物，普通措辞不学。'
    : '';
