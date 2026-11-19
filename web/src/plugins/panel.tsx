// Sandboxed web panels (decision Q3). A panel is plugin HTML in an iframe with
// `sandbox="allow-scripts"` (no same-origin: no cookies, no storage, no access
// to this page) and a CSP that blocks the network unless the plugin declared
// `network`. It talks to the app only through `apiDemo.*` over postMessage,
// and every call is checked against the plugin's declared permissions.
// Panels render inside an app sheet, below the approval layer.

import { useEffect, useRef, useState } from 'preact/hooks';
import { closeOverlay, currentId, draft, getClient, prefs, send, showToast } from '../state/store';
import { findPlugin, pluginDataGet, pluginDataSet } from './frontend';

/** Engine endpoints a panel with `engine.read` may call: reads only, no keys, no approvals, no permissions. */
export const PANEL_READ_ENDPOINTS = new Set([
  'session/list',
  'session/search',
  'session/projections',
  'session/modelCatalog',
  'skills/list',
  'workspaceFiles/list',
  'workspaceFiles/read',
  'goals/get',
]);

const SDK = `
(() => {
  let seq = 0; const pending = new Map();
  addEventListener('message', (e) => {
    const m = e.data; if (!m || m.__apiDemo !== 1) return;
    if (m.theme) for (const [k, v] of Object.entries(m.theme)) document.documentElement.style.setProperty(k, v);
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    m.ok ? p.resolve(m.value) : p.reject(new Error(m.error || 'failed'));
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    parent.postMessage({ __apiDemo: 1, id, method, params }, '*');
  });
  window.apiDemo = {
    ready: () => call('ready'),
    context: () => call('context'),
    insert: (text) => call('insert', { text }),
    prompt: (text) => call('prompt', { text }),
    toast: (text) => call('toast', { text }),
    close: () => call('close'),
    resize: (height) => call('resize', { height }),
    storage: { get: (key) => call('storage.get', { key }), set: (key, value) => call('storage.set', { key, value }) },
    engine: { call: (endpoint, args) => call('engine.call', { endpoint, args }) },
  };
})();
`;

function themeVars() {
  const cs = getComputedStyle(document.body);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    '--fg': v('--dsw-alias-label-primary'),
    '--muted': v('--dsw-alias-label-tertiary'),
    '--brand': v('--dsw-alias-brand-primary'),
    '--hover': v('--dsw-alias-interactive-bg-hover'),
    '--border': v('--dsw-alias-border-l2'),
    '--input': v('--dsw-specific-input-major'),
  };
}

export function buildSrcdoc(html: string, permissions: string[], scheme: 'light' | 'dark' = 'light') {
  const csp = permissions.includes('network')
    ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src https:; font-src data:"
    : "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${scheme}"><style>html,body{background:transparent}</style><script>${SDK}</script></head><body>${html}</body></html>`;
}

/** `preview`: shown on the detail page before install — reads work, anything that acts on the app is held back. */
export function PanelFrame({ pluginId, panel, preview = false, maxHeight = 640 }: { pluginId: string; panel: string; preview?: boolean; maxHeight?: number }) {
  const p = findPlugin(pluginId);
  const def = p?.panels?.[panel];
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(Math.min(360, maxHeight));

  useEffect(() => {
    if (!p || !def) return;
    const perms = new Set(p.permissions);
    const onMsg = async (e: MessageEvent) => {
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { __apiDemo?: number; id: number; method: string; params?: Record<string, unknown> };
      if (!m || m.__apiDemo !== 1) return;
      const reply = (ok: boolean, value?: unknown, error?: string) => frame.contentWindow?.postMessage({ __apiDemo: 1, id: m.id, ok, value, error }, '*');
      const held = () => (showToast('预览中，安装后才能用'), reply(true));
      const need = (perm: string) => {
        if (!perms.has(perm)) throw new Error(`插件没有声明 ${perm} 权限`);
      };
      try {
        const q = m.params ?? {};
        switch (m.method) {
          case 'ready':
          case 'context':
            frame.contentWindow?.postMessage({ __apiDemo: 1, theme: themeVars() }, '*');
            return reply(true, { theme: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light', lang: prefs.value.lang, sessionId: currentId.value });
          case 'insert':
            if (preview) return held();
            draft.value = (draft.value ? draft.value + '\n' : '') + String(q.text ?? '').slice(0, 2000);
            return reply(true);
          case 'prompt':
            need('session.prompt');
            if (preview) return held();
            await send(String(q.text ?? '').slice(0, 8000));
            return reply(true);
          case 'toast':
            showToast(String(q.text ?? '').slice(0, 40));
            return reply(true);
          case 'close':
            if (preview) return reply(true);
            closeOverlay();
            return reply(true);
          case 'resize':
            setHeight(Math.max(160, Math.min(Number(q.height) || 360, maxHeight)));
            return reply(true);
          case 'storage.get':
            need('storage');
            return reply(true, await pluginDataGet(pluginId, String(q.key)));
          case 'storage.set': {
            need('storage');
            const v = q.value === null || q.value === undefined ? null : String(q.value);
            if (v && v.length > 64 * 1024) throw new Error('单项不能超过 64 KiB');
            if (preview) return held();
            await pluginDataSet(pluginId, String(q.key), v);
            return reply(true);
          }
          case 'engine.call': {
            need('engine.read');
            const endpoint = String(q.endpoint);
            if (!PANEL_READ_ENDPOINTS.has(endpoint)) throw new Error(`插件不能调用 ${endpoint}`);
            return reply(true, await getClient().call(endpoint, (q.args as Record<string, unknown>) ?? {}));
          }
          default:
            throw new Error(`未知方法 ${m.method}`);
        }
      } catch (err) {
        reply(false, undefined, (err as Error).message);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [pluginId, panel]);

  if (!p || !def) return <div class="p-body">这个面板已经不在了。</div>;
  return (
    <iframe
      ref={ref}
      class="plugin-frame"
      title={def.title}
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      style={{ height: `${height}px` }}
      srcdoc={buildSrcdoc(def.html, p.permissions, document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')}
    />
  );
}
