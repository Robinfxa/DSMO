import { useEffect, useRef, useState } from 'preact/hooks';
import { conn, errText, forkConversation, sessionsLive, showToast } from '../state/store';
import { hasModule } from '../maidsh/api';
import { learnConversation } from './pages/companion';
import { isScopeOff, toggleScope } from '../maidsh/scope';
import { M } from './mobile/icons';
import { openImportedPage } from '../history/ui';
import { imported } from '../history/imported';
import type { SessionSummary } from '../engine/events';
import { slotItems, layoutHidden } from '../plugins/frontend';
import {
  credential,
  currentId,
  deleteSession,
  drawerOpen,
  nativeInfo,
  newChat,
  openOverlay,
  openSession,
  pages,
  prefs,
  renameSession,
  renaming,
  setPref,
  confirm,
  visibleSessions,
} from '../state/store';
import { Ic } from './common';
import { I, type IconName } from './icons';
import { openFeature } from './pages/registry';

const FEATURES: [IconName, string, string][] = [
  ['FxPlugin', '插件', 'plugins'],
  ['FxSkill', '技能', 'skills'],
  ['FxClock', '自动化任务', 'schedules'],
  ['FxPointer', '手机操控', 'phone'],
  ['FxGrid', '全部功能', 'features'],
];

function groupOf(ms: number) {
  const day = 86400000;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  if (ms >= t0) return '今天';
  if (ms >= t0 - day) return '昨天';
  if (ms >= t0 - 7 * day) return '7 天内';
  if (ms >= t0 - 30 * day) return '30 天内';
  return '更早';
}

export function Sider() {
  const adv = prefs.value.advanced;
  const list = visibleSessions.value;
  const groups: [string, SessionSummary[]][] = [];
  for (const s of list) {
    const g = groupOf(s.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(s);
    else groups.push([g, [s]]);
  }
  const host = nativeInfo.value?.hosts.find((h) => h.current);
  const [enter, setEnter] = useState(false);
  const prevAdv = useRef(adv);
  useEffect(() => {
    if (adv && !prevAdv.current) {
      setEnter(true);
      setTimeout(() => setEnter(false), 400);
    }
    prevAdv.current = adv;
  }, [adv]);
  const hidden = layoutHidden.value;
  const extra = slotItems('sider.features');
  const account = credential.value;

  return (
    <nav class="sider" id="sider" aria-label="边栏">
      <div class="s-top">
        <div class="app-name">DSMO</div>
        <button
          class="ib m"
          type="button"
          aria-label="收起边栏"
          onClick={() => (window.matchMedia('(min-width: 768px)').matches ? setPref('collapsed', true) : (drawerOpen.value = false))}
        >
          <Ic n="IconPanelLeftOutline16" />
        </button>
      </div>
      <button class="new-chat" type="button" onClick={newChat}>
        <span class="nc-ico">
          <Ic n="NewChatIcon" />
        </span>
        开启新对话
      </button>
      <div class="s-list">
        {adv && (
          <div class={`feat ${enter ? 'enter' : ''}`}>
            {host && !hidden.has('sider.host') && (
              <button class="row" type="button" aria-haspopup="dialog" onClick={() => ((drawerOpen.value = false), openOverlay({ kind: 'host' }))}>
                <span class="row-ico">
                  <Ic n="FxPhone" />
                </span>
                <span class="row-label">{host.label}</span>
                <span class="row-right">
                  <span class="dot-ok" aria-hidden="true" />
                  {host.status}
                  <Ic n="IconChevronDownOutline14" />
                </span>
              </button>
            )}
            {FEATURES.filter(([, , id]) => !hidden.has(`sider.features.${id}`)).map(([ico, label, id]) => (
              <button class={`row ${pages.value[0] === id ? 'active' : ''}`} type="button" key={id} onClick={() => openFeature(id, true)}>
                <span class="row-ico">
                  <Ic n={ico} />
                </span>
                <span class="row-label">{label}</span>
                {id === 'features' && (
                  <span class="row-right">
                    <Ic n="IconChevronRightOutline14" />
                  </span>
                )}
              </button>
            ))}
            {extra.map((x) => (
              <button class="row" type="button" key={x.key} onClick={x.run}>
                <span class="row-ico">
                  <Ic n={x.icon} />
                </span>
                <span class="row-label">{x.title}</span>
              </button>
            ))}
          </div>
        )}
        {groups.map(([g, items]) => (
          <div class="section" key={g}>
            <div class="section-h">{g}</div>
            {items.map((s) =>
              renaming.value === s.sessionId ? <RenameInput s={s} key={s.sessionId} /> : <Item s={s} key={s.sessionId} />,
            )}
          </div>
        ))}
        {!sessionsLive.value && conn.value !== 'connected' && <div class="empty">{list.length ? '正在连接引擎，显示的是上次的列表…' : '引擎正在启动，对话马上就来…'}</div>}
        {!list.length && (sessionsLive.value || conn.value === 'connected') && <div class="empty">还没有对话</div>}
        {imported.value.length > 0 && (
          <div class="section">
            <button class="row" type="button" onClick={() => ((drawerOpen.value = false), openImportedPage())}>
              <span class="row-label">这台设备上的对话</span>
              <span class="row-right">
                {imported.value.length}
                <Ic n="IconChevronRightOutline14" />
              </span>
            </button>
          </div>
        )}
      </div>
      <div class="s-bottom">
        <button
          class={`account ${account?.configured ? 'in' : ''}`}
          type="button"
          onClick={() => {
            drawerOpen.value = false;
            openOverlay(account?.configured ? { kind: 'settings', tab: 'general' } : { kind: 'login' });
          }}
        >
          <span class="avatar">
            <Ic n="Person" />
          </span>
          <span class="account-label">{account?.configured ? (account.source === 'env' ? '已连接 · 环境变量' : '已连接 · API Key') : '登录'}</span>
        </button>
        <button class="ib m pri" type="button" aria-label="设置" onClick={() => ((drawerOpen.value = false), openOverlay({ kind: 'settings' }))}>
          <Ic n="IconSettingsOutline16" />
        </button>
      </div>
    </nav>
  );
}

function Item({ s }: { s: SessionSummary }) {
  const active = s.sessionId === currentId.value && !pages.value.length;
  return (
    <div class={`item ${active ? 'active' : ''} static`}>
      <button class="item-title" type="button" onClick={() => openSession(s.sessionId)}>
        {s.running && <span class="dot-run" aria-label="生成中" />}
        {s.title || '新对话'}
      </button>
      <button
        class="ib xs item-more"
        type="button"
        aria-label="更多"
        aria-haspopup="menu"
        onClick={(e) => openMenu(e.currentTarget as HTMLElement, s)}
      >
        <Ic n="IconEllipsisOutline16" />
      </button>
    </div>
  );
}

function RenameInput({ s }: { s: SessionSummary }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const done = () => renameSession(s.sessionId, ref.current?.value ?? '');
  return (
    <input
      ref={ref}
      class="rename"
      aria-label="重命名对话"
      maxLength={40}
      value={s.title ?? ''}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') renaming.value = null;
      }}
    />
  );
}

