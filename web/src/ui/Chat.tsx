import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { siblingsFor, versionsVersion, type Siblings } from '../state/versions';
import { describeApproval, type ApprovalRequest, type Part, type QuestionRequest } from '../engine/events';
import type { ChatItem } from '../engine/transcript';
import { pluginMessageActions } from '../plugins/dshgo';
import {
  LOCATION_TAG,
  answerApproval,
  answerQuestion,
  copyText,
  currentId,
  draft,
  editing,
  getClient,
  getTranscript,
  optimistic,
  openOverlay,
  prefs,
  isMobile,
  openPopover,
  questions,
  resendFrom,
  forkConversation,
  switchVersion,
  sessions,
  showToast,
  txVersion,
  followState,
} from '../state/store';
import { Ic } from './common';
import { MIc, useLongPress } from './mobile/MobileApp';
import { canSpeak, speak } from '../bridge/native';
import { renderMarkdown } from './md';
import { SOURCE_NAME } from '../history/imported';
import { Protected } from './Protected';
import { openFeature } from './pages/registry';
import { SessionImage } from './SessionImage';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
type Asst = Extract<ChatItem, { kind: 'assistant' }>;
type User = Extract<ChatItem, { kind: 'user' }>;
type Notice = Extract<ChatItem, { kind: 'notice' }>;

interface Group {
  key: string;
  user?: User;
  steer?: boolean;
  parts: Array<Asst | Tool>;
  notices: Notice[];
}

/** maidsh-initiative 唤醒 AI 时那条隐藏消息的来源（见 maidsh/CONTRACT.md §10）。 */
const INITIATIVE_SOURCE = 'maidsh-initiative';

/** One user message and everything the agent did for it. */
function groupItems(items: ChatItem[]): Group[] {
  const out: Group[] = [];
  let g: Group | null = null;
  for (const it of items) {
    if (it.kind === 'user') {
      // A steering message joins the running group instead of opening a new one.
      g = { key: it.key, user: it, parts: [], notices: [] };
      out.push(g);
      continue;
    }
    if (!g) {
      g = { key: `g${it.key}`, parts: [], notices: [] };
      out.push(g);
    }
    if (it.kind === 'notice') g.notices.push(it);
    else g.parts.push(it);
  }
  return out;
}

