// 全部功能 / the chat menu / 设置: which entries are web pages (chat-bound pages, decision Q6) and
// which open dsh-Go's native pages (`dshgo://open/<page>` through the bridge).

import type { JSX } from 'preact';
import { native } from '../../bridge/native';
import { currentId, nativeInfo, openOverlay, openPage, showToast } from '../../state/store';

export interface PageDef {
  title: string;
  sub?: () => string | undefined;
  /** Needs an open conversation. */
  session?: boolean;
  actions?: () => JSX.Element | null;
  body: () => JSX.Element;
}

export interface CatalogItem {
  id: string;
  title: string;
  sub: string;
  /** Where it goes: a web page, an overlay, a setting, or a native dsh-Go page. */
  to: { page: string } | { overlay: 'search' | 'model' | 'host' | 'settings' } | { native: string; session?: boolean } | { action: () => void };
}

/** Things about the open conversation: the chat's top-right menu (advanced mode). */
export const CHAT_ITEMS: [string, CatalogItem[]][] = [
  [
    '概览',
    [
      { id: 'session-detail', title: '对话详情', sub: '每一轮的用时、步骤和改动', to: { page: 'session-detail' } },
      { id: 'plan-goal', title: '计划与目标', sub: '目标、待办与进度', to: { page: 'plan-goal' } },
      { id: 'subagents', title: '子代理', sub: '谱系与状态，点开接着聊', to: { page: 'subagents' } },
      { id: 'agent-team', title: '智能体团队', sub: '成员、任务板与消息', to: { page: 'agent-team' } },
      { id: 'permission', title: '权限', sub: '执行前是否确认', to: { page: 'permission' } },
    ],
  ],
  [
    '文件与运行',
    [
      { id: 'artifacts', title: '产出的文件', sub: 'AI 交给你的文件，预览、保存', to: { page: 'artifacts' } },
      { id: 'files', title: '文件', sub: '浏览与预览工作区', to: { page: 'files' } },
      { id: 'terminal', title: '终端', sub: '工作区里的终端', to: { page: 'terminal' } },
      { id: 'jobs', title: '后台任务', sub: '查看、停止', to: { page: 'jobs' } },
    ],
  ],
  [
    '在输入框里用',
    [
      { id: 'skills', title: '技能', sub: '用 /名字 调用', to: { page: 'skills' } },
      { id: 'reference', title: '引用文件和对话', sub: '用 @ 引用', to: { page: 'reference' } },
    ],
  ],
  ['导出', [{ id: 'export', title: '导出对话日志', sub: '下载完整的对话记录（JSON）', to: { page: 'export' } }]],
];

/** Preferences: they live in 设置 (advanced mode adds them there). */
export const SETTINGS_ITEMS: CatalogItem[] = [
  { id: 'models', title: '模型', sub: '新对话默认用的模型与思考深度', to: { overlay: 'model' } },
  { id: 'providers', title: '模型提供方', sub: 'DeepSeek 以外的兼容接口', to: { page: 'providers' } },
  { id: 'engine-settings', title: '引擎设置', sub: '子代理、命令执行等', to: { page: 'engine-settings' } },
  { id: 'engine-plugins', title: '引擎插件', sub: '装在主机引擎里的插件', to: { page: 'engine-plugins' } },
  { id: 'remote', title: '远程主机', sub: '连接电脑或服务器', to: { page: 'hosts' } },
  { id: 'phone', title: '手机操控', sub: '看屏幕、帮你点按', to: { page: 'phone' } },
  { id: 'engine', title: '本机引擎', sub: '启动、停止、日志与版本', to: { page: 'engine' } },
  { id: 'notify-settings', title: '通知', sub: '回答完、等你确认时提醒', to: { page: 'notify-settings' } },
  { id: 'voice-settings', title: '识别方式', sub: '语音输入用什么识别', to: { page: 'voice-settings' } },
  { id: 'access', title: '系统权限', sub: '通知、麦克风、后台运行', to: { page: 'access' } },
  { id: 'update', title: '检查更新', sub: '新版本与自动检查', to: { page: 'update' } },
  { id: 'cot-translation', title: '思考过程翻译', sub: '展开思考后点「翻译」', to: { overlay: 'settings' } },
  { id: 'voice-input', title: '语音输入', sub: '输入框里的麦克风', to: { overlay: 'settings' } },
  { id: 'settings', title: '全部设置', sub: '主题、语言与账号', to: { overlay: 'settings' } },
];

/** 全部功能: what is neither about one conversation nor a preference. */
export const CATALOG: [string, CatalogItem[]][] = [
  ['插件', [{ id: 'plugins', title: '插件', sub: '外观、界面、工具和引擎插件', to: { page: 'plugins' } }]],
  [
    '智能体与自动化',
    [
      { id: 'bots', title: 'DS Bot', sub: '长期在线的 Bot 团队与群聊', to: { page: 'bots' } },
      { id: 'presets', title: 'Agent 预设', sub: '新对话的工具与工作方式', to: { page: 'presets' } },
      { id: 'schedules', title: '自动化任务', sub: '定时与周期任务', to: { page: 'schedules' } },
    ],
  ],
  [
    // 论坛、社区先隐藏（docs/native-pages.md）
    '分享',
    [
      { id: 'share-profile', title: '分享配置', sub: '把插件、设置和技能做成链接', to: { page: 'share-profile' } },
      { id: 'share-open', title: '打开分享码', sub: '粘贴链接或选择 .dshgo 文件', to: { page: 'share-open' } },
    ],
  ],
  [
    '工具',
    [
      { id: 'search', title: '搜索对话', sub: '按标题和正文查找', to: { overlay: 'search' } },
      { id: 'workspaces', title: '工作区', sub: '添加与切换目录', to: { page: 'workspaces' } },
    ],
  ],
];

/** Reachable from inside other pages only (插件 → 已安装 → 引擎插件). */
const NESTED: CatalogItem[] = [{ id: 'cordis', title: '引擎插件', sub: '主机引擎里已加载的全部插件', to: { page: 'engine-plugins' } }];

const byId = new Map([...CATALOG, ...CHAT_ITEMS, ['设置', SETTINGS_ITEMS] as [string, CatalogItem[]], ['', NESTED] as [string, CatalogItem[]]].flatMap(([, items]) => items.map((i) => [i.id, i] as const)));
export const catalogItem = (id: string) => byId.get(id);

/** Opens a 全部功能 entry (also used by the sidebar and `dshgo://open/<id>` links). */
export function openFeature(id: string, fromSider = false) {
  if (id === 'features' || id === 'plugins' || id === 'native') return openPage(id, fromSider);
  const item = byId.get(id);
  if (!item) return openPage(id, fromSider);
  const to = item.to;
  if ('page' in to) return openPage(to.page, fromSider);
  if ('overlay' in to) return openOverlay(to.overlay === 'settings' ? { kind: 'settings' } : { kind: to.overlay });
  if ('action' in to) return to.action();
  // Native dsh-Go page.
  if (to.session && !currentId.value) return showToast('先打开一个对话');
  if (nativeInfo.value?.inApp) {
    native.openNativePage(to.native, to.session ? currentId.value ?? undefined : undefined).catch(() => showToast('打不开这个页面'));
    return;
  }
  nativePlaceholder.id = id;
  openPage('native', fromSider);
}

/** Which native page the browser placeholder describes. */
export const nativePlaceholder = { id: '' };
