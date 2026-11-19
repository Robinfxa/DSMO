// Runtime check for the hard rules: while plugin CSS is active, every
// protected element ([data-protected]: approval card, permission page, login
// form) must be laid out, visible, opaque and not covered. Otherwise plugin
// CSS is switched off at once and the user is told.

import { hasPluginCss, suspendPluginCss } from './frontend';

function hiddenReason(el: HTMLElement): string | null {
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return 'collapsed';
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none') return 'display';
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility';
    if (parseFloat(cs.opacity) < 0.2) return 'opacity';
    if (cs.clipPath && cs.clipPath !== 'none') return 'clip';
  }
  // Covered? Only meaningful when no app layer (overlay / page / drawer) is meant to be on top.
  const appLayer = document.querySelector('.overlay.open, .page.open, .frame.drawer-open');
  const ownLayer = el.closest('.overlay, .page');
  if (appLayer && !ownLayer) return null;
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
  const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 40), 1), innerHeight - 1);
  if (r.bottom < 0 || r.top > innerHeight) return null; // scrolled away: fine
  const hit = document.elementFromPoint(x, y);
  if (hit && hit !== el && !el.contains(hit) && !hit.closest('.toast, .menu, .cmenu')) return 'covered';
  return null;
}

export function checkProtected(): string | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-protected]')) {
    const why = hiddenReason(el);
    if (why) return `${el.dataset.protected}:${why}`;
  }
  return null;
}

export function startGuard() {
  const run = () => {
    if (!hasPluginCss()) return;
    const bad = checkProtected();
    if (bad) suspendPluginCss('插件样式遮住了授权卡或登录框，已暂停插件样式');
  };
  setInterval(run, 1000);
  new MutationObserver((muts) => {
    if (muts.some((m) => [...m.addedNodes].some((n) => n instanceof HTMLElement && (n.matches('[data-protected]') || n.querySelector('[data-protected]'))))) requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true });
}