export function Chat() {
  txVersion.value;
  const t = getTranscript();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [away, setAway] = useState(false);
  const items = t?.items ?? [];
  const groups = groupItems(items);
  const isRunning = !!t?.running;
  versionsVersion.value;
  const known = new Set(sessions.value.map((x) => x.sessionId));
  const userSeqs = items.filter((x): x is User => x.kind === 'user').map((x) => x.seq).sort((a, b) => a - b);
  const sibs = currentId.value ? siblingsFor(currentId.value, userSeqs, (id) => known.has(id)) : new Map<number, Siblings>();
  const turnEnds = (t?.events ?? []).filter((e) => e.kind === 'turn-end').map((e) => e.seq).sort((a, b) => a - b);
  const pendingOpt = optimistic.value.filter((o) => o.sessionId === currentId.value);
  const qs = questions.value.filter((q) => q.sessionId === currentId.value);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [currentId.value]);

  const onScroll = async () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 240;
    if (far !== away) setAway(far);
    if (el.scrollTop < 40 && t?.hasMoreHistory && !loadingOlder && t.oldestSeq !== undefined) {
      setLoadingOlder(true);
      const h0 = el.scrollHeight;
      try {
        const page = await getClient().history(currentId.value!, t.cursor, t.oldestSeq);
        t.prependHistory(page.events, page.hasMore);
        txVersion.value++;
        requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - h0));
      } catch {
        /* keep what we have */
      } finally {
        setLoadingOlder(false);
      }
    }
  };

  if (!t || (followState.value === 'opening' && !items.length && !pendingOpt.length)) {
    return (
      <div class="scroll" id="scroll">
        <div class="column loading-col">
          <span class="spin" role="img" aria-label="加载中" />
        </div>
      </div>
    );
  }

  return (
    <div class="scroll" id="scroll" ref={scroller} onScroll={onScroll}>
      <div class="column" id="column">
        {t.hasMoreHistory && <div class="older">{loadingOlder ? '正在加载更早的消息…' : '上滑加载更早的消息'}</div>}
        {!t.hasMoreHistory && t.importedFrom && <ImportedNote from={t.importedFrom} />}
        {groups.map((g, i) => (
          <GroupView
            g={g}
            key={g.key}
            busy={isRunning && i === groups.length - 1}
            last={i === groups.length - 1}
            sib={g.user ? sibs.get(g.user.seq) : undefined}
            forkSeq={g.user ? turnEnds.find((x) => x > g.user!.seq) : undefined}
          />
        ))}
        {t.inbox.map((q, i) => (
          <div class="msg user enter" key={`q${i}`}>
            <div class="bubble">{q.text}</div>
            <div class="steer">{q.steering ? '插话 · AI 下一步会看到' : '排队中 · 这一轮结束后发送'}</div>
          </div>
        ))}
        {pendingOpt
          .filter((o) => !t.inbox.some((q) => q.text === o.text))
          .map((o) => (
            <div class="msg user enter" key={o.requestId}>
              <div class="bubble">{o.text}</div>
              {o.steer && <div class="steer">插话 · AI 下一步会看到</div>}
            </div>
          ))}
        {pendingOpt.length > 0 && !isRunning && (
          <div class="msg assistant enter">
            <div class="a-row">
              <span class="brand">
                <Ic n="IconThinkOutline16" />
              </span>
              <span class="shimmer">正在连接模型…</span>
            </div>
          </div>
        )}
        {qs.map((q) => (
          <QuestionCard q={q} key={q.eventId} />
        ))}
      </div>
      {away && (
        <button
          class="to-bottom"
          type="button"
          aria-label="回到底部"
          onClick={() => {
            const el = scroller.current!;
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            stick.current = true;
          }}
        >
          <MIc n="scrollDown" />
        </button>
      )}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  streaming: '准备中',
  running: '运行中',
  'awaiting-approval': '等待授权',
  succeeded: '',
  failed: '失败',
  denied: '已拒绝',
  cancelled: '已停止',
};

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function describeTool(t: Pick<Tool, 'name' | 'arguments'>): { verb: string; detail: string; kind: 'file' | 'run' } {
  const a = parseArgs(t.arguments);
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const n = t.name.toLowerCase();
  if (/^(read|read_file|view)$/.test(n)) return { verb: '读取', detail: s('path') || s('file_path'), kind: 'file' };
  if (/^(edit|apply_patch|str_replace|multi_edit)$/.test(n)) return { verb: '修改', detail: s('path') || s('file_path'), kind: 'file' };
  if (/^(write|write_file|create)$/.test(n)) return { verb: '写入', detail: s('path') || s('file_path'), kind: 'file' };
  if (/^(bash|shell|exec|run)$/.test(n)) return { verb: a.run_in_background ? '后台运行' : '运行', detail: s('command') || s('cmd'), kind: 'run' };
  if (/^(grep|glob|search|find)$/.test(n)) return { verb: '搜索', detail: s('pattern') || s('query'), kind: 'file' };
  if (/web_?search/.test(n)) return { verb: '搜索网页', detail: s('query'), kind: 'run' };
  if (/web_?fetch|fetch_url/.test(n)) return { verb: '打开网页', detail: s('url'), kind: 'run' };
  if (/todo/.test(n)) return { verb: '更新待办', detail: '', kind: 'file' };
  if (/task|subagent|agent/.test(n)) return { verb: '交给子代理', detail: s('description') || s('prompt').slice(0, 40), kind: 'run' };
  if (/present/.test(n)) return { verb: '展示文件', detail: s('path'), kind: 'file' };
  return { verb: t.name || '工具', detail: s('description') || '', kind: 'run' };
}

