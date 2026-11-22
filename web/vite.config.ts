import { defineConfig, type ProxyOptions } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build`                  → dist/        the bundle shipped inside the APK (talks to the engine)
// `vite build --mode prototype` → dist-proto/  one self-contained page running the mock engine
// `vite` (dev)                  → the real engine when DSH_URL + DSH_TOKEN are set, else the mock:
//     DSH_URL=http://127.0.0.1:3080 DSH_TOKEN=<launch token> npm run dev
//   The dev server plays the app's local proxy: it logs in with the token,
//   keeps the engine cookie, and strips Origin/Referer so DSH's browser fence
//   sees a same-origin client (see native/overlay/app/lib/api_demo/proxy.dart).
export default defineConfig(({ mode, command }) => {
  const engine = process.env.DSH_URL;
  const token = process.env.DSH_TOKEN;
  const real = command === 'serve' && !!engine && !!token;
  const prototype = mode === 'prototype' || (command === 'serve' && !real);
  return {
    base: './',
    plugins: [preact(), ...(mode === 'prototype' ? [viteSingleFile()] : [])],
    define: { __PROTOTYPE__: JSON.stringify(prototype), __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
    css: { postcss: { plugins: [insetFallback()] } },
    build: {
      outDir: mode === 'prototype' ? 'dist-proto' : 'dist',
      target: 'es2020',
      // the oldest WebView seen so far (vivo NEX 3S, Android 10): keeps esbuild from folding
      // insetFallback's top / right / bottom / left back into `inset` when it minifies
      cssTarget: 'chrome83',
      assetsInlineLimit: mode === 'prototype' ? 100_000_000 : 4096,
    },
    server: {
      fs: { allow: ['..'] },
      proxy: real ? engineProxy(engine!, token!) : undefined,
    },
    test: { environment: 'jsdom', include: ['test/**/*.test.ts'] },
  };
});

/**
 * `inset` is Chrome 87+. Older Android WebViews (vivo NEX 3S: Chrome 83) drop it, so `.m-root
 * { position: fixed; inset: 0 }` had no size and the whole page was a blank background. Every
 * `inset` becomes top / right / bottom / left, which mean the same everywhere (esbuild's own
 * lowering skips most forms, and drops longhands written before an `inset`).
 */
function insetFallback() {
  /** Splits a value on top-level spaces (not inside calc() and the like). */
  const parts = (v: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of v.trim()) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (/\s/.test(ch) && depth === 0) {
        if (cur) out.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  return {
    postcssPlugin: 'dsmo-inset-fallback',
    Declaration: {
      inset(decl: { value: string; important: boolean; cloneBefore: (o: { prop: string; value: string; important: boolean }) => unknown; remove: () => void }) {
        const p = parts(decl.value);
        if (p.length < 1 || p.length > 4) return;
        const [t, r = t, b = t, l = r] = p;
        for (const [prop, value] of [['top', t], ['right', r], ['bottom', b], ['left', l]]) decl.cloneBefore({ prop, value, important: decl.important });
        decl.remove();
      },
    },
  };
}

function engineProxy(engine: string, token: string): Record<string, ProxyOptions> {
  let cookie = '';
  const login = async () => {
    const res = await fetch(`${engine}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const set = res.headers.getSetCookie?.() ?? [];
    cookie = set.map((c) => c.split(';')[0]).join('; ');
    if (!cookie) console.warn('[api-demo] engine login returned no cookie: check DSH_TOKEN');
  };
  const ready = login();
  const opts: ProxyOptions = {
    target: engine,
    changeOrigin: true,
    ws: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (req) => {
        req.removeHeader('origin');
        req.removeHeader('referer');
        for (const h of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) req.removeHeader(h);
        if (cookie) req.setHeader('cookie', cookie);
      });
      proxy.on('proxyReqWs', (req) => {
        req.removeHeader('origin');
        if (cookie) req.setHeader('cookie', cookie);
      });
      proxy.on('proxyRes', (res) => {
        delete res.headers['set-cookie'];
        if (res.statusCode === 401) void login();
      });
    },
  };
  void ready;
  return { '/api': opts, '/dsh-go': opts };
}
