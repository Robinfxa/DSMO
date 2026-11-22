// 复制排查信息（对话的「更多」菜单）：用户说「串窗口了」时，拿到这一段对话里每一轮额外塞给模型的东西。
// DSH 把每一轮的附加内容原样记在对话记录里：runtime-context 快照按段落标出是谁加的（maidsh、设定集……），
// 系统提示词（含自动读进来的 AGENTS.md）记成 system/message，全文放在最后。这里只读这一段对话的最近记录，
// 不碰别的对话；用户自己看过再决定发不发。
//
// 看法：串过来的内容出现在某一轮的「塞给模型」里 → 看段落名就知道是哪个插件；
// 哪一轮都没有，却出现在别的窗口的界面上 → 是前端显示的问题。

import { errText, getClient, nativeInfo, openOverlay, showToast, toast } from '../state/store';
import { installed } from '../plugins/frontend';
import { isScopeOff } from '../maidsh/scope';
import { hasModule } from '../maidsh/api';

/** 最多读这么多条记录、列这么多轮（够看最近一段，不至于太长）。 */
const MAX_RECORDS = 600;
const MAX_TURNS = 30;
const CLIP_USER = 300;
const CLIP_REPLY = 200;
const CLIP_SECTION = 3000;
const CLIP_SYSTEM = 6000;

export type Rec = { seq?: unknown; time?: unknown; type?: unknown; data?: unknown };
type Obj = Record<string, unknown>;

