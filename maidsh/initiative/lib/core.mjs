// 主动面的纯逻辑（CONTRACT.md §10）：随机排下一次主动的时刻、约好的回访、不打扰的规矩、开口时的隐藏提示。
// 设计参考 MaiBot 0.11 的空闲掷骰（空闲越久越可能开口、按时段打折、触发后要等对方回话才复位）
// 和 1.x 的停机续聊（按间隔分档描述），代码从头写。不碰 DSH，时间和随机数都由参数给出。

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULTS = Object.freeze({
  /** 每天最多主动几次。 */
  perDay: 3,
  /** 两次主动至少隔几小时（没回就翻倍）。 */
  minGapHours: 4,
  /** 聊完之后至少隔几小时才可能主动。 */
  afterChatHours: 2,
  /** 在最早时刻之后多少小时内随机挑。 */
  spreadHours: 8,
  /** 安静时段（本地时间，HH:MM）。 */
  quietStart: '23:30',
  quietEnd: '08:00',
  /** 连着几次没回就停，直到对方先开口。 */
  stopAfterIgnored: 2,
  /** 错过多久以内还补上。 */
  graceHours: 2,
});

export function emptyInitiative() {
  return { v: 1, lastUserAt: 0, lastReplyAt: 0, sessionId: '', lastTopic: '', nextAt: 0, followups: [], day: '', count: 0, lastInitiativeAt: 0, ignored: 0, hours: Array(24).fill(0), pending: null };
}

