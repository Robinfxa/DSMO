// MaiDSH 在哪些对话里生效（CONTRACT.md §12）：默认所有对话，排除你关掉的和 DS Bot 的对话。
// DS Bot 的对话由 DSMO 同步过来（它知道哪些对话是 Bot 的）。

const MAX = 5000;

export function createScope({ store, log = () => {} }) {
  let st = store.load();
  if (!st || st.v !== 1) st = { v: 1, mode: 'all', off: [], bots: [] };
  let off = new Set(st.off);
  let bots = new Set(st.bots);
  const save = () => {
    st = { v: 1, mode: 'all', off: [...off].slice(-MAX), bots: [...bots].slice(-MAX) };
    try {
      store.save(st);
    } catch (e) {
      log(`生效范围保存失败：${e?.message ?? e}`);
    }
  };
  const valid = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200;

  return {
    /** 这个对话里 MaiDSH 生效吗；不知道是哪个对话时（id 为空）按生效算。 */
    inScope: (sessionId) => !sessionId || (!off.has(sessionId) && !bots.has(sessionId)),
    /** 一个对话的状态，给 DSMO 的开关用。 */
    of: (sessionId) => ({ sessionId, enabled: !off.has(sessionId) && !bots.has(sessionId), bot: bots.has(sessionId), off: off.has(sessionId) }),
    /** 整体：关掉的对话列表（DSMO 菜单里显示开关状态用）和 Bot 对话的个数。 */
    view: () => ({ mode: 'all', off: [...off], bots: bots.size }),
    /** 打开 / 关掉一个对话。Bot 的对话不能单独打开（它们总是排除）。 */
    set(sessionId, enabled) {
      if (!valid(sessionId)) return false;
      if (enabled) off.delete(sessionId);
      else off.add(sessionId);
      save();
      return true;
    },
    /** DSMO 同步过来的 Bot 对话（整份替换）。 */
    setBots(ids) {
      const next = new Set((Array.isArray(ids) ? ids : []).filter(valid).slice(0, MAX));
      if (next.size === bots.size && [...next].every((id) => bots.has(id))) return false;
      bots = next;
      save();
      return true;
    },
  };
}
