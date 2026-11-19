// The daily automatic update check a few seconds after launch (dsh-Go's
// UpdateLaunchCheck): when a version the person hasn't skipped is waiting, a
// toast offers it; the mark in 设置 › 检查更新 stays either way.

import { inApp, local } from '../bridge/native';
import { openPage, showToast } from '../state/store';

let done = false;
export async function checkUpdateOnLaunch() {
  if (done || !(inApp() || __PROTOTYPE__)) return;
  done = true;
  await new Promise((r) => setTimeout(r, 6000));
  try {
    if (!(await local<boolean>('update.autoCheck'))) return;
    const u = await local<{ latest?: { version: string } }>('update.get');
    // Don't interrupt someone typing.
    if ((document.activeElement as HTMLElement | null)?.tagName === 'TEXTAREA' && (document.activeElement as HTMLTextAreaElement).value) return;
    showToast(`有新版本 ${u.latest?.version ?? ''}`.trim(), '查看', () => openPage('update'));
  } catch {
    /* quiet */
  }
}
