// MaiDSH 在哪些对话里生效（maidsh/CONTRACT.md §12）：默认所有对话，排除你在「更多」菜单里关掉的，
// 和 DS Bot 的对话。Bot 对话只有这边知道，所以装了总控时把整份列表同步给引擎（Bot 变化时再同步）。

import { effect, signal } from '@preact/signals';
import { botSessions } from '../plugins/conflicts';
import { errText, showToast } from '../state/store';
import { get, hasModule, post } from './api';

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

let lastBots = '';
/** 启动时：装了总控就读一次范围，并把 Bot 对话同步过去；Bot 变了再同步。 */
export function watchMaidshScope() {
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
    showToast(errText(e));
  }
}
