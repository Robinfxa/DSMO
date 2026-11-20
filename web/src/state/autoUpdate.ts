// Interface hot update, without asking (the app: native/overlay/…/web_update.dart). The app checks
// for a newer page when it opens and when it comes back from the background, downloads it and
// says `webUpdate.ready`; the page then switches to it by itself at a moment it won't be in the
// way, and comes back where it was.
//
// When: at once if the app is in the background; otherwise as soon as nothing would be lost or
// cut off — no reply generating, nothing typed or attached, the keyboard down, no dialog, menu,
// sheet or page open on top of the chat. Waiting for that is checked every couple of seconds.
// The page also asks the app for news itself every half hour while it stays open.
//
// Before switching it notes the open conversation, pages and draft (localStorage, a minute's
// worth); the new page opens them again (resumeAfterUpdate).

import { effect } from '@preact/signals';
import { inApp, native } from '../bridge/native';
import {
  approvals,
  attachments,
  currentId,
  draft,
  drawerOpen,
  editing,
  openSession,
  overlays,
  pages,
  popover,
  questions,
  renaming,
  running,
  screens,
  sessionsLive,
  webUpdateReady,
} from './store';

const KEY = 'api-demo:resume-after-update';
const FRESH_MS = 60_000;
const POLL_MS = 2_000;
const RECHECK_MS = 30 * 60_000;

/** Nothing on screen that a reload would lose or cut off. */
function idle(): boolean {
  const el = document.activeElement;
  const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable);
  return (
    !running.value &&
    !draft.value.trim() &&
    !attachments.value.length &&
    !editing.value &&
    !renaming.value &&
    !typing &&
    !overlays.value.length &&
    !popover.value &&
    !drawerOpen.value &&
    !pages.value.length &&
    !screens.value.length &&
    !approvals.value.length &&
    !questions.value.length
  );
}

let switching = false;
async function switchNow() {
  if (switching) return;
  switching = true;
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), id: currentId.value, pages: pages.value, draft: draft.value }));
  } catch {
    /* storage unavailable: it still switches, only not back to the same place */
  }
  try {
    if (!(await native.applyWebUpdate())) throw new Error('not switched');
  } catch {
    // used from the next launch anyway; don't keep trying this launch
    webUpdateReady.value = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  } finally {
    switching = false;
  }
}

function tryNow() {
  if (!webUpdateReady.value || switching) return;
  if (document.visibilityState === 'hidden' ? !running.value : idle()) void switchNow();
}

/** Asks the app whether a newer page is out (it downloads it); ready when it is. */
async function recheck() {
  try {
    const r = await native.checkWebUpdate();
    if (r && r.latest !== 'apk' && r.latest !== r.serving) webUpdateReady.value = r.latest;
  } catch {
    /* offline: next time */
  }
}

/** Starts watching for a downloaded page to switch to (in the app only). */
export function startAutoWebUpdate(): () => void {
  if (!inApp()) return () => {};
  const offEffect = effect(() => {
    // re-run when any of these change; the timer covers focus and visibility
    void webUpdateReady.value, running.value, draft.value, overlays.value, pages.value, screens.value;
    tryNow();
  });
  const poll = setInterval(tryNow, POLL_MS);
  const again = setInterval(() => void recheck(), RECHECK_MS);
  const onVis = () => tryNow();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    offEffect();
    clearInterval(poll);
    clearInterval(again);
    document.removeEventListener('visibilitychange', onVis);
  };
}

/** After a switch: back to the conversation, pages and draft it was showing (once the list is in). */
export function resumeAfterUpdate() {
  let saved: { at?: number; id?: string | null; pages?: string[]; draft?: string } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    localStorage.removeItem(KEY);
  } catch {
    return;
  }
  if (!saved || typeof saved.at !== 'number' || Date.now() - saved.at > FRESH_MS) return;
  const s = saved;
  let done = false;
  const off = effect(() => {
    if (done || !sessionsLive.value) return;
    done = true;
    queueMicrotask(() => off());
    if (typeof s.id === 'string' && s.id !== currentId.value) openSession(s.id);
    if (Array.isArray(s.pages) && s.pages.every((p) => typeof p === 'string')) pages.value = s.pages;
    if (typeof s.draft === 'string' && s.draft) draft.value = s.draft;
  });
}
