// 设定集's pieces outside its own pages: the 选作品 sheet (one conversation, a workspace, or new
// conversations by default), the chapter bar over the chat, and the stepper both it and the work
// page use. None of it shows unless 设定集 is installed and on.

import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  bindConversation,
  bindDefault,
  bindWorkspace,
  bindings,
  chapterName,
  forgetBindings,
  hasLore,
  loreView,
  mutate,
  readBinding,
  readBindings,
  refreshBinding,
  refreshWorks,
  workTitle,
  works,
  type Binding,
  type Bindings,
  type WorkSummary,
} from '../../lore/api';
import { askText, closeOverlay, currentId, errText, openOverlay, openPage, running, showToast } from '../../state/store';
import { MIc } from '../mobile/MIc';

export type Target = { kind: 'conversation'; sessionId: string } | { kind: 'workspace'; workspaceId: string } | { kind: 'default' };
const quote = (t: string | undefined) => (t ? `《${t}》` : '');

/**
 * A conversation's 更多 line (as last read): 「设定集：《长夜》」 while it uses a work, else
 * 「用设定集写这段对话」 (one tap: a new work named after the conversation, or the picker when
 * there are works already). DS Bot conversations get no line.
 */
export function conversationItem(sessionId: string, title?: string): { label: string; run: () => void } | null {
  const b = bindings.value[sessionId];
  if (b?.from === 'bot') return null;
  if (b?.work) return { label: `设定集：${quote(workTitle(b.work)) || '已选'}`, run: () => chooseWork({ kind: 'conversation', sessionId }) };
  return { label: '用设定集写这段对话', run: () => void startWithLore(sessionId, title) };
}

/** No works yet: name one (the conversation's title by default), use it here, and open it to add people. */
export async function startWithLore(sessionId: string, title?: string) {
  const list = works.value ?? (await refreshWorks().catch(() => null));
  if (list?.length) return chooseWork({ kind: 'conversation', sessionId });
  const name = (title || '').replace(/[《》]/g, '').trim().slice(0, 40) || '我的小说';
  askText(
    '给这本设定集起个名字',
    name,
    (t) =>
      void (async () => {
        try {
          const w = await mutate<WorkSummary>('create-work', { title: t.trim() });
          await bindConversation(sessionId, w.id);
          await Promise.all([refreshWorks(), refreshBinding(sessionId)]);
          showToast(`这段对话开始用《${w.title}》了，先加几个人物吧`);
          loreView.value = null;
          openPage(`lore:${w.id}`);
        } catch (e) {
          showToast(errText(e));
        }
      })(),
    { placeholder: '书名', ok: '开始' },
  );
}

/** Before showing a menu with the conversation's line: its binding (and the titles), if not known yet; waits at most 500 ms. */
export async function loreReady(sessionId: string) {
  if (sessionId in bindings.value && works.value) return;
  await Promise.race([Promise.all([refreshBinding(sessionId), works.value ? null : refreshWorks().catch(() => null)]), new Promise((r) => setTimeout(r, 500))]);
}

/** The sheet: which work [target] uses. */
export function chooseWork(target: Target, onDone?: () => void) {
  const title = target.kind === 'conversation' ? '这段对话用哪部设定集' : target.kind === 'workspace' ? '这个工作区用哪部设定集' : '新对话默认用哪部设定集';
  openOverlay({ kind: 'sheet', title, body: () => <WorkPicker target={target} onDone={onDone} /> });
}

interface Current {
  /** This layer's own setting: a work id, 'off', or null (follows the layer above). */
  own: string | null;
  /** What following would give: a work id or null (off). */
  inherited: string | null;
  bot: boolean;
}

async function readCurrent(t: Target): Promise<Current> {
  if (t.kind === 'conversation') {
    const b: Binding = await readBinding(t.sessionId);
    if (b.from === 'bot') return { own: null, inherited: null, bot: true };
    const own = b.conversation ?? null;
    if (own === null) return { own, inherited: b.work, bot: false };
    const all = await readBindings();
    const up = (b.workspaceId && all.workspaces[b.workspaceId]) || all.default;
    return { own, inherited: up === 'off' ? null : up, bot: false };
  }
  const all: Bindings = await readBindings();
  if (t.kind === 'workspace') return { own: all.workspaces[t.workspaceId] ?? null, inherited: all.default === 'off' ? null : all.default, bot: false };
  return { own: all.default, inherited: null, bot: false };
}

