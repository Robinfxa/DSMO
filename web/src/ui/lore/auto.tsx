// 设定集 · 聊天时自动整理（maidsh/LORE-DESIGN.md §14）: what the last turn recorded (with undo), the new
// people and entries waiting for 收下, and the switches (自动模式, 整理档位). Used by the chapter bar's
// sheet and the work page.

import { mutate, refreshWorks, type AutoRecord, type LastAuto, type Pending, type Work } from '../../lore/api';
import { confirm, errText, showToast } from '../../state/store';
import { Switch } from '../common';

async function act<T>(fn: () => Promise<T>, done: string | ((v: T) => string)) {
  try {
    const v = await fn();
    showToast(typeof done === 'string' ? done : done(v));
    void refreshWorks().catch(() => {});
    return v;
  } catch (e) {
    showToast(errText(e));
    return undefined;
  }
}

/** 「刚记下 2 条」 on the chapter bar: the last sorting-out in this conversation, within the hour, not undone. */
export function recentAuto(last: LastAuto | null | undefined, sessionId: string): LastAuto | null {
  if (!last || last.sessionId !== sessionId || last.undone || !last.recorded) return null;
  return Date.now() - last.at < 3_600_000 ? last : null;
}

/** What the last turn recorded, with 撤销这一轮. */
export function LastTurn({ workId, last, onChanged }: { workId: string; last: LastAuto; onChanged: () => void }) {
  return (
    <div class="lo-auto">
      <div class="lo-auto-h">
        <span>这一轮记下 {last.recorded} 条</span>
        <button
          class="plg-text-btn"
          type="button"
          onClick={() =>
            confirm('撤销这一轮？', '这一轮自动记下的状态、关系和收下的新人物、新设定都会删掉。', '撤销', () =>
              void act(() => mutate<{ removed: number }>('undo-auto', { work: workId, turnId: last.turnId }), (r) => `撤销了 ${r.removed} 条`).then(onChanged),
            )
          }
        >
          撤销这一轮
        </button>
      </div>
      <ul class="lo-auto-list">
        {(last.items ?? []).map((x) => (
          <li key={x.id}>{x.text}</li>
        ))}
      </ul>
    </div>
  );
}

const pendingName = (p: Pending) => (p.kind === 'character' ? `新人物：${p.data.name}` : `新设定：${p.data.title}`);
const pendingWhat = (p: Pending) => (p.kind === 'character' ? p.data.card?.summary : p.data.content) ?? '';

/** The new people and entries the chat brought up: 收下 / 不要, one by one or all. */
export function PendingList({ work, onChanged }: { work: Work; onChanged: () => void }) {
  const list = work.pending ?? [];
  if (!list.length) return null;
  const one = (p: Pending, accept: boolean) =>
    void act(() => mutate<{ accepted?: number; errors?: string[] }>(accept ? 'accept-pending' : 'dismiss-pending', { work: work.id, id: p.id }), (r) => (r.errors?.length ? r.errors.join('；') : accept ? `收下了：${p.data.name ?? p.data.title}` : '不要了')).then(onChanged);
  return (
    <div class="lo-auto">
      <div class="lo-auto-h">
        <span>待确认 {list.length} 条</span>
        <span class="lo-auto-acts">
          <button class="plg-text-btn" type="button" onClick={() => void act(() => mutate<{ accepted: number }>('accept-pending', { work: work.id, id: 'all' }), (r) => `收下了 ${r.accepted} 条`).then(onChanged)}>
            全部收下
          </button>
          <button class="plg-text-btn faint" type="button" onClick={() => void act(() => mutate('dismiss-pending', { work: work.id, id: 'all' }), '都不要了').then(onChanged)}>
            全部不要
          </button>
        </span>
      </div>
      {list.map((p) => (
        <div class="lo-pend" key={p.id}>
          <div class="lo-pend-m">
            <div class="lo-pend-t">{pendingName(p)}</div>
            {pendingWhat(p) && <div class="lo-pend-s">{pendingWhat(p)}</div>}
            {p.quote && <div class="lo-pend-q">原文：{p.quote}</div>}
          </div>
          <div class="lo-pend-b">
            <button class="plg-btn pri small" type="button" onClick={() => one(p, true)}>
              收下
            </button>
            <button class="plg-btn small" type="button" onClick={() => one(p, false)}>
              不要
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const MODES: [AutoRecord, string][] = [
  ['long', '写正文时'],
  ['every', '每一轮'],
  ['off', '关'],
];

/** 自动模式 and when to sort out. */
export function AutoSettings({ work, onChanged }: { work: Work; onChanged: () => void }) {
  const mode = work.settings.autoRecord ?? 'long';
  const auto = !!work.settings.autoAccept;
  const save = (patch: Record<string, unknown>, done: string) => void act(() => mutate('settings', { work: work.id, ...patch }), done).then(onChanged);
  return (
    <>
      <div class="plg-row static lo-sw">
        <div class="plg-row-m">
          <div class="plg-row-t">自动模式</div>
          <div class="plg-row-s">{auto ? '聊到的新人物、新设定直接收下' : '聊到的新人物、新设定先放进「待确认」，你点了才收下'}</div>
        </div>
        <Switch on={auto} label="自动模式" onChange={(v) => save({ autoAccept: v }, v ? '自动模式：新人物、新设定直接收下' : '新人物、新设定先放进待确认')} />
      </div>
      <div class="plg-row static lo-sw lo-auto-mode">
        <div class="plg-row-m">
          <div class="plg-row-t">聊天时自动整理设定</div>
          <div class="plg-row-s">{mode === 'off' ? '不整理，只有 AI 自己想起来才记' : mode === 'every' ? '每一轮都整理一次（多花一次调用）' : '只在 AI 写了一段正文（300 字以上）时整理'}</div>
        </div>
      </div>
      <div class="lo-chips lo-auto-seg" role="radiogroup" aria-label="聊天时自动整理设定">
        {MODES.map(([v, t]) => (
          <button type="button" role="radio" key={v} aria-checked={mode === v} onClick={() => mode !== v && save({ autoRecord: v }, v === 'off' ? '不自动整理了' : '已保存')}>
            {t}
          </button>
        ))}
      </div>
    </>
  );
}
