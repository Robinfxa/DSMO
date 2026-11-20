// 「对话 › 工作区 › 默认」三层归属（MaiDSH 总控的档案、设定集的作品都用它）：越具体越优先，DS Bot 的对话一律关。
// 只管规则和这几张表，存档里别的东西（档案列表、作品）由使用者自己管。

export const OFF = 'off';
const MAX = 5000;
export const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200;

/** DSH 的工作区里哪一个装着这段对话（workspaceRegistry.list() 是同步的，每个工作区带 sessionIds）。 */
export function workspaceFinder(ctx) {
  return (sessionId) => {
    const reg = ctx.get('workspaceRegistry');
    if (!reg?.list) return '';
    for (const w of reg.list()) if (w?.sessionIds?.includes?.(sessionId)) return w.id;
    return '';
  };
}

/**
 * [st]：存档对象，要有 default、workspaces、conversations、bots（数组）；就地修改。
 * [usable]：(值) => 这个目标（档案 id、作品 id）现在存在吗。[fallback]：默认那一层不能用时的值（OFF 或某个 id）。
 * [workspaceOf]：(sessionId) => 工作区 id 或 ''。[save]：() => void。
 */
export function createLayers(st, { usable, fallback = OFF, workspaceOf = () => '', save = () => {} }) {
  st.workspaces ??= {};
  st.conversations ??= {};
  let bots = new Set(Array.isArray(st.bots) ? st.bots : []);
  const ok = (v) => v === OFF || (typeof v === 'string' && usable(v));
  const wsOf = (sessionId) => {
    try {
      return String(workspaceOf(sessionId) ?? '');
    } catch {
      return '';
    }
  };
  const persist = () => {
    const conv = Object.entries(st.conversations);
    if (conv.length > MAX) st.conversations = Object.fromEntries(conv.slice(-MAX));
    st.bots = [...bots].slice(-MAX);
    save();
  };
  /** 一层的设置：目标 id / OFF / null（跟随上一层）。不合法时 undefined。 */
  const layerValue = (v) => (v === null || v === undefined || v === '' ? null : ok(v) ? v : undefined);
  const defaultValue = () => (ok(st.default) ? st.default : fallback);

  return {
    ok,
    defaultValue,
    /** 这段对话归哪儿：{ value: 目标 id | OFF, from, workspaceId }。不知道是哪个对话时按默认。 */
    resolve(sessionId) {
      if (!validId(sessionId)) return { value: defaultValue(), from: 'default', workspaceId: '' };
      if (bots.has(sessionId)) return { value: OFF, from: 'bot', workspaceId: '' };
      const c = st.conversations[sessionId];
      const workspaceId = wsOf(sessionId);
      if (ok(c)) return { value: c, from: 'conversation', workspaceId };
      const w = workspaceId ? st.workspaces[workspaceId] : undefined;
      if (ok(w)) return { value: w, from: 'workspace', workspaceId };
      return { value: defaultValue(), from: 'default', workspaceId };
    },
    conversation: (sessionId) => (ok(st.conversations[sessionId]) ? st.conversations[sessionId] : null),
    isBot: (sessionId) => bots.has(sessionId),
    botCount: () => bots.size,
    offConversations: () => Object.keys(st.conversations).filter((k) => st.conversations[k] === OFF),
    setConversation(sessionId, value) {
      const v = layerValue(value);
      if (!validId(sessionId) || v === undefined) return false;
      delete st.conversations[sessionId]; // 改过的放到最后（超出上限时先丢最老的）
      if (v !== null) st.conversations[sessionId] = v;
      persist();
      return true;
    },
    setWorkspace(workspaceId, value) {
      const v = layerValue(value);
      if (!validId(workspaceId) || v === undefined) return false;
      if (v === null) delete st.workspaces[workspaceId];
      else st.workspaces[workspaceId] = v;
      persist();
      return true;
    },
    /** 默认这一层：目标 id 或 OFF。 */
    setDefault(value) {
      if (!ok(value)) return false;
      st.default = value;
      persist();
      return true;
    },
    /** DSMO 同步过来的 Bot 对话（整份替换）。 */
    setBots(ids) {
      const next = new Set((Array.isArray(ids) ? ids : []).filter(validId).slice(0, MAX));
      if (next.size === bots.size && [...next].every((id) => bots.has(id))) return false;
      bots = next;
      persist();
      return true;
    },
    /** 一个目标被删了：指向它的对话 / 工作区设置去掉（退回上一层），默认指向它时换成 [to]。 */
    forget(target, to = fallback) {
      for (const m of [st.conversations, st.workspaces]) for (const k of Object.keys(m)) if (m[k] === target) delete m[k];
      if (st.default === target) st.default = to;
      persist();
    },
    view: () => ({ default: defaultValue(), conversations: { ...st.conversations }, workspaces: { ...st.workspaces }, bots: bots.size }),
  };
}