function WorkPicker({ target, onDone }: { target: Target; onDone?: () => void }) {
  const [cur, setCur] = useState<Current | null>(null);
  const [list, setList] = useState<WorkSummary[] | null>(works.value);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([readCurrent(target), refreshWorks()]).then(
      ([c, w]) => (setCur(c), setList(w)),
      (e) => setError(errText(e)),
    );
  }, []);
  if (error) return <div class="lo-pick-note">{error}</div>;
  if (!cur || !list) return <div class="lo-pick-note">正在读取…</div>;
  if (cur.bot) return <div class="lo-pick-note">DS Bot 的对话不用设定集</div>;

  const name = (id: string | null) => (id ? quote(list.find((w) => w.id === id)?.title) || '已删除的作品' : '关');
  const set = async (value: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      if (target.kind === 'conversation') {
        await bindConversation(target.sessionId, value);
        await refreshBinding(target.sessionId);
        showToast(value === 'off' || (value === null && cur.inherited === null) ? '这段对话不用设定集了' : value === null ? `这段对话跟随工作区：${name(cur.inherited)}` : `这段对话改用${name(value)}的设定`);
      } else if (target.kind === 'workspace') {
        await bindWorkspace(target.workspaceId, value);
        forgetBindings();
        showToast(value === null ? `这个工作区跟随默认：${name(cur.inherited)}` : value === 'off' ? '这个工作区不用设定集了' : `这个工作区改用${name(value)}`);
      } else {
        await bindDefault(value ?? 'off');
        forgetBindings();
        showToast(value === 'off' ? '新对话默认不用设定集' : `新对话默认用${name(value)}`);
      }
      if (currentId.value) void refreshBinding(currentId.value);
      closeOverlay();
      onDone?.();
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const opt = (value: string | null, label: string, key: string) => {
    const on = cur.own === value || (value === 'off' && cur.own === null && target.kind === 'default');
    return (
      <button class="lo-opt" type="button" role="radio" aria-checked={on} key={key} disabled={busy} onClick={() => void set(value)}>
        <span class={`lo-radio ${on ? 'on' : ''}`} />
        <span class="lo-opt-t">{label}</span>
      </button>
    );
  };
  // A conversation: 「跟随…」 only when following gives a work; otherwise 「不用设定集」 is just following (nothing)
  const conv = target.kind === 'conversation';
  const follows = !conv || cur.inherited !== null;
  return (
    <div class="lo-pick" role="radiogroup">
      {conv && follows && opt(null, `跟随工作区（现在：${name(cur.inherited)}）`, 'follow')}
      {target.kind === 'workspace' && opt(null, `跟随默认（现在：${name(cur.inherited)}）`, 'follow')}
      {list.map((w) => opt(w.id, `《${w.title}》`, w.id))}
      {opt(follows ? 'off' : null, conv ? '不用设定集' : '关', 'off')}
      <button
        class="lo-opt add"
        type="button"
        disabled={busy}
        onClick={() =>
          askText('新建作品', '', (t) =>
            void mutate<WorkSummary>('create-work', { title: t.trim() }).then(
              (w) => (void refreshWorks(), void set(w.id)),
              (e) => showToast(errText(e)),
            ),
          { placeholder: '书名', ok: '新建' })
        }
      >
        <MIc n="plus" />
        <span class="lo-opt-t">新建作品</span>
      </button>
      {target.kind === 'workspace' && <p class="lo-pick-note">只有在工作区里新建的对话才算这个工作区的。</p>}
      {target.kind === 'default' && <p class="lo-pick-note">工作区和单独的对话可以另外选，以它们为准。</p>}
    </div>
  );
}

// ---------------------------------------------------------------- the chapter stepper

