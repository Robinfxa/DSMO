// Phone layout, modelled on the DeepSeek mobile app: a top bar with the
// conversation title, a push-aside drawer, full-screen settings pages and
// long-press menus. Desktop keeps the chat-demo (web) layout.

import { canSpeak } from '../../bridge/native';
import { anyWorking, dsBot, totalUnread } from '../../bots/store';
import { EngineGate } from '../../setup/gate';
import { SafeBanner } from '../../setup/recovery';
import { forkConversation } from '../../state/store';
import { openImportedPage } from '../../history/ui';
import { imported } from '../../history/imported';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionSummary } from '../../engine/events';
import { layoutHidden, slotItems } from '../../plugins/frontend';
import {
  conn,
  confirm,
  credential,
  current,
  currentId,
  deleteSession,
  drawerOpen,
  followState,
  getTranscript,
  nativeInfo,
  newChat,
  openOverlay,
  openPopover,
  openSession,
  pages,
  pinned,
  popover,
  prefs,
  pushScreen,
  renameSession,
  renaming,
  setPref,
  showToast,
  togglePin,
  visibleSessions,
  txVersion,
} from '../../state/store';
import { Chat } from '../Chat';
import { Composer } from '../Composer';
import { PageHost } from '../pages';
import { openFeature } from '../pages/registry';
import { type MIconName } from './icons';
import { MIc } from './MIc';
import { Screens } from './Screens';

export { MIc } from './MIc';

export function MobileApp() {
  const open = drawerOpen.value;
  const welcome = !current.value;
  const touch = useRef<{ x: number; y: number; from: 'edge' | 'drawer' } | null>(null);
  const onTouchStart = (e: TouchEvent, from: 'edge' | 'drawer') => {
    const t = e.touches[0];
    if (from === 'edge' && (open || t.clientX > 28)) return;
    touch.current = { x: t.clientX, y: t.clientY, from };
  };
  const onTouchMove = (e: TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    if (Math.abs(t.clientY - s.y) > 40) return void (touch.current = null);
    if (s.from === 'edge' && dx > 50) (drawerOpen.value = true), (touch.current = null);
    if (s.from === 'drawer' && dx < -50) (drawerOpen.value = false), (touch.current = null);
  };
  return (
    <div class={`m-root ${open ? 'drawer' : ''}`} style={{ '--fs': String(prefs.value.fontFollowSystem ? 1 : prefs.value.fontScale) }}>
      <Drawer onTouchStart={(e) => onTouchStart(e, 'drawer')} onTouchMove={onTouchMove} />
      <div class="m-stage" onTouchStart={(e) => onTouchStart(e, 'edge')} onTouchMove={onTouchMove}>
        <TopBar />
        <SafeBanner />
        <div class={`m-content ${welcome ? 'welcome' : ''}`}>{welcome ? <Welcome /> : <Chat />}</div>
        <Composer />
        <button class="m-stage-scrim" type="button" aria-label="关闭边栏" tabIndex={open ? 0 : -1} onClick={() => (drawerOpen.value = false)} />
      </div>
      <EngineGate />
      <PageHost />
      <Screens />
      <Popover />
    </div>
  );
}

// ------------------------------------------------------------------ top bar

function TopBar() {
  txVersion.value;
  const s = current.value;
  const t = getTranscript();
  const adv = prefs.value.advanced;
  const offline = conn.value === 'retrying' || (s && followState.value === 'retrying');
  const read = prefs.value.autoRead;
  const host = nativeInfo.value?.hosts.find((h) => h.current);
  const cwd = (t?.header.cwd as string | undefined) ?? s?.cwd;
  return (
    <header class="m-top">
      <button class="m-ib" type="button" aria-label="打开边栏" onClick={() => (drawerOpen.value = true)}>
        <MIc n="menu" />
      </button>
      <div class="m-title">
        {s && <div class="m-title-t">{t?.title ?? s.title ?? '新对话'}</div>}
        {offline ? (
          <div class="m-title-s warn">正在重新连接…</div>
        ) : (
          adv && s && <div class="m-title-s">{`${host?.label ?? '本机'}${cwd ? ' · ' + cwd.split('/').filter(Boolean).pop() : ''}`}</div>
        )}
      </div>
      <button
        class="m-ib"
        type="button"
        aria-label={read ? '关闭自动朗读' : '打开自动朗读'}
        aria-pressed={read}
        // No speech synthesis (Android's WebView): keep the header's balance, hide the control.
        style={canSpeak() ? undefined : 'visibility:hidden'}
        disabled={!canSpeak()}
        onClick={() => {
          setPref('autoRead', !read);
          showToast(read ? '已关闭自动朗读' : '回复完成后会自动朗读');
        }}
      >
        <MIc n={read ? 'speaker' : 'speakerOff'} />
      </button>
      {adv && s && (
        <button class="m-ib h-more" type="button" aria-label="这个对话的功能" onClick={() => openOverlay({ kind: 'chat' })}>
          <MIc n="more" />
        </button>
      )}
      <button class="m-ib" type="button" aria-label="开启新对话" onClick={newChat}>
        <MIc n="chatPlus" />
      </button>
    </header>
  );
}

