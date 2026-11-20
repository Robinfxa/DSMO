// 档案和生效范围（CONTRACT.md §12、§13）：每段对话归到一个档案或者「关」。
// 越具体越优先：对话 > 工作区 > 默认；DS Bot 的对话一律关（由 DSMO 同步过来，它知道哪些对话是 Bot 的）。

import { DEFAULT_PROFILE, validProfileId } from './shared/profiles.mjs';

const MAX = 5000;
export const MAX_PROFILES = 20;
const OFF = 'off';

const now0 = () => Date.now();
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
const validSession = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200;

function fresh(t) {
  return { v: 2, default: DEFAULT_PROFILE, profiles: [{ id: DEFAULT_PROFILE, name: '默认', persona: '', createdAt: t, usedAt: 0 }], conversations: {}, workspaces: {}, bots: [] };
}

/** 读存档：v1（§12 的关掉列表）转成 v2，关掉的对话变成「对话 = 关」。 */
export function migrate(raw, t = now0()) {
  if (raw?.v === 2 && Array.isArray(raw.profiles)) {
    const st = { ...fresh(t), ...raw };
    if (!st.profiles.some((p) => p.id === DEFAULT_PROFILE)) st.profiles.unshift(fresh(t).profiles[0]);
    st.conversations = { ...(raw.conversations ?? {}) };
    st.workspaces = { ...(raw.workspaces ?? {}) };
    st.bots = Array.isArray(raw.bots) ? raw.bots : [];
    return st;
  }
  const st = fresh(t);
  if (raw?.v === 1) {
    for (const id of Array.isArray(raw.off) ? raw.off : []) if (validSession(id)) st.conversations[id] = OFF;
    st.bots = Array.isArray(raw.bots) ? raw.bots.filter(validSession) : [];
  }
  return st;
}

/**
 * [store]：{ load, save }。[workspaceOf]：(sessionId) => 工作区 id 或 ''（外壳用 DSH 的 workspaceRegistry 实现）。
 */