/** A chapter that moves at once on screen and is saved after the taps stop (400 ms). */
export function useCursor(workId: string | null, chapter: number, onSaved?: (n: number) => void) {
  const [shown, setShown] = useState(chapter);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (pending.current === null) setShown(chapter);
  }, [chapter, workId]);
  const save = (n: number) => {
    if (!workId) return;
    pending.current = n;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const v = pending.current;
      if (v === null) return;
      mutate<WorkSummary>('set-cursor', { work: workId, chapter: v }).then(
        () => {
          if (pending.current === v) pending.current = null;
          void refreshWorks();
          onSaved?.(v);
        },
        (e) => {
          pending.current = null;
          setShown(chapter);
          showToast(errText(e));
        },
      );
    }, 400);
  };
  const to = (n: number) => {
    const v = Math.max(0, Math.floor(n));
    setShown(v);
    save(v);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { shown, to, step: (d: number) => to(shown + d) };
}

export function askChapter(current: number, onOk: (n: number) => void) {
  askText(
    '现在写到第几章',
    String(current),
    (v) => {
      const n = Number(v.trim());
      if (!Number.isInteger(n) || n < 0) return showToast('要是 0 或正整数（0 是开写前）');
      onOk(n);
    },
    { placeholder: '0 是开写前', ok: '好' },
  );
}

export function Stepper({ shown, step, onTapNumber, label = '章节' }: { shown: number; step: (d: number) => void; onTapNumber: () => void; label?: string }) {
  return (
    <span class="lo-step">
      <button class="lo-step-b" type="button" aria-label={`${label}减一`} disabled={shown <= 0} onClick={() => step(-1)}>
        <MIc n="chevLeft" />
      </button>
      <button class="lo-step-n" type="button" aria-label={`改${label}`} onClick={onTapNumber}>
        {chapterName(shown)}
      </button>
      <button class="lo-step-b next" type="button" aria-label={`${label}加一`} onClick={() => step(1)}>
        <MIc n="chevron" />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- the chapter bar over the chat

/** 「《长夜》 · 第 12 章」 while the open conversation uses a work; nothing at all otherwise. Tap: the sheet. */
export function ChapterBar() {
  const sid = currentId.value;
  const b = sid && hasLore() ? bindings.value[sid] : null;
  const w = b?.work ? works.value?.find((x) => x.id === b.work) : undefined;
  if (!sid || !w) return null;
  const open = () => openOverlay({ kind: 'sheet', title: `《${w.title}》`, body: () => <ChapterSheet workId={w.id} sessionId={sid} /> });
  return (
    <div class="lo-bar" role="group" aria-label="设定集">
      <button class="lo-bar-t" type="button" onClick={open}>
        <MIc n="book" />
        <span>
          《{w.title}》 · {chapterName(w.chapter)}
        </span>
        <MIc n="chevron" />
      </button>
    </div>
  );
}

/** The chapter bar's sheet: the chapter (AI moves it forward as it records; change it here when you go back), the work, another work. */
function ChapterSheet({ workId, sessionId }: { workId: string; sessionId: string }) {
  const w = works.value?.find((x) => x.id === workId);
  const { shown, step, to } = useCursor(workId, w?.chapter ?? 0);
  if (!w) return null;
  return (
    <div class="lo-pick">
      <div class="lo-opt static">
        <span class="lo-opt-t">现在写到</span>
        <Stepper shown={shown} step={step} onTapNumber={() => askChapter(shown, to)} />
      </div>
      <p class="lo-pick-note">AI 记下变化时会自己把章节往前推；回头改旧章节时在这里调回去。</p>
      <button class="lo-opt" type="button" onClick={() => (closeOverlay(), ((loreView.value = null), openPage(`lore:${w.id}`)))}>
        <MIc n="book" />
        <span class="lo-opt-t">打开《{w.title}》：人物和设定</span>
      </button>
      <button class="lo-opt" type="button" onClick={() => (closeOverlay(), chooseWork({ kind: 'conversation', sessionId }))}>
        <MIc n="layout" />
        <span class="lo-opt-t">换一本 / 不用设定集</span>
      </button>
    </div>
  );
}

/** Keeps the open conversation's work and chapter fresh: on opening it, and after each reply (the AI may move the chapter). */
export function watchLore() {
  let lastSid: string | null = null;
  let wasRunning = false;
  return effect(() => {
    if (!hasLore()) return;
    const sid = currentId.value;
    const r = running.value;
    const ended = wasRunning && !r;
    wasRunning = r;
    if (sid !== lastSid || ended) {
      lastSid = sid;
      if (!sid) return;
      void refreshBinding(sid).then((b) => {
        if (b?.work) void refreshWorks().catch(() => {});
      });
    }
  });
}
