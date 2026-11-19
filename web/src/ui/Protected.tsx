// Hard rules (decision Q3): approval cards, the permission page and the
// login / API-key inputs can never be restyled, hidden or replaced by plugins.
//
// 1. They render inside a closed shadow root with their own stylesheet and a
//    fixed palette (no inherited design tokens), so skin tokens and plugin CSS
//    cannot reach inside.
// 2. The host element carries inline `!important` display/visibility/opacity,
//    which outranks any stylesheet rule.
// 3. guard.ts checks on a timer that every protected host is actually visible
//    and on top; if a plugin stylesheet hides or covers one, plugin CSS is
//    switched off and the user is told why.

import type { ComponentChildren } from 'preact';
import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { prefs } from '../state/store';

const CSS = `
:host { all: initial; display: block !important; }
* { box-sizing: border-box; }
.wrap { font: 14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; color: #0f1115; -webkit-font-smoothing: antialiased; }
.wrap.dark { color: #f2f3f5; }
.card { margin: 10px 0 4px; padding: 14px 16px; border-radius: 16px; background: #fff7ed; border: 1px solid #fed7aa; }
.dark .card { background: #2a1d10; border-color: #7c4a1a; }
.title { font-weight: 600; font-size: 15px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.title svg { flex: none; }
.cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 20px; padding: 8px 10px; border-radius: 10px; background: rgba(0,0,0,.05); white-space: pre-wrap; word-break: break-all; margin: 8px 0; max-height: 160px; overflow: auto; }
.dark .cmd { background: rgba(255,255,255,.08); }
.reason { color: #6b4a2b; font-size: 13px; }
.dark .reason { color: #e8c9a8; }
.meta { color: #8a8f98; font-size: 12px; margin-top: 4px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; flex-wrap: wrap; }
button { font: inherit; cursor: pointer; border: 0; }
.btn { height: 34px; padding: 0 16px; border-radius: 17px; background: #fff; color: #0f1115; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.btn:hover { background: #f4f4f5; }
.dark .btn { background: #26282d; color: #f2f3f5; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); }
.btn.primary { background: #4d6bfe; color: #fff; box-shadow: none; }
.btn.primary:hover { background: #3d5bf0; }
.btn[disabled] { opacity: .55; cursor: default; }
.link { background: none; color: #4d6bfe; padding: 0; font-size: 12px; }
.field { display: block; margin: 0 0 14px; }
.field label { display: block; font-size: 13px; color: #5c6066; margin-bottom: 6px; }
.dark .field label { color: #a8adb5; }
.inp { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 14px; border-radius: 12px; background: #f4f5f7; box-shadow: inset 0 0 0 1px transparent; }
.inp:focus-within { box-shadow: inset 0 0 0 1px #4d6bfe; background: #fff; }
.dark .inp { background: #1f2125; }
.dark .inp:focus-within { background: #17181b; }
input { flex: 1; min-width: 0; font: inherit; font-size: 15px; border: 0; outline: 0; background: transparent; color: inherit; }
.note { font-size: 12px; color: #8a8f98; margin: -6px 0 14px; }
.err { font-size: 13px; color: #d93025; margin: -6px 0 12px; }
.dark .err { color: #ff8a80; }
.opt { display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left; padding: 12px 4px; background: none; color: inherit; border-bottom: 1px solid rgba(0,0,0,.06); }
.dark .opt { border-color: rgba(255,255,255,.08); }
.opt .t { font-weight: 500; }
.opt .s { display: block; font-size: 12px; color: #8a8f98; }
.radio { flex: none; width: 18px; height: 18px; margin-top: 2px; border-radius: 9px; box-shadow: inset 0 0 0 1.5px #b8bcc4; }
.opt[aria-checked="true"] .radio { box-shadow: inset 0 0 0 5px #4d6bfe; }
.badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; font-size: 11px; line-height: 18px; background: rgba(77,107,254,.12); color: #4d6bfe; }
.wide { width: 100%; height: 44px; border-radius: 22px; }
`;

export function Protected({ zone, children }: { zone: 'approval' | 'permission' | 'login'; children: ComponentChildren }) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const dark = document.body.hasAttribute('data-ds-dark-theme');
  prefs.value; // re-render on theme change
  useLayoutEffect(() => {
    const el = host.current!;
    if (!root.current) {
      const shadow = el.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;
      const div = document.createElement('div');
      shadow.append(style, div);
      root.current = div;
    }
    root.current.className = `wrap ${dark ? 'dark' : ''}`;
    render(<>{children}</>, root.current);
  });
  useLayoutEffect(() => () => void (root.current && render(null, root.current)), []);
  return (
    <div
      ref={host}
      data-protected={zone}
      style="display:block !important; visibility:visible !important; opacity:1 !important; transform:none !important; filter:none !important; clip-path:none !important; position:relative !important; z-index:1 !important;"
    />
  );
}