// ---------- context menu (rename / delete) ----------

let menuEl: HTMLDivElement | null = null;
export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
function openMenu(btn: HTMLElement, s: SessionSummary) {
  closeMenu();
  const r = btn.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  const opt = (icon: IconName | { svg: string }, text: string, danger: boolean, fn: () => void) => {
    const b = document.createElement('button');
    b.className = `menu-opt ${danger ? 'danger' : ''}`;
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `<i class="ic" aria-hidden="true">${typeof icon === 'string' ? I[icon] : icon.svg.replace(/width="24" height="24"/, 'width="16" height="16"')}</i>`;
    b.append(text);
    b.onclick = () => {
      closeMenu();
      fn();
    };
    el.append(b);
  };
  opt('IconEditOutline16', '重命名', false, () => (renaming.value = s.sessionId));
  opt({ svg: M.fork }, '分叉到新对话', false, () => void forkConversation(s.sessionId));
  if (hasModule('core')) opt({ svg: M.sparkle }, '让 TA 深度学习这段对话', false, () => void learnConversation(s.sessionId, s.title).catch((e) => showToast(errText(e))));
  if (hasModule('core')) opt({ svg: M.sparkle }, isScopeOff(s.sessionId) ? '在这段对话里打开陪伴' : '在这段对话里关掉陪伴', false, () => void toggleScope(s.sessionId));
  opt('IconTrashOutline16', '删除', true, () =>
    confirm('删除对话？', `「${s.title || '新对话'}」会被移出列表，可以在提示里撤销。`, '删除', () => deleteSession(s.sessionId)),
  );
  document.getElementById('layers')!.append(el);
  menuEl = el;
  const h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = (r.bottom + 4 + h > innerHeight ? r.top - h - 4 : r.bottom + 4) + 'px';
  (el.querySelector('button') as HTMLButtonElement | null)?.focus();
}
