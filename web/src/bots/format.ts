// Words the Bot pages share (dsh-Go ui/bots/bot_format.dart).

import type { Item, Model, Room, Team, Work } from './api';

const TOOL: [RegExp, string][] = [
  [/^(bash|pwsh|shell|run_code)$/, '运行命令'],
  [/^(read|read_file|fs_read|view|list|glob|grep)$/, '查看文件'],
  [/^(write|edit|str_replace_editor|apply_patch)$/, '修改文件'],
  [/^web_search$/, '联网搜索'],
  [/^(web_fetch|read_browser)$/, '看网页'],
  [/^message_bot$/, '联系其他 Bot'],
  [/^(group_relay|post_to_group|read_group_chat)$/, '在群里沟通'],
  [/^(remember|forget)$/, '整理记忆'],
  [/^(recall|read_own_chat)$/, '翻看记录'],
  [/^(create_bot|update_bot|create_group|update_group)$/, '安排团队'],
  [/^(ask_user|show_view)$/, '准备问你'],
];
export const toolVerb = (tool: string) => TOOL.find(([re]) => re.test(tool))?.[1] ?? '干活';

/** 「正在运行命令」 for what a Bot does now; null when idle. */
export function workPhrase(work?: Work, activity?: string): string | null {
  if (!work) return activity === 'thinking' ? '正在思考' : null;
  if (work.switching) return '正在整理笔记';
  if (!work.tool) return '正在思考';
  return `正在${toolVerb(work.tool)}`;
}
export const approvalPhrase = (name: string, tool: string) => `${name} 想${toolVerb(tool)}`;

/** 「刚刚」「14:05」「昨天」「10月3日」. */
export function shortTime(t?: number): string {
  if (!t) return '';
  const now = new Date();
  const d = new Date(t);
  if (Math.abs(now.getTime() - t) < 60_000) return '刚刚';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (day(d) === day(now)) return hm;
  if (day(d) === day(now) - 86400_000) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
/** A separator line in a transcript: 「14:05」「昨天 14:05」. */
export function lineTime(t: number): string {
  const s = shortTime(t);
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return s === hm || s === '刚刚' ? hm : `${s} ${hm}`;
}

export function compactCount(v: number) {
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(v >= 1e5 ? 0 : 1)} 万`;
  return String(v);
}

export function modelLabel(ref: string | undefined, models: Model[]) {
  if (!ref) return '未选择';
  return models.find((m) => m.ref === ref)?.name ?? (ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref);
}
export const monogram = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';

export function roomPreview(room: Room, team: Team): string {
  const p = room.preview?.replace(/\s+/g, ' ').trim();
  if (!p) return '';
  for (const id of room.members) {
    const name = team.bots.find((b) => b.id === id)?.name;
    if (name && p.startsWith(`${name}：`)) return p;
  }
  return `你：${p}`;
}

export function roomEventText(item: Item): string {
  const name = item.name ?? 'Bot';
  switch (item.event) {
    case 'working':
      return `${name} 开始干活`;
    case 'approval':
      return `${name} 在等你批准`;
    case 'done':
      return `${name} 完成了工作`;
    case 'stopped':
      return `你停下了 ${name} 的工作`;
    case 'paused':
      return '已暂停';
    case 'failed':
      return `${name} 没能回答`;
    case 'missed':
      return `${name} 没有及时回应`;
    case 'lookup':
      return item.text ? `${name} 在自己的聊天里找「${item.text}」` : `${name} 翻看了自己的聊天`;
    case 'resumed':
      return `${name} 重启后接着干`;
    case 'cut':
      return `${name} 又被重启打断，停下了`;
    case 'schedule':
      return item.text ? `定时任务：${item.text}` : '定时任务';
  }
  return item.text;
}

export function chatEventText(item: Item, roomName?: string): string {
  const name = item.name ?? '其他 Bot';
  switch (item.role) {
    case 'request':
      return `来自 ${name} 的消息`;
    case 'reply':
      return `${name} 回复了`;
    case 'report':
      return roomName ? `「${roomName}」里有了回复` : '群里有了回复';
    case 'stopped':
      return `${name} 叫停了工作`;
  }
  return item.text;
}

export const EFFORTS: [string, string][] = [
  ['', '默认'],
  ['off', '不思考'],
  ['minimal', '极少'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['max', '最高'],
];
export const effortLabel = (e?: string) => EFFORTS.find(([k]) => k === (e ?? ''))?.[1] ?? e ?? '默认';
export const SCOPE: Record<string, string> = { own: '自己', team: '团队', group: '群' };
