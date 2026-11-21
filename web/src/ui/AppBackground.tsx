// The chat background a plugin set (plugins/background.ts): the picture, blurred if asked, under a
// veil in the theme's color. Painted behind everything in the chat stage (z-index -1 inside an
// isolated stage), never over it; nothing at all when no background is set.

import { useEffect } from 'preact/hooks';
import { background } from '../plugins/background';

export function AppBackground() {
  const b = background.value;
  useEffect(() => {
    document.body.classList.toggle('has-bg', !!b);
  }, [!!b]);
  if (!b) return null;
  return (
    <div class="app-bg" aria-hidden="true" style={{ '--bg-dim': String(b.style.dim / 100), '--bg-blur': `${b.style.blur}px` }}>
      <div class="app-bg-img" style={{ backgroundImage: `url("${b.url}")` }} />
    </div>
  );
}
