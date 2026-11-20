// 档案和生效范围（CONTRACT.md §12、§13）：每段对话归到一个档案或者「关」。
// 越具体越优先：对话 > 工作区 > 默认；DS Bot 的对话一律关（由 DSMO 同步过来，它知道哪些对话是 Bot 的）。

import { OFF, createLayers, validId } from './shared/layers.mjs';
import { DEFAULT_PROFILE, validProfileId } from './shared/profiles.mjs';

export const MAX_PROFILES = 20;

const now0 = () => Date.now();
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);

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
    for (const id of Array.isArray(raw.off) ? raw.off : []) if (validId(id)) st.conversations[id] = OFF;
    st.bots = Array.isArray(raw.bots) ? raw.bots.filter(validId) : [];
  }
  return st;
}

/**
 * [store]：{ load, save }。[workspaceOf]：(sessionId) => 工作区 id 或 ''（外壳用 DSH 的 workspaceRegistry 实现）。
 */
export function createScope({ store, log = () => {}, now = now0, workspaceOf = () => '' }) {
  const st = migrate(store.load(), now());
  const save = () => {
    try {
      store.save(st);
    } catch (e) {
      log(`档案和生效范围保存失败：${e?.message ?? e}`);
    }
  };
  const exists = (id) => st.profiles.some((p) => p.id === id);
  // 对话 › 工作区 › 默认，Bot 一律关（shared/layers.mjs，设定集也用这一套）
  const layers = createLayers(st, { usable: exists, fallback: DEFAULT_PROFILE, workspaceOf, save });

  /** 这段对话归哪个档案：{ profile: id | null（关）, from, workspaceId }。不知道是哪个对话时按默认。 */
  function resolve(sessionId) {
    const r = layers.resolve(sessionId);
    return { profile: r.value === OFF ? null : r.value, from: r.from, workspaceId: r.workspaceId };
  }

  const profile = (id) => st.profiles.find((p) => p.id === id);
  const listView = () => st.profiles.map((p) => ({ ...p }));

  return {
    resolve,
    profileOf: (sessionId) => resolve(sessionId).profile,
    inScope: (sessionId) => resolve(sessionId).profile !== null,
    /** 一个对话的情况（DSMO 的开关用）。enabled / off 是 §12 的旧字段。 */
    of(sessionId) {
      const r = resolve(sessionId);
      const c = layers.conversation(sessionId);
      return { sessionId, ...r, conversation: c, enabled: r.profile !== null, bot: layers.isBot(sessionId), off: c === OFF };
    },
    /** 整体：§12 的 off 列表 + 档案、各层设置。 */
    view: () => {
      const v = layers.view();
      return { mode: 'all', off: layers.offConversations(), bots: v.bots, default: v.default, profiles: listView(), conversations: v.conversations, workspaces: v.workspaces };
    },
    /** §12 的旧接口：打开 / 关掉一个对话。打开只去掉「关」，不动绑定的档案。 */
    set(sessionId, enabled) {
      if (enabled) return layers.conversation(sessionId) === OFF ? layers.setConversation(sessionId, null) : validId(sessionId);
      return layers.setConversation(sessionId, OFF);
    },
    /** 对话这一层：档案 id / 'off' / null（跟随工作区）。 */
    setConversation: layers.setConversation,
    /** 工作区这一层：档案 id / 'off' / null（跟随默认）。 */
    setWorkspace: layers.setWorkspace,
    /** 默认这一层：档案 id 或 'off'。 */
    setDefault: layers.setDefault,
    /** DSMO 同步过来的 Bot 对话（整份替换）。 */
    setBots: layers.setBots,

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
      layers.forget(id, DEFAULT_PROFILE);
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