const hm = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const minutesOf = (t) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};
const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** 是否在安静时段（支持跨午夜）。 */
export function quiet(t, o = DEFAULTS) {
  const m = minutesOf(t);
  const a = hm(o.quietStart);
  const b = hm(o.quietEnd);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

/** 安静时段结束的那一刻（t 不在安静时段时返回 t）。 */
export function quietEnd(t, o = DEFAULTS) {
  if (!quiet(t, o)) return t;
  const d = new Date(t);
  const end = hm(o.quietEnd);
  d.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 现在的退避间隔（小时）：没回一次翻一倍。 */
export const gapHours = (st, o = DEFAULTS) => o.minGapHours * Math.pow(2, st.ignored);

/**
 * 排下一次随机主动 [MaiBot 空闲掷骰 → 预先排好的随机时刻]：
 * 最早时刻 = max(聊完 + 2h, 上次主动 + 退避间隔)，之后 spreadHours 内随机，越晚越可能（pdf ∝ 时长）；
 * 落在安静时段顺延到早上；对方平时几乎不在线的钟点尽量避开；今天次数满了排到明天。
 */
export function planNext(st, now, { random = Math.random, o = DEFAULTS } = {}) {
  if (st.ignored >= o.stopAfterIgnored || !st.sessionId) {
    st.nextAt = 0;
    return 0;
  }
  let earliest = Math.max(now, st.lastUserAt + o.afterChatHours * HOUR, st.lastInitiativeAt + gapHours(st, o) * HOUR);
  if (dayOf(earliest) === st.day && st.count >= o.perDay) {
    const d = new Date(earliest);
    d.setHours(0, 0, 0, 0);
    earliest = quietEnd(d.getTime() + DAY - MIN, o) + MIN;
  }
  const total = st.hours.reduce((a, b) => a + b, 0);
  let at = 0;
  for (let i = 0; i < 6; i++) {
    at = quietEnd(earliest + o.spreadHours * HOUR * Math.sqrt(random()), o);
    if (quiet(earliest + 1, o) || quiet(at - 1, o)) at += random() * 90 * MIN; // 早上别正好卡在整点
    if (total < 20 || st.hours[new Date(at).getHours()] / total >= 0.02) break; // 她平时这个点在线
  }
  st.nextAt = Math.round(at);
  return st.nextAt;
}

/** 对方说了一轮（真的回话）：记活跃时段、清零退避、按需要记回访、重新排。 */
export function onUserTurn(st, { now, sessionId, followup, topic, random = Math.random, o = DEFAULTS }) {
  st.hours[new Date(now).getHours()] += 1;
  if (st.hours.reduce((a, b) => a + b, 0) > 2000) st.hours = st.hours.map((h) => Math.floor(h / 2));
  st.lastUserAt = now;
  st.ignored = 0;
  st.pending = null;
  if (sessionId) st.sessionId = sessionId;
  if (topic) st.lastTopic = String(topic).slice(0, 40);
  if (followup) addFollowup(st, followup, now);
  planNext(st, now, { random, o });
}

/**
 * 过期的回访（过了约定时间 2 小时还没发出去：碰上安静时段、次数用完、App 没开……）不再单独发，
 * 只把它的由头留给下一次主动。返回是否有变化。
 */
export function pruneFollowups(st, now, { o = DEFAULTS } = {}) {
  const stale = st.followups.filter((f) => now - f.at > o.graceHours * HOUR);
  if (!stale.length) return false;
  st.followups = st.followups.filter((f) => now - f.at <= o.graceHours * HOUR);
  st.lastTopic = stale.map((f) => f.reason).filter(Boolean).join('、') || st.lastTopic;
  return true;
}

/** 记一次约好的回访（总控分析出的 followup）。 */
export function addFollowup(st, followup, now) {
  const after = Number(followup?.afterMin);
  if (!Number.isFinite(after) || after < 5 || after > 24 * 60) return false;
  st.followups = [...st.followups.filter((f) => f.at > now), { at: now + after * MIN, reason: String(followup.reason ?? '').slice(0, 30), sessionId: st.sessionId }].slice(-3);
  return true;
}

/** 启动时：错过不久的补上（一两分钟后），错过太久的重排；过期的回访并进下一次主动的由头。 */
export function onStartup(st, now, { random = Math.random, o = DEFAULTS } = {}) {
  const late = st.followups.filter((f) => f.at <= now);
  st.followups = st.followups.filter((f) => f.at > now || now - f.at <= o.graceHours * HOUR);
  const missed = late.filter((f) => now - f.at > o.graceHours * HOUR);
  if (missed.length) st.lastTopic = missed.map((f) => f.reason).filter(Boolean).join('、') || st.lastTopic;
  if (st.nextAt && st.nextAt <= now) {
    if (now - st.nextAt <= o.graceHours * HOUR && !quiet(now, o)) st.nextAt = now + (1 + random() * 2) * MIN;
    else planNext(st, now, { random, o });
  } else if (!st.nextAt) planNext(st, now, { random, o });
}

/**
 * 现在该不该主动；返回 { kind: 'followup' | 'random', reason } 或 null。
 * [bondLevel]：好感度档位，「冷淡」「厌恶」（≤1）不主动。
 */
export function due(st, now, { bondLevel = 2, o = DEFAULTS } = {}) {
  pruneFollowups(st, now, { o });
  if (st.pending || bondLevel <= 1 || st.ignored >= o.stopAfterIgnored || quiet(now, o) || !st.sessionId) return null;
  if (dayOf(now) === st.day && st.count >= o.perDay) return null;
  const f = st.followups.find((x) => x.at <= now);
  if (f) return { kind: 'followup', reason: f.reason, sessionId: f.sessionId || st.sessionId };
  if (st.nextAt && st.nextAt <= now && now - st.lastInitiativeAt >= gapHours(st, o) * HOUR) return { kind: 'random', reason: st.lastTopic, sessionId: st.sessionId };
  return null;
}

/** 主动发出去了：计数、记下等对方回话、重排。 */
export function onInitiated(st, now, plan, { random = Math.random, o = DEFAULTS } = {}) {
  if (dayOf(now) !== st.day) {
    st.day = dayOf(now);
    st.count = 0;
  }
  st.count += 1;
  st.lastInitiativeAt = now;
  if (plan.kind === 'followup') st.followups = st.followups.filter((f) => f.at > now);
  st.pending = { at: now, kind: plan.kind };
  planNext(st, now, { random, o });
}

/** TA 主动的那一轮结束了：对方没回之前不算数；对方一直没回（到下次该主动时），记一次「没回」。 */
export function onInitiativeDone(st) {
  if (st.pending) st.pending.done = true;
}
export function settlePending(st, now, { o = DEFAULTS } = {}) {
  if (!st.pending) return;
  // TA 主动的那一轮一直没等到结束的消息（App 在那一轮里被杀了）：两小时后当作已经结束
  if (!st.pending.done && now - st.pending.at > 2 * HOUR) st.pending.done = true;
  if (!st.pending.done) return;
  if (now - st.pending.at >= gapHours(st, o) * HOUR) {
    st.ignored += 1;
    st.pending = null;
  }
}

/** 间隔的说法 [MaiBot 停机续聊的分档]。 */
export function gapText(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 >= 10 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} 天` : `${Math.floor(d / 30)} 个多月`;
}
const gapMood = (ms) => (ms < 6 * HOUR ? '刚分开没多久' : ms < DAY ? '隔了大半天' : ms < 3 * DAY ? '一两天没聊了' : '好些天没聊了');

/** [到几点之前, 叫什么]。 */
const PERIODS = [
  [5, '凌晨'], [9, '早上'], [11, '上午'], [13, '中午'], [17, '下午'], [19, '傍晚'], [23, '晚上'], [24, '深夜'],
];
const periodOf = (t) => {
  const h = new Date(t).getHours();
  return (PERIODS.find(([end]) => h < end) ?? [0, '深夜'])[1];
};

/**
 * TA 开口用的隐藏提示 [MaiBot 1.x 的主动任务：由 TA 自己决定怎么说]。
 * [hooks]：记忆里的由头（对方的日程、没聊完的事），最多 2 条。
 */
export function initiativePrompt(st, now, plan, { mood = '', bond = '', hooks = [] } = {}) {
  const since = st.lastUserAt ? now - st.lastUserAt : 0;
  const lines = [
    '（这不是对方发来的消息，对方现在没有说话。这是你自己想主动找对方说话的时刻。）',
    since ? `你们上次聊天是 ${gapText(since)}前，${gapMood(since)}${st.lastTopic && plan.kind !== 'followup' ? `，当时聊到：${st.lastTopic}` : ''}。现在是${periodOf(now)}。` : `现在是${periodOf(now)}。`,
  ];
  if (plan.kind === 'followup') lines.push(`对方之前说过「${plan.reason || '待会儿再聊'}」，时间差不多了，你想问问对方怎么样了。`);
  if (mood) lines.push(mood);
  if (bond) lines.push(bond);
  const h = hooks.filter(Boolean).slice(0, 2);
  if (h.length) lines.push(`你心里记着：${h.join('；')}。合适的话可以顺口提一句，不合适就不提。`);
  lines.push('用符合你人设的语气，主动说一两句短话，像自然地想起了对方；不要提「系统」「提醒」「定时」，不要说「你好久没理我」这类让对方有压力的话。');
  return lines.join('\n');
}

/** 平时的时间感：对方隔了很久才说话时，在陪伴段落前加一句（≥ 6 小时）。 */
export function gapLine(st, now) {
  if (!st.lastUserAt) return '';
  const since = now - st.lastUserAt;
  return since >= 6 * HOUR ? `（距离你们上次聊天已经过去 ${gapText(since)}。）` : '';
}

export const INITIATIVE_INSTRUCTIONS = 'followup：对方说要离开一会儿、过会儿再聊（去洗澡、开会、睡午觉）时，afterMin 填大约多少分钟后可以回来问问（5–1440），reason 填对方去做什么（≤10 字）；没有就省略。';
export const INITIATIVE_SCHEMA = Object.freeze({
  type: 'object',
  properties: { followup: { type: 'object', properties: { afterMin: { type: 'integer', minimum: 5, maximum: 1440 }, reason: { type: 'string' } } } },
});
