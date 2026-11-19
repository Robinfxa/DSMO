import { useEffect } from 'preact/hooks';
import { native, onNative } from '../bridge/native';
import { layoutHidden } from '../plugins/frontend';
import { conn, current, currentId, draft, drawerOpen, handleBack, isMobile, newChat, openSession, pages, prefs, protoEngine, refreshFollow, setPref, showToast, toast } from '../state/store';
import { MobileApp } from './mobile/MobileApp';
import { Chat } from './Chat';
import { Composer } from './Composer';
import { Ic } from './common';
import { Header } from './Header';
import { Overlays } from './Overlays';
import { PageHost } from './pages';
import { installHostKeyPrompt } from './pages/host/local';
import { engine, gate, startEngineWatch } from '../setup/state';
import { afterSetup, EngineGate } from '../setup/gate';
import { watchAccount } from '../account/account';
import { checkUpdateOnLaunch } from '../setup/update';
import { installShareIncoming } from '../share/open';
import { Sider, closeMenu } from './Sider';

export function App() {
  const p = prefs.value;
  const welcome = !current.value;

  useEffect(() => void document.body.classList.toggle('is-m', isMobile.value), [isMobile.value]);
  useEffect(() => installHostKeyPrompt(), []);
  // The on-device engine and first run (setup/): polled while something moves.
  useEffect(() => startEngineWatch(), []);
  const loopback = engine.value?.loopback;
  useEffect(() => {
    if (loopback) watchAccount();
  }, [loopback]);
  const g = gate.value;
  useEffect(() => {
    if (!g) {
      afterSetup();
      void checkUpdateOnLaunch();
    }
  }, [g]);
  useEffect(() => {
    const off = installShareIncoming();
    return () => void off();
  }, []);
  // Theme (chat-demo convention: data-ds-dark-theme on <body>).
  useEffect(() => {
    const q = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.body.toggleAttribute('data-ds-dark-theme', p.theme === 'dark' || (p.theme === 'system' && q.matches));
    apply();
    q.addEventListener('change', apply);
    return () => q.removeEventListener('change', apply);
  }, [p.theme]);

  // Android back button (from the app) and Escape.
  useEffect(() => {
    const offBack = onNative('back', () => {
      const handled = handleBack();
      window.__apiDemo && (window as any).ApiDemoNative?.postMessage(JSON.stringify({ id: 'back', method: 'backResult', params: { handled } }));
    });
    const offResume = onNative('resumed', () => {
      refreshFollow();
      void import('../bots/store').then((m) => m.kickDsBot());
    });
    // Hot update: a newer page was downloaded (it is used from the next launch either way).
    const offWeb = onNative('webUpdate.ready', () => {
      showToast('界面有更新', '刷新', () => void native.applyWebUpdate().catch(() => showToast('没能刷新，下次打开时会用新的')));
    });
    // A tapped DS Bot notification (dsh-Go's BotAlertsHost, forwarded by api_demo_home.dart).
    const offBot = onNative('bots.open', (p) => {
      const d = (p ?? {}) as { kind?: string; id?: string };
      if (!d.id) return;
      pages.value = ['bots', d.kind === 'room' ? `room:${d.id}` : `bot:${d.id}`];
    });
    // A notification tap or launcher shortcut picked a conversation.
    const offOpen = onNative('openSession', (p: any) => typeof p?.sessionId === 'string' && p.sessionId !== currentId.value && openSession(p.sessionId));
    // Share sheet / 新对话 from the launcher: text into a (new) conversation's composer.
    const offCompose = onNative('compose', (p: any) => {
      if (p?.newSession) openSession(null);
      else if (typeof p?.sessionId === 'string') openSession(p.sessionId);
      if (typeof p?.text === 'string' && p.text) draft.value = p.text;
      setTimeout(() => document.getElementById('input')?.focus(), 100);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu, .item-more')) closeMenu();
    };
    addEventListener('keydown', onKey);
    addEventListener('mousedown', onDown);
    return () => {
      offBack();
      offResume();
      offBot();
      offWeb();
      offOpen();
      offCompose();
      removeEventListener('keydown', onKey);
      removeEventListener('mousedown', onDown);
    };
  }, []);

  if (isMobile.value)
    return (
      <>
        <MobileApp />
        <div id="layers">
          <Overlays />
        </div>
        {toast.value && (
          <div class="toast m-toast" role="status" key={toast.value.id}>
            {toast.value.text}
            {toast.value.action && (
              <button
                class="toast-act"
                type="button"
                onClick={() => {
                  const t = toast.value!;
                  toast.value = null;
                  t.onAction?.();
                }}
              >
                {toast.value.action}
              </button>
            )}
          </div>
        )}
        {layoutHidden.value.has('caveat') && null}
      </>
    );

  return (
    <>
      <div class={`frame ${p.collapsed ? 'collapsed' : ''} ${drawerOpen.value ? 'drawer-open' : ''}`} id="frame">
        <button class="mask" type="button" aria-label="关闭边栏" tabIndex={-1} onClick={() => (drawerOpen.value = false)} />
        <Sider />
        <main class={`main ${welcome ? 'is-welcome' : ''}`} id="main">
          <div class="collapsed-group" id="collapsedGroup">
            <button class="ib m pri" type="button" aria-label="展开边栏" onClick={() => setPref('collapsed', false)}>
              <Ic n="IconPanelLeftOutline16" />
            </button>
            <button class="ib m pri" type="button" aria-label="开启新对话" onClick={newChat}>
              <Ic n="NewChatIcon" />
            </button>
          </div>
          <Header />
          <div class="content" id="content">
            {welcome ? <h1 class="greeting">今天有什么可以帮到你？</h1> : <Chat />}
          </div>
          <Composer />
          <EngineGate />
          <PageHost />
        </main>
      </div>
      <div id="layers">
        <Overlays />
      </div>
      {toast.value && (
        <div class={`toast ${toast.value.action ? 'has-act' : ''}`} role="status" key={toast.value.id}>
          {toast.value.text}
          {toast.value.action && (
            <button
              class="toast-act"
              type="button"
              onClick={() => {
                const t = toast.value!;
                toast.value = null;
                t.onAction?.();
              }}
            >
              {toast.value.action}
            </button>
          )}
        </div>
      )}
      {__PROTOTYPE__ && <ProtoBar />}
      {layoutHidden.value.has('caveat') && <style>{'.caveat{visibility:hidden}'}</style>}
    </>
  );
}

/** Prototype-only controls (desktop): simulate a dropped connection. */
function ProtoBar() {
  return (
    <div class="proto-bar" aria-hidden="true">
      <span style="font-size:12px;color:var(--dsw-alias-label-tertiary);align-self:center">原型 {__BUILD__} UTC · 模拟引擎 · {conn.value === 'connected' ? '已连接' : conn.value}</span>
      <button type="button" onClick={() => protoEngine()?.blip()}>
        模拟断线
      </button>
    </div>
  );
}
