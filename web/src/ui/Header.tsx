import { conn, connError, current, drawerOpen, followState, nativeInfo, newChat, openOverlay, prefs, sessions, txVersion, getTranscript } from '../state/store';
import { Ic } from './common';
import { openFeature } from './pages/registry';

export function Header() {
  txVersion.value;
  const s = current.value;
  const t = getTranscript();
  const adv = prefs.value.advanced;
  const host = nativeInfo.value?.hosts.find((h) => h.current);
  const cwd = (t?.header.cwd as string | undefined) ?? s?.cwd;
  const ws = cwd ? cwd.split('/').filter(Boolean).pop() : undefined;
  const subs = s ? sessions.value.filter((x) => x.parentSessionId === s.sessionId).length : 0;
  const parent = s?.parentSessionId ? sessions.value.find((x) => x.sessionId === s.parentSessionId) : undefined;
  const offline = conn.value === 'retrying' || (s && followState.value === 'retrying');
  return (
    <header class="header" id="header">
      <button class="ib xl pri only-mobile" type="button" aria-label="打开边栏" onClick={() => (drawerOpen.value = true)}>
        <Ic n="IconMenuOutline20" />
      </button>
      <div class="h-title">
        {s && <div class="h-name">{t?.title ?? s.title ?? '新对话'}</div>}
        {offline ? (
          <span class="h-host warn" title={connError.value ?? ''}>
            <span class="dot-warn" aria-hidden="true" />
            正在重新连接…
          </span>
        ) : parent ? (
          <button class="h-host" type="button" onClick={() => import('../state/store').then((m) => m.openSession(parent.sessionId))}>
            <Ic n="BackSm" />
            返回「{(parent.title ?? '对话').slice(0, 14)}」
          </button>
        ) : (
          adv &&
          s && (
            <button class="h-host" type="button" aria-label="打开工作区" onClick={() => openFeature('workspaces')}>
              <span class="dot-ok" aria-hidden="true" />
              {host?.label ?? '本机'}
              {ws ? ` · ${ws}` : ''}
            </button>
          )
        )}
      </div>
      {adv && subs > 0 && (
        <button class="hpill" type="button" onClick={() => openFeature('subagents')}>
          子代理 {subs}
        </button>
      )}
      {adv && s && (
        <button class={`ib xl pri h-more ${subs > 0 ? '' : 'push'}`} type="button" aria-label="这个对话的功能" aria-haspopup="dialog" onClick={() => openOverlay({ kind: 'chat' })}>
          <Ic n="IconEllipsisOutline16" />
        </button>
      )}
      {s && (
        <button class="ib xl pri only-mobile" type="button" aria-label="开启新对话" onClick={newChat}>
          <Ic n="IconNewChatOutline20" />
        </button>
      )}
    </header>
  );
}
