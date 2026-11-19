// How plugins are presented: user-facing categories (by what a plugin changes,
// not by manifest internals), labels for every declarative capability, and the
// per-plugin options a user can turn off on the plugin's 管理 page.

import type { MIconName } from '../ui/mobile/icons';
import type { ApiDemoManifest, SlotName } from './frontend';

export type Category = 'appearance' | 'interface' | 'tools' | 'skills' | 'automation' | 'engine';

export const CATEGORIES: { id: Category; title: string; desc: string; icon: MIconName; tint: string }[] = [
  { id: 'appearance', title: '外观', desc: '配色、字体和气泡样式', icon: 'palette', tint: '#d9480f' },
  { id: 'interface', title: '界面', desc: '精简入口、调整布局', icon: 'layout', tint: '#2b8a3e' },
  { id: 'tools', title: '工具', desc: '加按钮、加面板，帮你做事', icon: 'puzzle', tint: '#4d6bfe' },
  { id: 'skills', title: '技能', desc: '在对话里用 /名字 调用', icon: 'bolt', tint: '#4d6bfe' },
  { id: 'automation', title: '自动化', desc: '到点自动开一个对话', icon: 'clock', tint: '#4d6bfe' },
  { id: 'engine', title: '引擎', desc: '装在主机上，扩展模型能做的事', icon: 'server', tint: '#7048e8' },
];
export const catInfo = (c: Category) => CATEGORIES.find((x) => x.id === c)!;

/** A manifest may name its category; otherwise it follows from what the plugin declares. */
export function categoryOf(p: ApiDemoManifest): Category {
  if (p.category && CATEGORIES.some((c) => c.id === p.category)) return p.category;
  if (p.engine || p.kinds.includes('engine')) return 'engine';
  if (p.kinds.includes('skill') || p.skills?.length) return 'skills';
  if (p.kinds.includes('schedule') || p.schedules?.length) return 'automation';
  if (p.kinds.includes('skin')) return 'appearance';
  if (p.kinds.includes('slot') || p.kinds.includes('panel')) return 'tools';
  return 'interface';
}

export const HIDE_LABEL: Record<string, string> = {
  'composer.think': '输入框「深度思考」',
  'composer.search': '输入框「智能搜索」',
  'composer.voice': '输入框语音按钮',
  'composer.attach': '输入框附件按钮',
  'sider.host': '边栏主机状态',
  'sider.features.plugins': '边栏「插件」',
  'sider.features.skills': '边栏「技能」',
  'sider.features.schedules': '边栏「自动化任务」',
  'sider.features.phone': '边栏「手机操控」',
  caveat: '底部 AI 生成提示',
};

export const SLOT_PLACE: Record<SlotName, string> = { 'sider.features': '边栏', 'composer.buttons': '输入框上方' };

export const PERM_INFO: Record<string, { title: string; desc: string; icon: MIconName }> = {
  storage: { title: '本地存储', desc: '在这台设备上保存插件自己的数据，别的插件读不到', icon: 'data' },
  'engine.read': { title: '读取对话和文件', desc: '只读：对话列表、搜索、工作区文件。不能发消息、不能改设置', icon: 'eye' },
  'session.prompt': { title: '替你发消息', desc: '可以把文字作为你的消息发出去', icon: 'chat' },
  network: { title: '联网', desc: '可以访问 https 网址', icon: 'globe' },
};

/** Skins, layouts and entries can be switched off; skills, automations and engine parts live on the host. */
export const hasToggle = (p: ApiDemoManifest) => ['appearance', 'interface', 'tools'].includes(categoryOf(p));

export const TIER_INFO: Record<number, string> = {
  1: '第 1 级 · 自动检查',
  2: '第 2 级 · 自动检查 + 人工复核',
  3: '第 3 级 · 逐行审核',
};

/** The things on a plugin's 管理 page that can be switched off one by one. */
export function optionsOf(p: ApiDemoManifest): { key: string; title: string; sub: string }[] {
  const out: { key: string; title: string; sub: string }[] = [];
  for (const s of p.slots ?? [])
    out.push({
      key: `slot:${s.slot}#${s.id}`,
      title: `${SLOT_PLACE[s.slot] ?? s.slot}「${s.title}」`,
      sub: 'insert' in s.action ? `点一下把「${s.action.insert.slice(0, 18)}${s.action.insert.length > 18 ? '…' : ''}」放进输入框` : 'panel' in s.action ? '打开插件面板' : '打开一个页面',
    });
  for (const k of p.layout?.hide ?? []) out.push({ key: `hide:${k}`, title: HIDE_LABEL[k] ?? k, sub: '' });
  return out;
}

/** Entries a category shelf shows on 发现 before 全部 ›. */
export const SHELF = 3;

/** Search over what a person would type: name, what it does, its category, author, contained skills and tasks. Every word must match. */
export function matches(p: ApiDemoManifest, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [
    p.title,
    p.summary,
    p.description,
    catInfo(categoryOf(p)).title,
    p.official ? '官方' : p.author,
    p.id,
    ...(p.skills ?? []).map((k) => k.name),
    ...(p.schedules ?? []).map((t) => t.title),
    ...(p.slots ?? []).map((x) => x.title),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** How well a match matches, for ordering results: every word in the name, then in name + summary or category, then anywhere. */
export function relevance(p: ApiDemoManifest, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const has = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  if (has(p.title)) return 3;
  if (has(`${p.title}\n${p.summary}\n${catInfo(categoryOf(p)).title}`)) return 2;
  return 1;
}