export function createScope({ store, log = () => {}, now = now0, workspaceOf = () => '' }) {
  let st = migrate(store.load(), now());
  let bots = new Set(st.bots);
  const save = () => {
    const conv = Object.entries(st.conversations);
    if (conv.length > MAX) st.conversations = Object.fromEntries(conv.slice(-MAX));
    st.bots = [...bots].slice(-MAX);
    try {
      store.save(st);
    } catch (e) {
      log(`档案和生效范围保存失败：${e?.message ?? e}`);
    }
  };
  const exists = (id) => st.profiles.some((p) => p.id === id);
  /** 一层的取值能不能用：关，或者存在的档案。 */
  const usable = (v) => v === OFF || (typeof v === 'string' && exists(v));
  const wsOf = (sessionId) => {
    try {
      return String(workspaceOf(sessionId) ?? '');
    } catch {
      return '';
    }
  };

  /** 这段对话归哪个档案：{ profile: id | null（关）, from, workspaceId }。不知道是哪个对话时按默认。 */
  function resolve(sessionId) {
    const end = (v, from, workspaceId = '') => ({ profile: v === OFF ? null : v, from, workspaceId });
    const dflt = (workspaceId) => end(usable(st.default) ? st.default : DEFAULT_PROFILE, 'default', workspaceId);
    if (!validSession(sessionId)) return dflt('');
    if (bots.has(sessionId)) return end(OFF, 'bot');
    const c = st.conversations[sessionId];
    const workspaceId = wsOf(sessionId);
    if (usable(c)) return end(c, 'conversation', workspaceId);
    const w = workspaceId ? st.workspaces[workspaceId] : undefined;
    if (usable(w)) return end(w, 'workspace', workspaceId);
    return dflt(workspaceId);
  }

  /** 一层的设置：档案 id / 'off' / null（跟随上一层）。返回规整后的值，不合法时 undefined。 */
  const layerValue = (v) => (v === null || v === undefined || v === '' ? null : usable(v) ? v : undefined);

  const profile = (id) => st.profiles.find((p) => p.id === id);
  const listView = () => st.profiles.map((p) => ({ ...p }));

  return {
    resolve,
    profileOf: (sessionId) => resolve(sessionId).profile,
    inScope: (sessionId) => resolve(sessionId).profile !== null,
    /** 一个对话的情况（DSMO 的开关用）。enabled / off 是 §12 的旧字段。 */
    of(sessionId) {
      const r = resolve(sessionId);
      const c = st.conversations[sessionId];
      return { sessionId, ...r, conversation: usable(c) ? c : null, enabled: r.profile !== null, bot: bots.has(sessionId), off: c === OFF };
    },
    /** 整体：§12 的 off 列表 + 档案、各层设置。 */
    view: () => ({
      mode: 'all',
      off: Object.keys(st.conversations).filter((k) => st.conversations[k] === OFF),
      bots: bots.size,
      default: usable(st.default) ? st.default : DEFAULT_PROFILE,
      profiles: listView(),
      conversations: { ...st.conversations },
      workspaces: { ...st.workspaces },
    }),
    /** §12 的旧接口：打开 / 关掉一个对话。打开只去掉「关」，不动绑定的档案。 */
    set(sessionId, enabled) {
      if (!validSession(sessionId)) return false;
      if (enabled) {
        if (st.conversations[sessionId] === OFF) delete st.conversations[sessionId];
      } else st.conversations[sessionId] = OFF;
      save();
      return true;
    },
    /** 对话这一层：档案 id / 'off' / null（跟随工作区）。 */
    setConversation(sessionId, value) {
      const v = layerValue(value);
      if (!validSession(sessionId) || v === undefined) return false;
      delete st.conversations[sessionId]; // 改过的放到最后（超出上限时先丢最老的）
      if (v !== null) st.conversations[sessionId] = v;
      save();
      return true;
    },
    /** 工作区这一层：档案 id / 'off' / null（跟随默认）。 */
    setWorkspace(workspaceId, value) {
      const v = layerValue(value);
      if (!validSession(workspaceId) || v === undefined) return false;
      if (v === null) delete st.workspaces[workspaceId];
      else st.workspaces[workspaceId] = v;
      save();
      return true;
    },
    /** 默认这一层：档案 id 或 'off'。 */
    setDefault(value) {
      if (!usable(value)) return false;
      st.default = value;
      save();
      return true;
    },
    /** DSMO 同步过来的 Bot 对话（整份替换）。 */
    setBots(ids) {
      const next = new Set((Array.isArray(ids) ? ids : []).filter(validSession).slice(0, MAX));
      if (next.size === bots.size && [...next].every((id) => bots.has(id))) return false;
      bots = next;
      save();
      return true;
    },

    // ---- 档案 ----
    profiles: listView,
    hasProfile: exists,
    /** 新建档案；返回 { ok, value | error }。 */
    create({ name, persona } = {}) {
      const n = cleanName(name);
      if (!n) return { ok: false, error: '档案要有名字' };
      if (st.profiles.length >= MAX_PROFILES) return { ok: false, error: `最多 ${MAX_PROFILES} 个档案` };
      if (st.profiles.some((p) => p.name === n)) return { ok: false, error: '已经有同名的档案' };
      let id;
      do id = `p${now().toString(36).slice(-5)}${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
      while (exists(id) || !validProfileId(id));
      const p = { id, name: n, persona: cleanName(persona), createdAt: now(), usedAt: 0 };
      st.profiles.push(p);
      save();
      return { ok: true, value: { ...p } };
    },
    rename(id, name) {
      const p = profile(id);
      const n = cleanName(name);
      if (!p) return { ok: false, error: '找不到这个档案' };
      if (!n) return { ok: false, error: '档案要有名字' };
      if (st.profiles.some((x) => x !== p && x.name === n)) return { ok: false, error: '已经有同名的档案' };
      p.name = n;
      save();
      return { ok: true, value: { ...p } };
    },
    /** 关联一个人设（只记名字，DSMO 换人设时据此切档案）；'' 取消关联。 */
    linkPersona(id, persona) {
      const p = profile(id);
      if (!p) return { ok: false, error: '找不到这个档案' };
      p.persona = cleanName(persona);
      save();
      return { ok: true, value: { ...p } };
    },
    /** 删档案（默认档案不能删）。指向它的对话 / 工作区设置退回上一层；默认指向它时退回默认档案。 */
    remove(id) {
      if (id === DEFAULT_PROFILE) return { ok: false, error: '默认档案不能删' };
      if (!profile(id)) return { ok: false, error: '找不到这个档案' };
      st.profiles = st.profiles.filter((p) => p.id !== id);
      for (const m of [st.conversations, st.workspaces]) for (const k of Object.keys(m)) if (m[k] === id) delete m[k];
      if (st.default === id) st.default = DEFAULT_PROFILE;
      save();
      return { ok: true, value: { id } };
    },
    /** 记下档案最近用过（十分钟内只记一次，免得每轮写盘）。 */
    touch(id) {
      const p = profile(id);
      if (!p || now() - p.usedAt < 600_000) return;
      p.usedAt = now();
      save();
    },
  };
}
