// MaiDSH 在哪些对话里生效（maidsh/CONTRACT.md §12）：默认所有对话，排除你在「更多」菜单里关掉的，
// 和 DS Bot 的对话。Bot 对话只有这边知道，所以装了总控时把整份列表同步给引擎（Bot 变化时再同步）。

import { effect, signal } from '@preact/signals';
import { botSessions } from '../plugins/conflicts';
import { errText, showToast } from '../state/store';
import { hasUpdate, installed } from '../plugins/frontend';
import { MaidshError, PLUGIN_ID, get, hasModule, post } from './api';

const SCOPE = '/api/maidsh/scope';

/** 关掉了陪伴的对话（引擎为准；装了总控后读一次，改了以后跟着更新）。 */
export const scopeOff = signal<ReadonlySet<string>>(new Set());

export async function refreshScope() {
  if (!hasModule('core')) return;
  try {
    const v = await get<{ off?: string[] }>(SCOPE);
    scopeOff.value = new Set(Array.isArray(v.off) ? v.off : []);
  } catch {
    /* 引擎还没重启或连不上：菜单按「生效」显示 */
  }
}

/** 在这段对话里打开 / 关掉陪伴。 */
export async function setConversationScope(sessionId: string, enabled: boolean) {
  await post(SCOPE, { action: 'set', sessionId, enabled });
  const next = new Set(scopeOff.value);
  if (enabled) next.delete(sessionId);
  else next.add(sessionId);
  scopeOff.value = next;
}

export const isScopeOff = (sessionId: string) => scopeOff.value.has(sessionId);

/** 设定集（dsmo-lore，maidsh/LORE-DESIGN.md §7）也认 Bot 对话：它和陪伴无关，单独装着时也要同步。 */
const LORE_ID = '@api-demo/dsmo-lore';
const LORE_BINDING = '/api/dsmo-lore/binding';
const hasLore = () => installed.value.some((x) => x.id === LORE_ID && x.enabled);

let lastBots = '';
let lastLoreBots = '';
/** 启动时：装了总控就读一次范围，并把 Bot 对话同步过去；Bot 变了再同步。设定集同理。 */
export function watchMaidshScope() {
  effect(() => {
    if (!hasLore()) {
      lastLoreBots = '';
      return;
    }
    const ids = botSessions();
    const key = [...ids].sort().join('\n');
    if (key === lastLoreBots) return;
    lastLoreBots = key;
    void post(LORE_BINDING, { action: 'set-bots', sessionIds: ids }).catch(() => {
      lastLoreBots = ''; // 下次再试（引擎还没重启时路由不在）
    });
  });
  let readOnce = false;
  effect(() => {
    if (!hasModule('core')) {
      readOnce = false;
      lastBots = '';
      return;
    }
    if (!readOnce) {
      readOnce = true;
      void refreshScope();
    }
    const ids = botSessions();
    const key = [...ids].sort().join('\n');
    if (key === lastBots) return;
    lastBots = key;
    void post(SCOPE, { action: 'set-bots', sessionIds: ids }).catch(() => {
      lastBots = ''; // 下次再试
    });
  });
}

/** 菜单里的开关：切换后提示一句做了什么。 */
export async function toggleScope(sessionId: string) {
  const enable = isScopeOff(sessionId);
  try {
    await setConversationScope(sessionId, enable);
    showToast(enable ? '已在这段对话里打开陪伴' : '已在这段对话里关掉陪伴：TA 不会在这里记事、带心情，也不会在这里主动找你');
  } catch (e) {
    // An older 总控 (before 0.4.0) has no scope route
    if (e instanceof MaidshError && e.missing)
      showToast(hasUpdate(PLUGIN_ID.core) ? '「MaiDSH 总控」要先更新：插件 › 已安装 › 更新，再重启引擎' : '「MaiDSH 总控」还没在引擎里运行：重启引擎后再试');
    else showToast(errText(e));
  }
}
