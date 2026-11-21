// 全部功能 › 边栏功能区: which rows the sidebar's 「功能」 shows. The person's choice sits on top of
// what layout plugins hide (frontend.ts layoutHidden); 全部功能 itself always stays, as the way back.
import { computed } from '@preact/signals';
import { prefs, setPref } from '../state/store';
import { findPlugin, installed, isOptionOn, layoutHidden, slotItems } from '../plugins/frontend';

export interface SiderRow {
  /** sider.host · sider.features.<id> · slot:<plugin>#<slot> */
  key: string;
  title: string;
  sub?: string;
}

const BUILTIN: SiderRow[] = [
  { key: 'sider.host', title: '当前主机', sub: '本机或连着的远程主机，点开切换' },
  { key: 'sider.features.plugins', title: '插件' },
  { key: 'sider.features.skills', title: '技能' },
  { key: 'sider.features.schedules', title: '自动化任务' },
  { key: 'sider.features.phone', title: '手机操控' },
  { key: 'sider.features.bots', title: 'DS Bot', sub: '建了 Bot 团队后才出现' },
];

/** Every row the 功能 area can show now: the built-in ones, then plugins' entries. */
export const siderRows = computed<SiderRow[]>(() => [
  ...BUILTIN.filter((r) => r.key !== 'sider.features.bots' || document.body.classList.contains('is-m')),
  ...slotItems('sider.features').map((x) => ({ key: `slot:${x.key}`, title: x.title, sub: `插件「${findPlugin(x.key.split('#')[0])?.title ?? '插件'}」的入口` })),
]);

/** What the 功能 area leaves out: plugins' layout hides plus the person's own. */
export const siderHidden = computed(() => new Set([...layoutHidden.value, ...prefs.value.siderHidden]));

export const siderShown = (key: string) => !prefs.value.siderHidden.includes(key);
export function setSiderShown(key: string, on: boolean) {
  const cur = prefs.value.siderHidden.filter((k) => k !== key);
  setPref('siderHidden', on ? cur : [...cur, key]);
}

/** A layout plugin that hides this row, if one does (its switch is then not the person's to flip). */
export function hiddenByPlugin(key: string): string | null {
  if (!layoutHidden.value.has(key)) return null;
  for (const x of installed.value) {
    const p = x.enabled ? findPlugin(x.id) : undefined;
    if (p?.layout?.hide?.includes(key) && isOptionOn(p.id, `hide:${key}`)) return p.title;
  }
  return null;
}