function GroupView({ g, busy, last, sib, forkSeq }: { g: Group; busy: boolean; last: boolean; sib?: Siblings; forkSeq?: number }) {
  const adv = prefs.value.advanced;
  const [thinkOpen, setThinkOpen] = useState(prefs.value.thinkExpanded);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const finalTextRef = useRef('');
  const asst = g.parts.filter((p): p is Asst => p.kind === 'assistant');
  const tools = g.parts.filter((p): p is Tool => p.kind === 'tool');
  const reasoning = asst.map((a) => a.reasoning.trim()).filter(Boolean).join('\n\n');
  // Advanced mode keeps the order: texts said between tool calls sit in the step list;
  // the reply is what came after the last tool. Basic mode shows all text as one reply.
  const lastTool = g.parts.map((p) => p.kind).lastIndexOf('tool');
  const said = new Set(adv ? g.parts.filter((p, i): p is Asst => p.kind === 'assistant' && i < lastTool && !!p.text.trim()) : []);
  const finalText = asst
    .filter((a) => !said.has(a))
    .map((a) => a.text)
    .filter((x) => x.trim())
    .join('\n\n');
  finalTextRef.current = finalText;
  const streamingNow = asst.some((a) => a.streaming);
  const thinkingNow = busy && streamingNow && !finalText && !!reasoning && !tools.length;
  const pending = tools.filter((t) => t.approval);
  const userText = g.user?.text.replace(LOCATION_TAG, '') ?? '';
  const replyPress = useLongPress((pt) =>
    openPopover(pt, [
      { icon: 'copy', label: '复制', run: () => copyText(finalTextRef.current) },
      ...(currentId.value && forkSeq !== undefined ? [{ icon: 'fork' as const, label: '分叉到新对话', run: () => void forkConversation(currentId.value!, forkSeq) }] : []),
    ]),
  );

  const secs = (() => {
    const a = asst.find((x) => x.reasoning);
    // Imported replies carry the export's dates, not how long the model thought.
    if (!a?.time || !g.user || a.provider === 'deepseek-import') return 0;
    return Math.max(1, Math.round((a.time - g.user.time) / 1000));
  })();

  return (
    <>
      {g.user && g.user.sourceKind === INITIATIVE_SOURCE ? (
        // MaiDSH 主动：那条提示是给 AI 看的，不显示；只标一下这一轮是 TA 先开口
        <div class="initiative-mark">TA 先开口</div>
      ) : (
        g.user && <UserMsg user={g.user} text={userText} sib={sib?.kind === 'edit' ? sib : undefined} />
      )}
      {(g.parts.length > 0 || g.notices.length > 0 || busy) && (
        <div class={`msg assistant ${last ? 'enter' : ''}`} {...(isMobile.value && finalText && !busy ? replyPress : {})}>
          {busy && !g.parts.length && (
            <div class="a-row">
              <span class="brand">
                <Ic n="IconThinkOutline16" />
              </span>
              <span class="shimmer">{prefs.value.think || adv ? '思考中…' : '正在回复…'}</span>
            </div>
          )}
          {reasoning && (
            <div class="a-think">
              <div class="a-think-head">
                <div class="think-row">
                  <button class="a-row" type="button" aria-expanded={thinkOpen} onClick={() => setThinkOpen(!thinkOpen)}>
                    <span class="brand">
                      <Ic n="IconThinkOutline16" />
                    </span>
                    <span class={thinkingNow ? 'shimmer' : ''}>{thinkingNow ? '思考中…' : secs ? `已思考（用时 ${secs} 秒）` : '已思考'}</span>
                    <Ic n={thinkOpen ? 'IconChevronDownOutline14' : 'IconChevronRightOutline14'} />
                  </button>
                  {adv && prefs.value.cotTranslate && !thinkingNow && <TranslateBtn text={reasoning} />}
                </div>
              </div>
              <div class={`a-think-body ${thinkOpen ? '' : 'closed'}`}>
                <div class="a-think-in">
                  <span class="tdot" aria-hidden="true">
                    <i class={thinkingNow ? 'active' : ''} />
                  </span>
                  <span class="tline" aria-hidden="true" />
                  <p>{reasoning}</p>
                </div>
              </div>
            </div>
          )}
          {tools.length > 0 && (
            <div class="a-steps-head">
              <div class="a-row">
                <span class="brand">
                  <Ic n="IconThinkOutline16" />
                </span>
                <span class={busy ? 'shimmer' : ''}>
                  {busy ? '进行中' : g.notices.some((n) => n.tone === 'aborted') ? '已停止' : '已完成'} · {tools.length} 次工具调用
                </span>
              </div>
            </div>
          )}
          {adv && tools.length > 0 && (
            <div class="a-steps">
              {g.parts.map((part) => {
                if (part.kind === 'assistant') {
                  return said.has(part) ? (
                    <div class="step say" key={part.key}>
                      {part.text}
                    </div>
                  ) : null;
                }
                const t = part;
                const d = describeTool(t);
                const st = t.status === 'awaiting-approval' ? 'waiting' : t.status === 'succeeded' ? 'done' : t.status === 'cancelled' ? 'stopped' : t.status;
                return (
                  <div key={t.key}>
                    <button class={`step ${st}`} type="button" aria-expanded={openStep === t.key} onClick={() => setOpenStep(openStep === t.key ? null : t.key)}>
                      <span class="step-ico">
                        <Ic n={d.kind === 'file' ? 'StepFile' : 'StepTerminal'} />
                      </span>
                      <span>{d.verb}</span>
                      <span class="step-detail">{d.detail}</span>
                      {t.status === 'running' || t.status === 'streaming' ? <span class="spin" role="img" aria-label="运行中" /> : <span class="step-state">{STATE_LABEL[t.status]}</span>}
                    </button>
                    {openStep === t.key && (
                      <pre class="code step-out">{t.resultText || (t.status === 'running' ? '还没有输出' : JSON.stringify(parseArgs(t.arguments), null, 2))}</pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {pending.map((t) => (
            <ApprovalCard key={t.approval!.eventId} r={t.approval!} tool={t} />
          ))}
          {finalText && <div class="a-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(finalText) }} onClick={onMdClick} />}
          {asst.some((a) => a.interrupted) && !g.notices.length && <div class="a-note">已中断</div>}
          {g.notices.map((n) => (
            <div class={`a-note ${n.tone}`} key={n.key}>
              {n.tone === 'error' && <Ic n="IconWarningOutline16" />}
              {n.text}
            </div>
          ))}
          {!busy && finalText && <ReplyActions text={finalText} user={g.user} sib={sib?.kind === 'regen' ? sib : undefined} forkSeq={forkSeq} />}
        </div>
      )}
    </>
  );
}

function onMdClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a[data-link]') as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  const url = a.dataset.link!;
  const m = url.match(/^dshgo:\/\/open\/([\w-]+)\/?$/);
  if (m) return openFeature(m[1]);
  import('../bridge/native').then(({ native }) => native.openExternal(url));
}

/** Approval card: protected zone, always visible, never pluggable. */
export function ApprovalCard({ r, tool }: { r: ApprovalRequest; tool?: Tool }) {
  const [busy, setBusy] = useState<string | null>(null);
  const args = tool ? parseArgs(tool.arguments) : {};
  const shown = (typeof args.command === 'string' && args.command) || (typeof args.path === 'string' && args.path) || '';
  const d = tool ? describeTool(tool) : { verb: r.toolName, detail: '' };
  const act = async (decision: 'allowed-once' | 'rejected') => {
    setBusy(decision);
    await answerApproval(r, decision);
    setBusy(null);
  };
  return (
    <div class="a-approval">
      <Protected zone="approval">
        <div class="card" role="group" aria-label="需要你授权">
          <div class="title">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M8 1.75 2.75 3.75v4c0 3 2.25 5.25 5.25 6.5 3-1.25 5.25-3.5 5.25-6.5v-4Z" />
            </svg>
            允许{d.verb === '运行' ? '运行这条命令' : `「${d.verb}」`}？
          </div>
          {shown && <div class="cmd">{shown}</div>}
          <div class="reason">{describeApproval(r, 'zh')}</div>
          <div class="meta">只允许这一次；以后同样的操作还会再问你。</div>
          <div class="actions">
            <button class="btn" type="button" disabled={!!busy} onClick={() => act('rejected')}>
              {busy === 'rejected' ? '正在拒绝…' : '拒绝'}
            </button>
            <button class="btn primary" type="button" disabled={!!busy} onClick={() => act('allowed-once')}>
              {busy === 'allowed-once' ? '正在允许…' : '允许本次'}
            </button>
          </div>
        </div>
      </Protected>
    </div>
  );
}

function QuestionCard({ q }: { q: QuestionRequest }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const toggle = (i: number, label: string, multi: boolean) => {
    const cur = picked[i] ?? [];
    setPicked({ ...picked, [i]: multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] });
  };
  const ready = q.questions.every((x, i) => (picked[i]?.length ?? 0) > 0 || (other[i] ?? '').trim());
  return (
    <div class="msg assistant enter">
      <div class="callout question">
        {q.questions.map((x, i) => (
          <div key={i} class="q-block">
            {x.header && <div class="q-h">{x.header}</div>}
            <div class="callout-t">{x.question}</div>
            {x.detail && <div class="callout-d">{x.detail}</div>}
            <div class="chips">
              {x.options.map((o) => (
                <button class="toggle" type="button" key={o.label} aria-pressed={(picked[i] ?? []).includes(o.label)} title={o.description} onClick={() => toggle(i, o.label, x.multiSelect)}>
                  {o.label}
                </button>
              ))}
            </div>
            <input class="q-other" placeholder="其他（自己写）" value={other[i] ?? ''} onInput={(e) => setOther({ ...other, [i]: (e.target as HTMLInputElement).value })} />
          </div>
        ))}
        <div class="p-foot">
          <button class="btn" type="button" onClick={() => answerQuestion(q, null)}>
            不回答
          </button>
          <button
            class="btn primary"
            type="button"
            aria-disabled={!ready}
            onClick={() =>
              ready &&
              answerQuestion(
                q,
                q.questions.map((x, i) => ({ id: x.id, selected: picked[i] ?? [], ...((other[i] ?? '').trim() ? { custom: other[i].trim() } : {}) })),
              )
            }
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}

/** 「‹ 2 / 3 ›」: other versions of this message or reply (edits and regenerations). */
function VersionNav({ sib }: { sib: Siblings }) {
  const go = (d: number) => switchVersion(sib.ids[sib.index + d]);
  return (
    <span class="ver-nav" role="group" aria-label="版本">
      <button type="button" aria-label="上一个版本" disabled={sib.index === 0} onClick={() => go(-1)}>
        <MIc n="chevLeft" />
      </button>
      <span>
        {sib.index + 1} / {sib.ids.length}
      </span>
      <button type="button" aria-label="下一个版本" disabled={sib.index === sib.ids.length - 1} onClick={() => go(1)}>
        <MIc n="chevron" />
      </button>
    </span>
  );
}

function UserMsg({ user, text, sib }: { user: User; text: string; sib?: Siblings }) {
  const images = user.parts.filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image');
  const files = user.parts.filter((p): p is Extract<Part, { type: 'file' }> => p.type === 'file');
  const [selecting, setSelecting] = useState(false);
  const bubble = useRef<HTMLDivElement>(null);
  const press = useLongPress(() =>
    openPopover(bubble.current!, [
      { icon: 'copy', label: '复制', run: () => copyText(text) },
      {
        icon: 'select',
        label: '选择文本',
        run: () => {
          setSelecting(true);
          requestAnimationFrame(() => {
            const r = document.createRange();
            r.selectNodeContents(bubble.current!);
            const sel = getSelection();
            sel?.removeAllRanges();
            sel?.addRange(r);
          });
        },
      },
      { icon: 'edit', label: '修改', run: () => startEdit(user.seq, text) },
    ]),
  );
  useEffect(() => {
    if (!selecting) return;
    const off = () => setTimeout(() => !getSelection()?.toString() && setSelecting(false), 50);
    document.addEventListener('selectionchange', off);
    return () => document.removeEventListener('selectionchange', off);
  }, [selecting]);
  return (
    <div class="msg user">
      {images.length > 0 && currentId.value && (
        <div class="u-imgs">
          {images.map((p, i) => (
            <SessionImage key={i} sessionId={currentId.value!} part={p} />
          ))}
        </div>
      )}
      {(text || files.length > 0) && (
        <div class={`bubble ${selecting ? 'selecting' : ''}`} ref={bubble} {...(isMobile.value ? press : {})}>
          {text}
          {files.map((p, i) => (
            <span class="att" key={i}>
              {p.name ?? '文件'}
            </span>
          ))}
        </div>
      )}
      {user.sourceKind !== 'user' && <div class="steer">{user.sourceKind === 'schedule' ? '自动化任务' : '系统'}</div>}
      {sib && isMobile.value && (
        <div class="u-ver">
          <VersionNav sib={sib} />
        </div>
      )}
      <div class="u-actions">
        {sib && !isMobile.value && <VersionNav sib={sib} />}
        <button class="ib xs" type="button" aria-label="复制" onClick={() => copyText(text)}>
          <Ic n="IconCopyOutline16" />
        </button>
        <button class="ib xs" type="button" aria-label="修改后重发" onClick={() => startEdit(user.seq, text)}>
          <Ic n="IconEditOutline16" />
        </button>
      </div>
    </div>
  );
}

function startEdit(seq: number, text: string) {
  editing.value = { seq, original: text };
  draft.value = text;
  setTimeout(() => {
    const el = document.getElementById('input') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(text.length, text.length);
  }, 50);
}

function ReplyActions({ text, user, sib, forkSeq }: { text: string; user?: User; sib?: Siblings; forkSeq?: number }) {
  const [reading, setReading] = useState<(() => void) | null>(null);
  const mobile = isMobile.value;
  const toggleRead = () => {
    if (reading) {
      reading();
      return setReading(null);
    }
    const stopFn = speak(text, () => setReading(null));
    if (!stopFn) return showToast('这台设备不支持朗读');
    setReading(() => stopFn);
  };
  const regen = user ? () => void resendFrom(user.seq, user.text.replace(LOCATION_TAG, ''), 'regen') : undefined;
  const sid = currentId.value;
  const fork = sid && forkSeq !== undefined ? () => void forkConversation(sid, forkSeq) : undefined;
  const plug = pluginMessageActions.value.map((a) => (
    <button class={mobile ? 'm-act plug' : 'ib xs plug'} type="button" key={a.key} aria-label={a.label} title={a.label} onClick={() => a.run(text)}>
      {mobile ? <MIc n="sparkle" /> : <Ic n="FxPlugin" />}
    </button>
  ));
  if (mobile)
    return (
      <div class="m-acts">
        <button class="m-act" type="button" aria-label="复制" onClick={() => copyText(text)}>
          <MIc n="copy" />
        </button>
        {fork && (
          <button class="m-act" type="button" aria-label="分叉到新对话" title="分叉到新对话" onClick={fork}>
            <MIc n="fork" />
          </button>
        )}
        {canSpeak() && (
          <button class={`m-act ${reading ? 'on' : ''}`} type="button" aria-label={reading ? '停止朗读' : '朗读'} onClick={toggleRead}>
            <MIc n={reading ? 'stop' : 'speaker'} />
          </button>
        )}
        {plug}
        <span class="m-grow" />
        {sib && <VersionNav sib={sib} />}
        {regen && (
          <button class="m-act" type="button" aria-label="重新生成" onClick={regen}>
            <MIc n="refresh" />
          </button>
        )}
      </div>
    );
  return (
    <div class="a-actions">
      <button class="ib xs" type="button" aria-label="复制" onClick={() => copyText(text)}>
        <Ic n="IconCopyOutline16" />
      </button>
      {fork && (
        <button class="ib xs" type="button" aria-label="分叉到新对话" title="分叉到新对话" onClick={fork}>
          <MIc n="fork" />
        </button>
      )}
      {canSpeak() && (
        <button class="ib xs" type="button" aria-label={reading ? '停止朗读' : '朗读'} aria-pressed={!!reading} onClick={toggleRead}>
          <Ic n={reading ? 'IconStopFill16' : 'IconPlayMediaOutline16'} />
        </button>
      )}
      {sib && <VersionNav sib={sib} />}
      {regen && (
        <button class="ib xs" type="button" aria-label="重新生成" onClick={regen}>
          <Ic n="IconRefreshOutline16" />
        </button>
      )}
      {plug}
    </div>
  );
}

function TranslateBtn({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'on'>('idle');
  const go = async () => {
    if (state === 'on') return setState('idle');
    setState('busy');
    try {
      const out = await getClient().translateReasoning(text, currentId.value ?? undefined);
      setState('on');
      openOverlay({ kind: 'text', title: '思考过程（译文）', body: out });
    } catch (e) {
      setState('idle');
      showToast((e as Error).message || '翻译失败');
    }
  };
  return (
    <button class="tr-btn" type="button" onClick={go}>
      {state === 'busy' ? '正在翻译' : '翻译'}
    </button>
  );
}

/** Top of a chat brought in from a DeepSeek (or other) export. */
function ImportedNote({ from }: { from: { source: string; time: number } }) {
  const name = SOURCE_NAME[from.source as keyof typeof SOURCE_NAME] ?? '文件';
  const date = new Date(from.time).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  return <div class="older imported-note">从 {name} 导入 · {date}</div>;
}