function Welcome() {
  return (
    <div class="m-welcome">
      <h1 class="m-greet">欢迎回来，随时开始吧</h1>
    </div>
  );
}

// ------------------------------------------------------------------ drawer

const DAY = 86400000;
function groupOf(ms: number) {
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime();
  if (ms >= t0) return '今天';
  if (ms >= t0 - DAY) return '昨天';
  if (ms >= t0 - 7 * DAY) return '7 天内';
  if (ms >= t0 - 30 * DAY) return '30 天内';
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

const FEATURES: [MIconName, string, string][] = [
  ['plug', '插件', 'plugins'],
  ['bolt', '技能', 'skills'],
  ['clock', '自动化任务', 'schedules'],
  ['pointer', '手机操控', 'phone'],
  ['grid', '全部功能', 'features'],
];

const featureRow = ([ico, label, id]: [MIconName, string, string]) => (
  <button class={`m-frow ${pages.value[0] === id ? 'on' : ''}`} type="button" key={id} onClick={() => openFeature(id, true)}>
    <MIc n={ico} />
    <span class="m-frow-t">{label}</span>
  </button>
);

/**
 * DS Bot's one row, in advanced mode only (it is a host plugin, like 插件 and 技能):
 * the team's own chats stay out of the list below (bots/store.ts).
 */
function DsBotRow() {
  const st = dsBot.value;
  if (!st.team) return null;
  const unread = totalUnread.value;
  return (
    <button class={`m-frow ${pages.value[0] === 'bots' ? 'on' : ''}`} type="button" onClick={() => openFeature('bots', true)}>
      <MIc n="bot" />
      <span class="m-frow-t">DS Bot</span>
      <span class="m-frow-e">{unread > 0 ? <span class="bt-badge">{unread > 99 ? '99+' : unread}</span> : anyWorking.value ? <span class="dot-busy" /> : null}</span>
    </button>
  );
}

function Drawer({ onTouchStart, onTouchMove }: { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void }) {
  const [picking, setPicking] = useState<Set<string> | null>(null);
  const list = visibleSessions.value;
  const pins = pinned.value;
  const pinnedList = pins.map((id) => list.find((s) => s.sessionId === id)).filter((s): s is SessionSummary => !!s);
  const rest = list.filter((s) => !pins.includes(s.sessionId));
  const groups: [string, SessionSummary[]][] = [];
  for (const s of rest) {
    const g = groupOf(s.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(s);
    else groups.push([g, [s]]);
  }
  const adv = prefs.value.advanced;
  const hidden = layoutHidden.value;
  const host = nativeInfo.value?.hosts.find((h) => h.current);
  const extra = slotItems('sider.features');
  const acc = credential.value;
  const nick = prefs.value.nickname.trim();
  const toggle = (id: string) => {
    const next = new Set(picking ?? []);
    next.has(id) ? next.delete(id) : next.add(id);
    setPicking(next);
  };
  const firstHeaderAction = (
    <button class="m-ib sm" type="button" aria-label="多选" onClick={() => setPicking(new Set())}>
      <MIc n="multi" />
    </button>
  );
  const row = (s: SessionSummary) => (
    <SessionRow
      key={s.sessionId}
      s={s}
      picking={picking}
      onPick={() => toggle(s.sessionId)}
      onMulti={() => setPicking(new Set([s.sessionId]))}
    />
  );
  const bulk = (action: 'pin' | 'delete') => {
    const ids = [...(picking ?? [])];
    if (!ids.length) return;
    if (action === 'pin')
      confirm(`将选择的 ${ids.length} 个对话置顶？`, '', '置顶', async () => {
        for (const id of ids) if (!pinned.value.includes(id)) await togglePin(id);
        setPicking(null);
      }, false);
    else
      confirm(`删除选择的 ${ids.length} 个对话？`, '删除后会从列表中移除。', '删除', async () => {
        for (const id of ids) await deleteSession(id);
        setPicking(null);
      });
  };

  return (
    <nav class={`m-drawer ${picking ? 'picking' : ''}`} aria-label="边栏" onTouchStart={onTouchStart} onTouchMove={onTouchMove}>
      {picking ? (
        <div class="m-pick-head">
          <div class="m-pick-t">{picking.size ? `已选择 ${picking.size} 个对话` : '选择对话'}</div>
          <button class="m-round" type="button" aria-label="退出多选" onClick={() => setPicking(null)}>
            <MIc n="x" />
          </button>
        </div>
      ) : (
        <button class="m-search" type="button" onClick={() => pushScreen('search')}>
          <MIc n="search" />
          <span>搜索对话内容…</span>
        </button>
      )}
      <div class="m-list">
        {adv && (
          <div class={`m-feat ${picking ? 'dim' : ''}`} inert={picking ? true : undefined}>
            {host && !hidden.has('sider.host') && (
              <button class="m-frow" type="button" onClick={() => ((drawerOpen.value = false), openOverlay({ kind: 'host' }))}>
                <MIc n="phone" />
                <span class="m-frow-t">{host.label}</span>
                <span class="m-frow-e">
                  <span class="dot-ok" />
                  {host.status}
                </span>
              </button>
            )}
            {/* DS Bot and plugins' rows sit with the tools; 全部功能, the catch-all, stays last. */}
            {FEATURES.filter(([, , id]) => id !== 'features' && !hidden.has(`sider.features.${id}`)).map(featureRow)}
            <DsBotRow />
            {extra.map((x) => (
              <button class="m-frow" type="button" key={x.key} onClick={() => ((drawerOpen.value = false), x.run())}>
                <MIc n="sparkle" />
                <span class="m-frow-t">{x.title}</span>
              </button>
            ))}
            {FEATURES.filter(([, , id]) => id === 'features' && !hidden.has(`sider.features.${id}`)).map(featureRow)}
          </div>
        )}
        {pinnedList.length > 0 && (
          <section class="m-sec">
            <div class="m-sec-h">
              <span>置顶</span>
              {!picking && firstHeaderAction}
            </div>
            {pinnedList.map(row)}
            <hr class="m-sep" />
          </section>
        )}
        {groups.map(([g, items], i) => (
          <section class="m-sec" key={g}>
            <div class="m-sec-h">
              <span>{g}</span>
              {i === 0 && !pinnedList.length && !picking && firstHeaderAction}
            </div>
            {items.map(row)}
          </section>
        ))}
        {!list.length && <div class="m-empty">还没有对话</div>}
        {!picking && imported.value.length > 0 && (
          <button class="m-imported" type="button" onClick={() => openImportedPage()}>
            <span>这台设备上的对话</span>
            <span class="m-imported-n">{imported.value.length}</span>
            <MIc n="chevron" />
          </button>
        )}
      </div>
      {picking ? (
        <div class="m-pick-bar">
          <button type="button" disabled={!picking.size} onClick={() => bulk('pin')}>
            <MIc n="pin" />
            置顶
          </button>
          <span class="m-pick-div" />
          <button type="button" class="danger" disabled={!picking.size} onClick={() => bulk('delete')}>
            <MIc n="trash" />
            删除
          </button>
        </div>
      ) : (
        <div class="m-me">
          <button class="m-me-main" type="button" onClick={() => pushScreen(acc?.configured ? 'settings' : 'account')}>
            <span class="m-avatar">{nick ? nick.slice(0, 1).toUpperCase() : <MIc n="person" />}</span>
            <span class="m-me-name">{nick || (acc?.configured ? '已登录' : '登录')}</span>
          </button>
          <button class="m-ib" type="button" aria-label="设置" onClick={() => pushScreen('settings')}>
            <MIc n="more" />
          </button>
        </div>
      )}
    </nav>
  );
}

function SessionRow({ s, picking, onPick, onMulti }: { s: SessionSummary; picking: Set<string> | null; onPick: () => void; onMulti: () => void }) {
  const active = s.sessionId === currentId.value && !pages.value.length;
  const isPinned = pinned.value.includes(s.sessionId);
  const ref = useRef<HTMLDivElement>(null);
  const press = useLongPress(() => menu());
  if (renaming.value === s.sessionId) return <RenameRow s={s} />;
  const menu = () =>
    openPopover(ref.current!.querySelector('.m-item-more') ?? ref.current!, [
      { icon: 'edit', label: '重命名', run: () => (renaming.value = s.sessionId) },
      { icon: isPinned ? 'unpin' : 'pin', label: isPinned ? '取消置顶' : '置顶', run: () => void togglePin(s.sessionId) },
      { icon: 'fork', label: '分叉', run: () => ((drawerOpen.value = false), void forkConversation(s.sessionId)) },
      { icon: 'multi', label: '多选', run: onMulti },
      {
        icon: 'trash',
        label: '删除',
        danger: true,
        run: () => confirm('删除对话？', `「${s.title || '新对话'}」会从列表中移除。`, '删除', () => void deleteSession(s.sessionId)),
      },
    ]);
  const on = !!picking?.has(s.sessionId);
  return (
    <div
      class={`m-item ${active && !picking ? 'on' : ''} ${picking ? 'picking' : ''}`}
      ref={ref}
      {...(picking ? {} : press)}
      role={picking ? 'checkbox' : undefined}
      aria-checked={picking ? on : undefined}
      onClick={picking ? onPick : undefined}
    >
      <span class="m-pick-slot" aria-hidden="true">
        <span class={`m-radio ${on ? 'on' : ''}`}>{on && <MIc n="check" />}</span>
      </span>
      <button class="m-item-t" type="button" tabIndex={picking ? -1 : 0} onClick={() => !picking && !press.fired() && openSession(s.sessionId)}>
        {s.running && <span class="dot-run" />}
        {s.title || '新对话'}
      </button>
      {active && !picking && (
        <button class="m-item-more m-ib sm" type="button" aria-label="更多" onClick={menu}>
          <MIc n="more" />
        </button>
      )}
    </div>
  );
}

function RenameRow({ s }: { s: SessionSummary }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      class="m-rename"
      aria-label="重命名对话"
      maxLength={40}
      value={s.title ?? ''}
      onBlur={(e) => renameSession(s.sessionId, (e.target as HTMLInputElement).value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

// ------------------------------------------------------------------ long press & popover

/** Long-press (and right-click) handlers; `fired()` tells a click to ignore itself after a long press. */
export function useLongPress(onLong: (e: { x: number; y: number }) => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onTouchStart: (e: TouchEvent) => {
      fired.current = false;
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        onLong(start.current);
      }, ms);
    },
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - start.current.x) > 8 || Math.abs(t.clientY - start.current.y) > 8) clear();
    },
    onTouchEnd: (e: TouchEvent) => {
      clear();
      if (fired.current) e.preventDefault();
    },
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      fired.current = true;
      onLong({ x: e.clientX, y: e.clientY });
      setTimeout(() => (fired.current = false), 300);
    },
    fired: () => {
      const f = fired.current;
      fired.current = false;
      return f;
    },
  };
}

function Popover() {
  const p = popover.value;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!p || !ref.current) return setPos(null);
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    const left = Math.max(12, Math.min(p.x - w, innerWidth - w - 12));
    const top = p.y + 8 + h > innerHeight - 12 ? Math.max(12, p.y - h - 40) : p.y + 8;
    setPos({ left, top });
  }, [p]);
  if (!p) return null;
  return (
    <div class="m-pop-layer" onClick={() => (popover.value = null)}>
      <div class={`m-pop ${pos ? 'in' : ''}`} ref={ref} role="menu" style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden' }}>
        {p.items.map((it) => (
          <button
            class={`m-pop-row ${it.danger ? 'danger' : ''}`}
            type="button"
            role="menuitem"
            key={it.label}
            onClick={(e) => {
              e.stopPropagation();
              popover.value = null;
              it.run();
            }}
          >
            <MIc n={it.icon as MIconName} />
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MCard({ children }: { children: ComponentChildren }) {
  return <div class="m-card">{children}</div>;
}