const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字，后面省略）` : s);
const textOf = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .map((c) => (o(c).type === 'text' ? String(o(c).text ?? '') : o(c).type ? `[${String(o(c).type)}]` : ''))
    .join('')
    .trim();
const when = (t: unknown) => (typeof t === 'number' ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');

/** 菜单项：整理好后放进一个能复制的文字面板（安卓上剪贴板有时不让写，面板里也能手动选）。 */
export async function showDiagnostic(sessionId: string, title?: string) {
  showToast('正在整理排查信息…');
  try {
    const body = await diagnosticText(sessionId, title);
    toast.value = null;
    openOverlay({ kind: 'text', title: '排查信息（只含这段对话，看过再发）', body });
  } catch (e) {
    showToast(`整理失败：${errText(e)}`);
  }
}

/** 这一段对话的排查信息（纯文本）。 */
/** Why a conversation has no records to show (the engine's answer to session/projections). */
const CUT_NOTE: Record<string, string> = {
  missing: '引擎里找不到这段对话的存档（可能是还没存盘就断了，或者存档读不出来）',
  migration: '这段对话的存档是旧格式，引擎第一次打开时要先整段转换；对话很大时转换很吃内存',
  empty: '这段对话还没有记录',
  other: '引擎没给出这段对话的记录位置',
};

export async function diagnosticText(sessionId: string, title?: string): Promise<string> {
  const client = getClient();
  const { records, cut, kind } = await client.recordsWithCut(sessionId, MAX_RECORDS);
  const recs = records as Rec[];
  // what the session list knows about it (works even when its log can't be read)
  const summary = await client
    .listSessions()
    .then((l) => l.find((x) => x.sessionId === sessionId))
    .catch(() => undefined);
  const info = nativeInfo.value;
  return formatDiagnostic(recs, [
    'DSMO 排查信息（只含这一段对话）',
    `生成于 ${when(Date.now())} · 页面 ${info?.webVersion ?? __BUILD__} · App ${info?.appVersion ?? 'web'}`,
    `对话「${title || '新对话'}」 · ${sessionId.replace(/^session-/, '').slice(0, 8)}${hasModule('core') ? ` · 陪伴${isScopeOff(sessionId) ? '已关' : '开着'}` : ''}`,
    `已装插件：${installed.value.filter((p) => p.enabled).map((p) => `${p.id.replace('@api-demo/', '')} ${p.version}`).join('，') || '无'}`,
    summary
      ? `列表里：最后更新 ${when(summary.updatedAt)}${summary.running ? ' · 正在运行' : ''}${summary.blank ? ' · 空白' : ''}${summary.agentAvailable ? '' : ' · 引擎里没在打开'}`
      : '对话列表里没有这段对话',
    ...(cut === 'ok' ? [] : [`读不到记录：${CUT_NOTE[cut] ?? cut}${kind ? `（${kind}）` : ''}`]),
  ]);
}

/** 记录 → 文字（[head] 是开头几行）。 */
export function formatDiagnostic(recs: Rec[], head: string[]): string {
  head = [...head, `读到 ${recs.length} 条记录${recs.length >= MAX_RECORDS ? '（只看最近这些）' : ''}`];

  // 每一轮：用户的话 → 这一轮新塞进去的东西（和上一次一样的不重复列）→ 回复开头
  const turns: string[][] = [];
  let cur: string[] | null = null;
  const lastSection = new Map<string, string>();
  const seenOther = new Set<string>();
  // 系统提示词很长（DSH 自带的就有 6000 字），放在最后：聊天软件截断时，先丢的是它而不是每一轮的内容。
  const systems: string[] = [];
  const push = (line: string) => {
    if (!cur) turns.push((cur = ['（这段记录开头之前的内容）']));
    cur.push(line);
  };
  for (const r of recs) {
    const d = o(r.data);
    const type = String(r.type ?? '');
    if (type === 'user/message') {
      const src = o(d.source);
      const kind = String(src.kind ?? '');
      if (kind === 'time-context') continue; // 每轮都变，只是时间
      if (kind === 'user' || kind === '') {
        turns.push((cur = [`── ${when(r.time)} · #${String(r.seq)}`, `用户：${clip(textOf(d.content), CLIP_USER)}`]));
      } else if (Array.isArray(src.sections)) {
        for (const s of src.sections.map(o)) {
          const name = String(s.name ?? '?');
          const text = String(s.text ?? '');
          if (lastSection.get(name) === text) continue;
          lastSection.set(name, text);
          push(`  [塞给模型 · ${kind} · ${name}]\n${indent(clip(text, CLIP_SECTION))}`);
        }
      } else if (kind === 'skill-catalog') {
        const names = (Array.isArray(src.entries) ? src.entries : []).map((e) => String(o(e).name ?? '')).join('、');
        if (!seenOther.has(`skills:${names}`)) {
          seenOther.add(`skills:${names}`);
          push(`  [塞给模型 · 技能目录] ${names || '（空）'}`);
        }
      } else {
        const text = textOf(d.content);
        if (!seenOther.has(`${kind}:${text}`)) {
          seenOther.add(`${kind}:${text}`);
          push(`  [塞给模型 · ${kind}]\n${indent(clip(text, CLIP_SECTION))}`);
        }
      }
    } else if (type === 'system/message') {
      const text = textOf(o(d.message).content);
      if (text && text !== systems[systems.length - 1]) {
        systems.push(text);
        push(`  [系统提示词${systems.length > 1 ? `换了（第 ${systems.length} 版）` : ''}，${text.length} 字，全文在最后]`);
      }
    } else if (type === 'assistant/message') {
      const text = textOf(d.content ?? o(d.message).content);
      if (text) push(`回复：${clip(text, CLIP_REPLY)}`);
    }
  }
  const shown = turns.slice(-MAX_TURNS);
  if (turns.length > shown.length) head.push(`共 ${turns.length} 轮，下面是最近 ${shown.length} 轮`);
  const tail = systems.map((t, i) => `══ 系统提示词${systems.length > 1 ? ` 第 ${i + 1} 版` : ''}（含 AGENTS.md 等），${t.length} 字 ══\n${clip(t, CLIP_SYSTEM)}`);
  return [...head, '', ...shown.map((t) => t.join('\n')), ...(tail.length ? ['', ...tail] : [])].join('\n');
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
