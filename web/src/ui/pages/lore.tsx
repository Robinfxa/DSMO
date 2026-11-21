// 设定集 (dsmo-lore): a work's characters, setting entries, chapter-scoped states and relations,
// the chapter it's written up to, and importing SillyTavern cards and world books. Design:
// maidsh/LORE-DESIGN.md and the 设定集 UI notes; the engine's routes are in lore/api.ts.
//
// Pages: `lore` (the works), `lore:<work>` (a work: the chapter timeline over 人物 / 设定 / 关系 / 导入与设置),
// `lore-char:<work>:<id>` (a character: what's true at the chapter, 经历, 关系), `lore-card:<work>:<id|new>`
// (the card's form), `lore-entry:<work>:<id|new>`, `lore-import` and `lore-import:<work>` (three steps).
//
// The chapter timeline is the center: drag it and the cards, entries and relations show that chapter;
// it only looks, 「改成写到这里」 moves the chapter the AI goes by.
//
// Wording: 设定集, 作品, 人物, 设定, 状态, 关系, 现在写到第几章; 加进对话, AI 查的时候才看. Never
// lore / 注入 / 上下文 / token.

import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { native } from '../../bridge/native';
import {
  LoreError,
  chapterName,
  exportWork,
  forgetBindings,
  importFile,
  missingText,
  mutate,
  readBindings,
  readWork,
  refreshWorks,
  undoImport,
  workTitle,
  loreView as view,
  works,
  type CardField,
  type Character,
  type Entry,
  type ImportAnswer,
  type ImportBody,
  type Logic,
  type Op,
  type RecordResult,
  type Work,
  type WorkSummary,
} from '../../lore/api';
import { OP_MARK, byAi, defaultOp, historyOf, keyMode, pairHistory, relationAt, relationsAt, span, stateAt } from '../../lore/chapters';
import { askText, closeOverlay, confirm, errText, openOverlay, openPage, pages, showToast } from '../../state/store';
import { Switch } from '../common';
import { chooseWork } from '../lore/pick';
import { Avatar, StateChips, Timeline, marksOf, spanOf } from '../lore/timeline';
import { AutoSettings, PendingList } from '../lore/auto';
import { MIc } from '../mobile/MIc';

// ---------------------------------------------------------------- helpers

function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}
const len = (s: string) => [...s].length;

function useLoad<T>(read: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ text: string; missing: boolean } | null>(null);
  const reload = () =>
    read().then(
      (v) => (setData(v), setError(null)),
      (e) => setError({ text: errText(e), missing: e instanceof LoreError && e.missing }),
    );
  useEffect(() => void reload(), deps);
  return { data, setData, error, reload };
}

function Failed({ error, retry }: { error: { text: string; missing: boolean }; retry: () => void }) {
  if (error.missing) return <div class="plg-empty lo-missing">{missingText()}</div>;
  return (
    <div class="plg-empty-line">
      没能读取：{error.text}
      <button class="plg-text-btn" type="button" onClick={retry}>
        重试
      </button>
    </div>
  );
}

/** Runs a write; shows its error as it is. true when it went through. */
async function run<T>(fn: () => Promise<T>, done?: string | ((v: T) => string)): Promise<T | undefined> {
  try {
    const v = await fn();
    if (done) showToast(typeof done === 'string' ? done : done(v));
    return v;
  } catch (e) {
    showToast(errText(e));
    return undefined;
  }
}

/** Replaces the top page (new → its id after saving). */
const replaceTop = (id: string) => (pages.value = [...pages.value.slice(0, -1), id]);

function Counter({ value, max }: { value: string; max: number }) {
  const n = len(value);
  return <small class={`lo-count ${n > max ? 'over' : ''}`}>{`${n} / ${max}`}</small>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="sk-field lo-field">
      <span>{label}</span>
      {children}
      {hint && <small class="lo-hint">{hint}</small>}
    </label>
  );
}

/** A text input that stops at [max] characters and says how many are used. */
function Text({ value, onInput, max, placeholder, area, rows = 4 }: { value: string; onInput: (v: string) => void; max: number; placeholder?: string; area?: boolean; rows?: number }) {
  const cut = (v: string) => [...v].slice(0, max).join('');
  return (
    <div class="lo-text">
      {area ? (
        <textarea class="sf-input area" rows={rows} placeholder={placeholder} value={value} onInput={(e) => onInput(cut((e.target as HTMLTextAreaElement).value))} />
      ) : (
        <input class="sf-input" type="text" placeholder={placeholder} value={value} onInput={(e) => onInput(cut((e.target as HTMLInputElement).value))} />
      )}
      <Counter value={value} max={max} />
    </div>
  );
}

function NumberInput({ value, onInput, placeholder, label }: { value: number | undefined; onInput: (v: number | undefined) => void; placeholder?: string; label?: string }) {
  return (
    <input
      class="sf-input lo-num"
      type="text"
      inputMode="numeric"
      aria-label={label}
      placeholder={placeholder}
      value={value === undefined ? '' : String(value)}
      onInput={(e) => {
        const t = (e.target as HTMLInputElement).value.replace(/[^\d]/g, '');
        onInput(t === '' ? undefined : Number(t));
      }}
    />
  );
}

/** Chips plus an input: Enter, 、 or ， adds one. */
function Tags({ values, onChange, max, maxLen, placeholder }: { values: string[]; onChange: (v: string[]) => void; max: number; maxLen: number; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const parts = raw
      .split(/[、，,\n]/)
      .map((x) => [...x.trim()].slice(0, maxLen).join(''))
      .filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.includes(p) && next.length < max) next.push(p);
    if (parts.length && next.length === values.length && values.length >= max) showToast(`最多 ${max} 个`);
    onChange(next);
    setDraft('');
  };
  return (
    <div class="lo-tags">
      {values.map((v) => (
        <span class="lo-tag" key={v}>
          {v}
          <button type="button" aria-label={`去掉${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            <MIc n="x" />
          </button>
        </span>
      ))}
      {values.length < max && (
        <input
          class="lo-tag-in"
          type="text"
          enterKeyHint="done"
          placeholder={values.length ? '' : placeholder}
          value={draft}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            if (/[、，,]/.test(v)) add(v);
            else setDraft([...v].slice(0, maxLen).join(''));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      )}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="lo-chips" role="radiogroup" aria-label={label}>
      {options.map(([v, t]) => (
        <button type="button" role="radio" key={v} aria-checked={value === v} onClick={() => onChange(v)}>
          {t}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 作品列表

const defaultWork = signal<string | null>(null);


export function LoreWorksPage() {
  const { data: list, error, reload } = useLoad(async () => {
    const [w, b] = await Promise.all([refreshWorks(), readBindings()]);
    defaultWork.value = b.default;
    return w;
  });
  if (error) return <Failed error={error} retry={reload} />;
  if (!list) return <div class="plg-empty-line">正在读取…</div>;
  const def = defaultWork.value;
  const newWork = () =>
    askText(
      '新建作品',
      '',
      (t) => void run(() => mutate<WorkSummary>('create-work', { title: t.trim() })).then((w) => w && (void refreshWorks(), (view.value = null), openPage(`lore:${w.id}`))),
      { placeholder: '书名', ok: '新建' },
    );
  if (!list.length)
    return (
      <div class="plg lo">
        <div class="plg-group lo-empty">
          <MIc n="book" />
          <p>
            给你的小说建一份设定：人物、地点、规矩，还有每一章写到时谁在哪、受了什么伤。AI 写的时候会按这一章的样子来，不会前后矛盾。
            <span class="lo-tip">最快的开始：在要写小说的那段对话上长按（或点「⋯」），选「用设定集写这段对话」。</span>
          </p>
          <div class="plg-actions">
            <button class="plg-btn pri" type="button" onClick={newWork}>
              新建作品
            </button>
            <button class="plg-btn" type="button" onClick={() => openPage('lore-import')}>
              导入角色卡或世界书
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div class="plg lo">
      <p class="plg-note">在对话上长按（或点「⋯」）选「用设定集写这段对话」，那段对话就会用上它。</p>
      <section class="plg-sec">
        <h2 class="plg-sec-t">作品 · {list.length}</h2>
        <div class="plg-group">
          {list.map((w) => (
            <button class="plg-row lo-work" type="button" key={w.id} onClick={() => ((view.value = null), openPage(`lore:${w.id}`))}>
              <div class="plg-row-m">
                <div class="plg-row-t">《{w.title}》</div>
                <div class="plg-row-s">
                  {w.chapter > 0 ? `写到第 ${w.chapter} 章` : '开写前'} · {w.characters} 个人物 · {w.entries} 条设定
                </div>
                <div class="plg-row-s faint">{ago(w.updatedAt)}</div>
              </div>
              <MIc n="chevron" />
            </button>
          ))}
        </div>
      </section>
      <details class="lo-adv" open={!!def && def !== 'off'}>
        <summary>高级</summary>
        <div class="plg-group">
          <button class="plg-row" type="button" onClick={() => chooseWork({ kind: 'default' }, () => void reload())}>
            <div class="plg-row-m">
              <div class="plg-row-t">所有新对话默认用</div>
            </div>
            <span class="plg-row-v">{def && def !== 'off' ? `《${workTitle(def) ?? '?'}》` : '不用'}</span>
            <MIc n="chevron" />
          </button>
        </div>
        <p class="plg-note">一般不用设。整个工作区都写同一本时，可以在「设置 › 工作区」里给工作区选；单独的对话以它自己的选择为准。</p>
      </details>
    </div>
  );
}
export function LoreWorksActions() {
  return (
    <>
      <button class="ib xl" type="button" aria-label="导入" onClick={() => openPage('lore-import')}>
        <MIc n="download" />
      </button>
      <button
        class="ib xl"
        type="button"
        aria-label="新建作品"
        onClick={() =>
          askText(
            '新建作品',
            '',
            (t) => void run(() => mutate<WorkSummary>('create-work', { title: t.trim() })).then((w) => w && (void refreshWorks(), (view.value = null), openPage(`lore:${w.id}`))),
            { placeholder: '书名', ok: '新建' },
          )
        }
      >
        <MIc n="plus" />
      </button>
    </>
  );
}

// ---------------------------------------------------------------- 作品详情

type Tab = 'people' | 'lore' | 'rel' | 'more';
const workTab = signal<Tab>('people');
/** The open work, shared by its pages (read again on every visit). */
const openWork = signal<Work | null>(null);

function useWork(id: string) {
  const r = useLoad(() => readWork(id), [id]);
  useEffect(() => {
    if (r.data) openWork.value = r.data;
  }, [r.data]);
  return r;
}

export function loreWorkTitle(id: string) {
  const t = (openWork.value?.id === id ? openWork.value.title : undefined) ?? workTitle(id);
  return t ? `《${t}》` : '作品';
}

export function LoreWorkActions({ id }: { id: string }) {
  return (
    <button class="ib xl" type="button" aria-label="作品的更多操作" onClick={() => workMenu(id)}>
      <MIc n="more" />
    </button>
  );
}

function rename(id: string, title: string, after: () => void) {
  askText('改名', title, (t) => void run(() => mutate('rename-work', { id, title: t.trim() }), '已改名').then((v) => v && (void refreshWorks(), after())), { ok: '改名' });
}

function workMenu(id: string) {
  const w = openWork.value?.id === id ? openWork.value : null;
  const title = w?.title ?? workTitle(id) ?? '';
  const item = (icon: Parameters<typeof MIc>[0]['n'], label: string, fn: () => void, danger = false) => (
    <button class={`lo-opt ${danger ? 'danger' : ''}`} type="button" onClick={() => (closeOverlay(), fn())}>
      <MIc n={icon} />
      <span class="lo-opt-t">{label}</span>
    </button>
  );
  openOverlay({
    kind: 'sheet',
    title: `《${title}》`,
    body: () => (
      <div class="lo-pick">
        {item('edit', '改名', () => rename(id, title, () => void readWork(id).then((x) => (openWork.value = x))))}
        {item('download', '导入到这部作品', () => openPage(`lore-import:${id}`))}
        {item('share', '导出', () => exportMenu(id, title))}
        {item(
          'trash',
          '删除作品',
          () =>
            confirm(`删除《${title}》？`, '里面的人物、设定和状态都会删掉，不能恢复。用它的对话和工作区会退回上一层。建议先导出。', '删除', async () => {
              if (await run(() => mutate('delete-work', { id }), `已删除《${title}》`)) {
                forgetBindings();
                void refreshWorks();
                pages.value = pages.value.filter((p) => !p.startsWith(`lore:${id}`) && !p.includes(`:${id}:`) && p !== `lore-import:${id}`);
              }
            }),
          true,
        )}
      </div>
    ),
  });
}

function exportMenu(id: string, title: string) {
  const save = async (format: 'native' | 'st-worldbook') => {
    closeOverlay();
    const v = await run(() => exportWork(id, format));
    if (v === undefined) return;
    const name = `${title}.${format === 'native' ? 'lore' : 'worldbook'}.json`;
    try {
      await native.saveFile(name, 'application/json', new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' }));
      showToast(`已导出 ${name}`);
    } catch (e) {
      showToast(errText(e));
    }
  };
  openOverlay({
    kind: 'sheet',
    title: '导出',
    body: () => (
      <div class="lo-pick">
        <button class="lo-opt two" type="button" onClick={() => void save('native')}>
          <span class="lo-opt-t">设定集原样</span>
          <span class="lo-opt-s">{title}.lore.json：人物、设定、状态、关系都在，以后能原样导回</span>
        </button>
        <button class="lo-opt two" type="button" onClick={() => void save('st-worldbook')}>
          <span class="lo-opt-t">酒馆世界书</span>
          <span class="lo-opt-s">{title}.worldbook.json：能在 SillyTavern 里直接导入。状态和关系酒馆里没有对应，不包含</span>
        </button>
      </div>
    ),
  });
}

function useView(w: Work | null) {
  const ch = w && view.value?.work === w.id ? view.value.ch : (w?.cursor.chapter ?? 0);
  return [ch, (n: number) => w && (view.value = { work: w.id, ch: Math.max(0, n) })] as const;
}
/** Moves the written-up-to chapter; the AI goes by it. */
async function writeHere(w: Work, ch: number, after: () => void) {
  if (await run(() => mutate('set-cursor', { work: w.id, chapter: ch }), `现在写到${chapterName(ch)}`)) {
    void refreshWorks();
    after();
  }
}

/** A work opened afresh starts on 人物; coming back to the same one keeps its tab. */
let lastWork = '';

export function LoreWorkPage({ id }: { id: string }) {
  if (lastWork !== id) {
    lastWork = id;
    workTab.value = 'people';
  }
  const { data: w, error, reload } = useWork(id);
  const [ch, setCh] = useView(w);
  if (error) return <Failed error={error} retry={reload} />;
  if (!w) return <div class="plg-empty-line">正在读取…</div>;
  const t = workTab.value;
  const marks = marksOf(w);
  const changes = w.states.filter((s) => !s.supersededBy).length + w.relations.filter((r) => !r.supersededBy).length;
  return (
    <div class="plg lo">
      <div class="lo-hero">
        <button class="lo-title" type="button" aria-label="改书名" onClick={() => rename(id, w.title, () => void reload())}>
          《{w.title}》
        </button>
        <div class="lo-hero-s">
          {w.characters.length} 个人物 · {w.lore.length} 条设定 · {changes} 处变化
        </div>
        <Timeline max={spanOf(w.cursor.chapter, marks)} marks={marks} cursor={w.cursor.chapter} value={ch} onChange={setCh} onWriteHere={() => void writeHere(w, ch, () => void reload())} />
      </div>
      <GettingStarted w={w} />
      <PendingList work={w} onChanged={() => void reload()} />
      <div class="plg-seg lo-tabs" role="tablist">
        {(
          [
            ['people', '人物'],
            ['lore', '设定'],
            ['rel', '关系'],
            ['more', '导入与设置'],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button type="button" role="tab" key={k} aria-selected={t === k} onClick={() => (workTab.value = k)}>
            {label}
          </button>
        ))}
      </div>
      {t === 'people' && <People w={w} chapter={ch} />}
      {t === 'lore' && <Entries w={w} chapter={ch} />}
      {t === 'rel' && <Relations w={w} chapter={ch} reload={() => void reload()} />}
      {t === 'more' && <More w={w} reload={() => void reload()} />}
    </div>
  );
}

// ---------------------------------------------------------------- 第一次：三步

const guideKey = (id: string) => `dsmo.lore.guide.${id}`;
const guideHidden = (id: string) => {
  try {
    return localStorage.getItem(guideKey(id)) === '1';
  } catch {
    return false;
  }
};

/** Until a work has a character, an entry and a conversation using it: three steps, each ticked off as it's done. */
function GettingStarted({ w }: { w: Work }) {
  const [used, setUsed] = useState<boolean | null>(null);
  const [hidden, setHidden] = useState(() => guideHidden(w.id));
  useEffect(() => {
    readBindings().then(
      (b) => setUsed(b.default === w.id || Object.values(b.conversations).includes(w.id) || Object.values(b.workspaces).includes(w.id)),
      () => setUsed(false),
    );
  }, [w.id]);
  const people = w.characters.length > 0;
  const lore = w.lore.length > 0;
  if (hidden || used === null || (people && lore && used)) return null;
  const hide = () => {
    try {
      localStorage.setItem(guideKey(w.id), '1');
    } catch {
      /* 只是这次不显示 */
    }
    setHidden(true);
  };
  const step = (done: boolean, n: number, title: string, body: string, action?: [string, () => void]) => (
    <li class={`lo-guide-s ${done ? 'done' : ''}`}>
      <span class="lo-guide-n">{done ? '✓' : n}</span>
      <div class="lo-guide-m">
        <div class="lo-guide-t">{title}</div>
        <div class="lo-guide-b">{body}</div>
        {!done && action && (
          <button class="plg-text-btn" type="button" onClick={action[1]}>
            {action[0]}
          </button>
        )}
      </div>
    </li>
  );
  return (
    <div class="plg-group lo-guide">
      <div class="lo-guide-h">三步开始</div>
      <ol>
        {step(people, 1, '加一个人物', '名字、别名，再写一句最能认出 TA 的话。', ['加人物', () => openPage(`lore-card:${w.id}:new`)])}
        {step(lore, 2, '加一条设定', '地点、组织、规矩……写上关键词，对话里提到就会带上。', ['加设定', () => openPage(`lore-entry:${w.id}:new`)])}
        {step(
          used,
          3,
          '在对话里用它',
          used ? '已经有对话在用了。' : '在要写小说的对话上长按（或点「⋯」），选「用设定集写这段对话」，再选这一本。之后正常写：提到谁，AI 就会看到谁的设定；人物受伤、换地方，AI 会自己记下。',
        )}
      </ol>
      <button class="plg-text-btn faint" type="button" onClick={hide}>
        知道了，不再显示
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 人物

const sortPeople = (list: Character[]) => [...list].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'main' ? -1 : 1) || (a.debut ?? 0) - (b.debut ?? 0) || a.createdAt - b.createdAt);
const notYet = (c: Character, ch: number) => c.debut !== undefined && c.debut > ch;

function People({ w, chapter }: { w: Work; chapter: number }) {
  const [q, setQ] = useState('');
  const list = sortPeople(w.characters).filter((c) => !q.trim() || c.name.includes(q.trim()) || c.aliases.some((a) => a.includes(q.trim())));
  return (
    <>
      {w.characters.length > 6 && (
        <div class="hist-find plg-find">
          <MIc n="search" />
          <input type="search" placeholder="找人物（名字或别名）" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
      )}
      <div class="lo-grid">
        {list.map((c) => {
          const later = notYet(c, chapter);
          return (
            <button class={`lo-card ${later ? 'later' : ''}`} type="button" key={c.id} onClick={() => openPage(`lore-char:${w.id}:${c.id}`)}>
              <div class="lo-card-h">
                <Avatar name={c.name} dim={later} />
                <div class="lo-card-n">
                  <span class="lo-card-t">{c.name}</span>
                  <span class="lo-card-tags">
                    {c.tier === 'main' && <em class="lo-tag-s main">主要</em>}
                    {c.secret && <em class="lo-tag-s">隐藏</em>}
                  </span>
                </div>
              </div>
              <div class={`lo-card-s ${c.card.summary ? '' : 'faint'}`}>{c.card.summary || '还没写简介'}</div>
              {later ? <div class="lo-chip-empty">第 {c.debut} 章登场</div> : <StateChips states={stateAt(w, c.id, chapter)} max={3} />}
            </button>
          );
        })}
        <button class="lo-card add" type="button" onClick={() => openPage(`lore-card:${w.id}:new`)}>
          <MIc n="plus" />
          <span>新人物</span>
        </button>
      </div>
      {!w.characters.length && <p class="plg-note">先加几个人物。之后在人物里记下「第几章起受了伤、去了哪」，拖动上面的时间轴就能看到每一章时的样子。</p>}
      {w.characters.length > 0 && !list.length && <div class="plg-empty-line">没找到。</div>}
    </>
  );
}

const CARD_FIELDS: [CardField, string][] = [
  ['appearance', '外貌'],
  ['personality', '性格'],
  ['background', '背景'],
  ['voice', '说话方式'],
  ['extra', '其他'],
];
type CharForm = { name: string; aliases: string[]; summary: string; main: boolean; secret: boolean; debut?: number } & Partial<Record<CardField, string>>;
const formOf = (c?: Character): CharForm => ({
  name: c?.name ?? '',
  aliases: c?.aliases ?? [],
  summary: c?.card.summary ?? '',
  main: c?.tier === 'main',
  secret: !!c?.secret,
  debut: c?.debut,
  ...Object.fromEntries(CARD_FIELDS.map(([k]) => [k, c?.card[k] ?? ''])),
});

/** A character: who they are, what's true at the chapter being looked at, how they got there, and who they are to the others. */
export function LoreCharacterPage({ work, id }: { work: string; id: string }) {
  const { data: w, setData, error, reload } = useWork(work);
  const [ch, setCh] = useView(w);
  if (error) return <Failed error={error} retry={reload} />;
  if (!w) return <div class="plg-empty-line">正在读取…</div>;
  const c = w.characters.find((x) => x.id === id);
  if (!c) return <div class="plg-empty-line">这个人物已经不在了。</div>;
  const refresh = () => readWork(work).then(setData);
  const marks = marksOf(w, c.id);
  const later = notYet(c, ch);
  const now = stateAt(w, c.id, ch);
  const others = w.characters.filter((x) => x.id !== c.id).flatMap((o) => relationAt(w, c.id, o.id, ch).map((r) => ({ ...r, other: o })));
  return (
    <div class="plg lo">
      <div class="lo-who">
        <Avatar name={c.name} size="l" />
        <div class="lo-who-m">
          <div class="lo-who-n">
            {c.name}
            {c.tier === 'main' && <em class="lo-tag-s main">主要</em>}
            {c.secret && <em class="lo-tag-s">隐藏</em>}
          </div>
          {c.aliases.length > 0 && <div class="lo-faint">也叫 {c.aliases.join('、')}</div>}
          <div class={`lo-who-s ${c.card.summary ? '' : 'faint'}`}>{c.card.summary || '还没写简介：写一句最能认出这个人的话'}</div>
        </div>
        <button class="lo-edit" type="button" onClick={() => openPage(`lore-card:${w.id}:${c.id}`)}>
          <MIc n="edit" />
          编辑
        </button>
      </div>
      <div class="lo-panel">
        <Timeline compact max={spanOf(w.cursor.chapter, marks)} marks={marks} cursor={w.cursor.chapter} value={ch} onChange={setCh} />
        <div class="lo-panel-t">{chapterName(ch)}时</div>
        {later ? <div class="lo-chip-empty">还没登场（第 {c.debut} 章登场）</div> : <StateChips states={now} max={12} empty="这一章时还没记过什么" />}
        <button class="lo-add" type="button" onClick={() => recordSheet(w, c, ch, refresh)}>
          <MIc n="plus" />
          记一条变化
        </button>
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">经历</h2>
        <Story w={w} c={c} chapter={ch} onPick={setCh} onChanged={refresh} />
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">{chapterName(ch)}时的关系</h2>
        <div class="plg-group">
          {others.map((r) => (
            <button class="lo-pair" type="button" key={r.id} onClick={() => pairSheet(w, c.id, r.other.id, refresh)}>
              <Avatar name={r.other.name} size="s" />
              <span class="lo-pair-n">{r.other.name}</span>
              <span class="lo-pair-v">
                {r.key !== '关系' ? `${r.key}：` : ''}
                {r.value}
              </span>
            </button>
          ))}
          {!others.length && <div class="plg-empty-line">这一章时还没记关系。</div>}
          <button class="plg-link" type="button" disabled={w.characters.length < 2} onClick={() => relationSheet(w, c.id, ch, refresh)}>
            <span>{w.characters.length < 2 ? '再加一个人物，才能记关系' : '记一条关系'}</span>
            <MIc n="plus" />
          </button>
        </div>
      </section>
    </div>
  );
}

/** How [c] got here: every change, chapter by chapter; the ones after the chapter being looked at are faint. */
function Story({ w, c, chapter, onPick, onChanged }: { w: Work; c: Character; chapter: number; onPick: (n: number) => void; onChanged: () => Promise<unknown> }) {
  const hist = historyOf(w, c.id);
  const by = new Map<number, typeof hist>();
  for (const s of hist) by.set(s.from, [...(by.get(s.from) ?? []), s]);
  const chapters = [...by.keys()].sort((a, b) => a - b);
  if (c.debut !== undefined && !by.has(c.debut)) chapters.push(c.debut), chapters.sort((a, b) => a - b);
  if (!chapters.length) return <div class="plg-group"><div class="plg-empty-line">还没有经历。点「记一条变化」，比如「第 11 章起 伤势：左臂刀伤」。</div></div>;
  const remove = (id: string, what: string) =>
    confirm(`删除这条记录？`, what, '删除', () => void run(() => mutate('delete-state', { work: w.id, id }), '已删除').then((v) => v && onChanged()));
  return (
    <ol class="lo-story">
      {chapters.map((n) => (
        <li class={`lo-step-ch ${n > chapter ? 'future' : ''} ${n === chapter ? 'here' : ''}`} key={n}>
          <button class="lo-step-node" type="button" onClick={() => onPick(n)}>
            {chapterName(n)}
          </button>
          <div class="lo-step-items">
            {n === c.debut && <div class="lo-step-i debut">登场</div>}
            {(by.get(n) ?? []).map((s) => (
              <div class="lo-step-i" key={s.id}>
                <div class="lo-step-m">
                  <span class={`lo-op ${s.op}`}>{{ replace: '变成', add: '多了', remove: '没了' }[s.op]}</span>
                  <b>{s.key}</b> {s.value}
                  {s.until !== undefined && <span class="lo-faint"> （到第 {s.until} 章）</span>}
                  {byAi(s.source) && <em class="lo-tag-s ai">AI 记的</em>}
                  {s.evidence && <div class="lo-quote">「{s.evidence}」</div>}
                </div>
                <button class="lo-x" type="button" aria-label={`删除 ${s.key} ${s.value}`} onClick={() => remove(s.id, `${chapterName(s.from)}起 ${s.key} ${OP_MARK[s.op]} ${s.value}`)}>
                  <MIc n="x" />
                </button>
              </div>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The card: its own page, the fields grouped by what they're for. */
export function LoreCardPage({ work, id }: { work: string; id: string }) {
  const { data: w, setData, error, reload } = useWork(work);
  if (error) return <Failed error={error} retry={reload} />;
  if (!w) return <div class="plg-empty-line">正在读取…</div>;
  const c = id === 'new' ? undefined : w.characters.find((x) => x.id === id);
  if (id !== 'new' && !c) return <div class="plg-empty-line">这个人物已经不在了。</div>;
  return <CardEditor w={w} c={c} key={c?.id ?? 'new'} onSaved={() => readWork(work).then(setData)} />;
}

function CardEditor({ w, c, onSaved }: { w: Work; c?: Character; onSaved: () => Promise<unknown> }) {
  const base = useMemo(() => formOf(c), [c]);
  const [f, setF] = useState<CharForm>(base);
  const [more, setMore] = useState(CARD_FIELDS.some(([k]) => base[k]));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CharForm>(k: K, v: CharForm[K]) => setF({ ...f, [k]: v });
  const changed = JSON.stringify(f) !== JSON.stringify(base);
  const save = async () => {
    if (!f.name.trim()) return showToast('名字要填');
    setBusy(true);
    const body: Record<string, unknown> = { work: w.id };
    const card: Record<string, string> = {};
    if (!c || f.summary !== base.summary) card.summary = f.summary.trim();
    for (const [k] of CARD_FIELDS) if (!c || f[k] !== base[k]) card[k] = (f[k] ?? '').trim();
    if (c) body.id = c.id;
    if (!c || f.name !== base.name) body.name = f.name.trim();
    if (!c || JSON.stringify(f.aliases) !== JSON.stringify(base.aliases)) body.aliases = f.aliases;
    if (!c || f.main !== base.main) body.tier = f.main ? 'main' : 'side';
    if (!c || f.secret !== base.secret) body.secret = f.secret;
    if (!c || f.debut !== base.debut) body.debut = f.debut ?? null;
    if (Object.keys(card).length) body.card = card;
    const saved = await run(() => mutate<Character>('upsert-character', body), c ? '已保存' : `已添加${f.name.trim()}`);
    setBusy(false);
    if (!saved) return;
    void refreshWorks();
    await onSaved();
    // a new one: on to their page; an edit: back to it
    if (!c) replaceTop(`lore-char:${w.id}:${saved.id}`);
    else pages.value = pages.value.slice(0, -1);
  };
  return (
    <div class="plg lo">
      <div class="lo-who edit">
        <Avatar name={f.name || '？'} size="l" />
        <div class="lo-who-m">
          <Text value={f.name} onInput={(v) => set('name', v)} max={20} placeholder="名字，比如 沈砚" />
        </div>
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">每轮都带的</h2>
        <div class="plg-group sk-form">
          <Field label="一句话简介" hint="AI 每轮只看这一句：写最能认出这个人的话">
            <Text value={f.summary} onInput={(v) => set('summary', v)} max={120} placeholder="落魄琴师，嘴冷心热。" />
          </Field>
          <Field label="别名" hint="对话里提到别名也认得。一个字的别名不会自动认出（太容易误中）">
            <Tags values={f.aliases} onChange={(v) => set('aliases', v)} max={8} maxLen={20} placeholder="阿砚（回车加一个）" />
          </Field>
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">在名单里</h2>
        <div class="plg-group">
          <div class="plg-row static lo-sw">
            <div class="plg-row-m">
              <div class="plg-row-t">主要人物</div>
              <div class="plg-row-s">排在名单前面</div>
            </div>
            <Switch on={f.main} label="主要人物" onChange={(v) => set('main', v)} />
          </div>
          <div class="plg-row static lo-sw">
            <div class="plg-row-m">
              <div class="plg-row-t">隐藏人物</div>
              <div class="plg-row-s">揭晓前不出现在名单和每轮设定里，AI 要查才看得到</div>
            </div>
            <Switch on={f.secret} label="隐藏人物" onChange={(v) => set('secret', v)} />
          </div>
          <div class="plg-row static lo-sw">
            <div class="plg-row-m">
              <div class="plg-row-t">第几章登场</div>
              <div class="plg-row-s">之前不出现在名单里；空着是一开始就在</div>
            </div>
            <NumberInput value={f.debut} onInput={(v) => set('debut', v)} placeholder="一开始" label="第几章登场" />
          </div>
        </div>
      </section>
      <section class="plg-sec">
        <button class="lo-more plain" type="button" aria-expanded={more} onClick={() => setMore(!more)}>
          <span>
            外貌、性格、背景、说话方式
            <small>AI 查的时候才看，写多少都不占每轮的地方</small>
          </span>
          <MIc n="chevronDown" />
        </button>
        {more && (
          <div class="plg-group sk-form">
            {CARD_FIELDS.map(([k, label]) => (
              <Field label={label} key={k}>
                <Text value={f[k] ?? ''} onInput={(v) => set(k, v)} max={1500} area rows={3} />
              </Field>
            ))}
          </div>
        )}
      </section>
      <div class="lo-savebar">
        {c && changed && (
          <button class="plg-btn" type="button" onClick={() => setF(base)}>
            撤销修改
          </button>
        )}
        <button class="plg-btn pri" type="button" disabled={busy || !f.name.trim() || (!!c && !changed)} onClick={() => void save()}>
          {c ? '保存' : '添加人物'}
        </button>
      </div>
      {c && (
        <div class="plg-group lo-danger">
          <button
            class="plg-link danger"
            type="button"
            onClick={() =>
              confirm(`删除${c.name}？`, 'TA 的状态和关系也会一起删掉。', '删除', async () => {
                if (await run(() => mutate('delete-character', { work: w.id, id: c.id }), `已删除${c.name}`)) {
                  void refreshWorks();
                  pages.value = pages.value.filter((p) => p !== `lore-char:${w.id}:${c.id}` && p !== `lore-card:${w.id}:${c.id}`);
                }
              })
            }
          >
            <span>删除人物</span>
          </button>
        </div>
      )}
    </div>
  );
}

const QUICK_KEYS = ['位置', '伤势', '持有', '身份', '立场', '境界', '是否在世'];
const OP_HELP: Record<Op, string> = { replace: '换成新的（位置、伤势这种只有一个的）', add: '加进去（持有物这种可以有好几样的）', remove: '从里面拿掉一样' };

function recordSheet(w: Work, c: Character, ch: number, after: () => Promise<unknown>) {
  openOverlay({ kind: 'sheet', title: `${c.name}：记一条变化`, body: () => <RecordForm w={w} c={c} chapter={ch} onDone={(ok) => (closeOverlay(), ok && void after())} /> });
}

function RecordForm({ w, c, chapter, onDone }: { w: Work; c: Character; chapter: number; onDone: (ok: boolean) => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [op, setOp] = useState<Op>('replace');
  const [touchedOp, setTouchedOp] = useState(false);
  const [from, setFrom] = useState<number | undefined>(chapter);
  const [until, setUntil] = useState<number | undefined>(undefined);
  const [evidence, setEvidence] = useState('');
  const [more, setMore] = useState(false);
  const pickKey = (k: string) => {
    setKey(k);
    if (!touchedOp) setOp(defaultOp(w, c.id, k.trim()));
  };
  const mode = keyMode(w, c.id, key.trim());
  const listy = op !== 'replace';
  const current = stateAt(w, c.id, from ?? chapter).find((s) => s.key === key.trim())?.value;
  const submit = async () => {
    const r = await run(() =>
      mutate<RecordResult>('record-states', {
        work: w.id,
        chapter: from ?? w.cursor.chapter,
        changes: [{ subject: c.name, key: key.trim(), value: value.trim(), op, ...(until !== undefined ? { until } : {}), ...(evidence.trim() ? { evidence: evidence.trim() } : {}) }],
      }),
    );
    if (!r) return;
    if (r.errors.length) return showToast(r.errors.join('；'));
    showToast(r.cursorMoved ? `记下了，现在写到第 ${r.chapter} 章` : '记下了');
    if (r.cursorMoved) void refreshWorks();
    // look at the chapter it's from, so the change shows
    view.value = { work: w.id, ch: from ?? w.cursor.chapter };
    onDone(true);
  };
  return (
    <div class="lo-sheetform plg">
      <div class="lo-sf-row">
        <span class="lo-sf-l">从</span>
        <NumberInput value={from} onInput={setFrom} label="从第几章" />
        <span class="lo-sf-l">章起</span>
      </div>
      <div class="lo-sf-l top">哪一项</div>
      <div class="lo-chips">
        {QUICK_KEYS.map((k) => (
          <button type="button" key={k} aria-pressed={key === k} onClick={() => pickKey(k)}>
            {k}
          </button>
        ))}
      </div>
      <Text value={key} onInput={pickKey} max={12} placeholder="或者自己写，比如 心事" />
      {key.trim() && (
        <>
          {/* a list (持有…): got one or lost one; one value (位置…): just what it is now. All three ways under 高级 */}
          {listy && !more && (
            <>
              <div class="lo-sf-l top">
                「{key.trim()}」可以有好几样{current ? <span class="lo-faint">（那时有：{current}）</span> : ''}
              </div>
              <div class="lo-ops two" role="radiogroup" aria-label="得到还是失去">
                {(['add', 'remove'] as Op[]).map((o) => (
                  <button type="button" role="radio" key={o} aria-checked={op === o} onClick={() => (setOp(o), setTouchedOp(true))}>
                    <b>{o === 'add' ? '多了这个' : '没了这个'}</b>
                  </button>
                ))}
              </div>
            </>
          )}
          {!listy && !more && current && <div class="lo-faint">那时是：{current}</div>}
          <div class="lo-sf-l top">{op === 'replace' ? '现在是什么' : op === 'add' ? '多了什么' : '没了什么'}</div>
          <Text value={value} onInput={setValue} max={60} placeholder={{ replace: '青州城外', add: '林晚的玉佩', remove: '断弦琴' }[op]} />
        </>
      )}
      <button class="lo-more plain small" type="button" aria-expanded={more} onClick={() => setMore(!more)}>
        <span>高级：到第几章为止、原文、记录方式</span>
        <MIc n="chevronDown" />
      </button>
      {more && (
        <>
          <div class="lo-sf-row">
            <span class="lo-sf-l">到第</span>
            <NumberInput value={until} onInput={setUntil} placeholder="一直" label="到第几章" />
            <span class="lo-sf-l">章为止（空着是一直这样）</span>
          </div>
          <Text value={evidence} onInput={setEvidence} max={60} placeholder="正文里的那一句，以后好对照" />
          <div class="lo-sf-l top">记录方式</div>
          <div class="lo-ops" role="radiogroup" aria-label="记录方式">
            {(['replace', 'add', 'remove'] as Op[]).map((o) => (
              <button type="button" role="radio" key={o} aria-checked={op === o} disabled={(mode === 'single' && o !== 'replace') || (mode === 'list' && o === 'replace')} onClick={() => (setOp(o), setTouchedOp(true))}>
                <b>{{ replace: '换成', add: '多了', remove: '没了' }[o]}</b>
                <small>{OP_HELP[o]}</small>
              </button>
            ))}
          </div>
        </>
      )}
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={!key.trim() || !value.trim()} onClick={() => void submit()}>
          记下
        </button>
      </div>
    </div>
  );
}

function relationSheet(w: Work, a: string | undefined, ch: number, after: () => Promise<unknown> | void) {
  openOverlay({ kind: 'sheet', title: '记一条关系', body: () => <RelationForm w={w} a={a} chapter={ch} onDone={(ok) => (closeOverlay(), ok && void after())} /> });
}

function pairSheet(w: Work, a: string, b: string, onChanged: () => Promise<unknown> | void) {
  const name = (id: string) => w.characters.find((x) => x.id === id)?.name ?? '?';
  const list = pairHistory(w, a, b);
  openOverlay({
    kind: 'sheet',
    title: `${name(a)} 和 ${name(b)}`,
    body: () => (
      <div class="lo-pick">
        <ol class="lo-story in-sheet">
          {list.map((r) => (
            <li class="lo-step-ch" key={r.id}>
              <span class="lo-step-node static">{chapterName(r.from)}</span>
              <div class="lo-step-items">
                <div class="lo-step-i">
                  <div class="lo-step-m">
                    <b>{r.key}</b> {r.value}
                    {r.until !== undefined && <span class="lo-faint"> （到第 {r.until} 章）</span>}
                    {byAi(r.source) && <em class="lo-tag-s ai">AI 记的</em>}
                    {r.evidence && <div class="lo-quote">「{r.evidence}」</div>}
                  </div>
                  <button
                    class="lo-x"
                    type="button"
                    aria-label={`删除 ${r.value}`}
                    onClick={() => void run(() => mutate('delete-relation', { work: w.id, id: r.id }), '已删除').then((v) => v && (closeOverlay(), void onChanged()))}
                  >
                    <MIc n="x" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
        {!list.length && <div class="lo-pick-note">没有记录。</div>}
      </div>
    ),
  });
}

function RelationForm({ w, a: fixed, chapter, onDone }: { w: Work; a?: string; chapter: number; onDone: (ok: boolean) => void }) {
  const people = sortPeople(w.characters);
  const [a, setA] = useState(fixed ?? people[0]?.id ?? '');
  const [b, setB] = useState(people.find((x) => x.id !== (fixed ?? people[0]?.id))?.id ?? '');
  const [value, setValue] = useState('');
  const [from, setFrom] = useState<number | undefined>(chapter);
  const name = (id: string) => w.characters.find((x) => x.id === id)?.name ?? '';
  const who = (v: string, set: (v: string) => void, other: string, label: string) => (
    <div class="lo-who-pick" role="radiogroup" aria-label={label}>
      {people
        .filter((p) => p.id !== other)
        .map((p) => (
          <button type="button" role="radio" key={p.id} aria-checked={v === p.id} onClick={() => set(p.id)}>
            <Avatar name={p.name} size="s" />
            {p.name}
          </button>
        ))}
    </div>
  );
  const submit = async () => {
    const r = await run(() => mutate<RecordResult>('record-states', { work: w.id, chapter: from ?? w.cursor.chapter, changes: [{ subject: `${name(a)}/${name(b)}`, key: '关系', value: value.trim() }] }));
    if (!r) return;
    if (r.errors.length) return showToast(r.errors.join('；'));
    showToast(r.cursorMoved ? `记下了，现在写到第 ${r.chapter} 章` : '记下了');
    if (r.cursorMoved) void refreshWorks();
    // look at the chapter it's from, so the change shows
    view.value = { work: w.id, ch: from ?? w.cursor.chapter };
    onDone(true);
  };
  return (
    <div class="lo-sheetform plg">
      {fixed ? (
        <div class="lo-sf-l top">
          <Avatar name={name(fixed)} size="s" /> {name(fixed)} 和……
        </div>
      ) : (
        <>
          <div class="lo-sf-l top">一个人</div>
          {who(a, setA, b, '一个人')}
          <div class="lo-sf-l top">另一个人</div>
        </>
      )}
      {who(b, setB, a, '另一个人')}
      <div class="lo-sf-l top">是什么关系</div>
      <Text value={value} onInput={setValue} max={40} placeholder="互相试探，未表明身份" />
      <div class="lo-sf-row">
        <span class="lo-sf-l">从</span>
        <NumberInput value={from} onInput={setFrom} label="从第几章" />
        <span class="lo-sf-l">章起</span>
      </div>
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={!a || !b || a === b || !value.trim()} onClick={() => void submit()}>
          记下
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 设定

const INJECT_MAX = 600;
const inForce = (e: Entry, ch: number) => (e.from === undefined || e.from <= ch) && (e.until === undefined || e.until >= ch);
function Entries({ w, chapter }: { w: Work; chapter: number }) {
  const [filter, setFilter] = useState<'all' | 'constant' | 'off'>('all');
  const [q, setQ] = useState('');
  const t = q.trim();
  const list = w.lore
    .filter((e) => (filter === 'constant' ? e.constant : filter === 'off' ? !e.enabled : true))
    .filter((e) => !t || e.title.includes(t) || e.keys.some((k) => k.includes(t)) || e.content.includes(t))
    .sort((a, b) => Number(b.constant) - Number(a.constant) || b.order - a.order);
  return (
    <>
      {w.lore.length > 0 && (
        <>
          <div class="hist-find plg-find">
            <MIc n="search" />
            <input type="search" placeholder="找设定（标题、关键词、内容）" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </div>
          <Seg
            value={filter}
            label="筛选"
            onChange={setFilter}
            options={[
              ['all', `全部 ${w.lore.length}`],
              ['constant', '常驻'],
              ['off', '停用'],
            ]}
          />
        </>
      )}
      <div class="lo-entries">
        {list.map((e) => {
          const off = !e.enabled || !inForce(e, chapter);
          return (
            <button class={`lo-entry ${off ? 'off' : ''}`} type="button" key={e.id} onClick={() => openPage(`lore-entry:${w.id}:${e.id}`)}>
              <div class="lo-entry-h">
                {e.constant && <MIc n="pin" />}
                <span class="lo-entry-t">{e.title || '（无标题）'}</span>
                <span class="grow" />
                {!e.enabled ? <em class="lo-tag-s">停用</em> : !inForce(e, chapter) ? <em class="lo-tag-s">{chapterName(chapter)}时不算</em> : null}
                {(e.from !== undefined || e.until !== undefined) && <em class="lo-tag-s">{span(e)}</em>}
                {len(e.content) > INJECT_MAX && <em class="lo-tag-s warn">太长，只能查</em>}
              </div>
              {e.content && <div class="lo-entry-s">{e.content}</div>}
              <div class="lo-chiprow">
                {e.constant ? <span class="lo-key always">每轮都带</span> : e.keys.slice(0, 6).map((k) => <span class="lo-key" key={k}>{k}</span>)}
                {!e.constant && e.keys.length > 6 && <span class="lo-key">+{e.keys.length - 6}</span>}
              </div>
            </button>
          );
        })}
        <button class="lo-entry add" type="button" onClick={() => openPage(`lore-entry:${w.id}:new`)}>
          <MIc n="plus" />
          <span>新设定</span>
        </button>
      </div>
      {!w.lore.length && <p class="plg-note">地点、组织、规矩、物件……每条写几个关键词，对话里提到时才带上；很重要的可以设成每轮都带。</p>}
      {w.lore.length > 0 && !list.length && <div class="plg-empty-line">没找到。</div>}
    </>
  );
}

const LOGIC: [Logic, string][] = [
  ['and-any', '还要有任一个'],
  ['and-all', '还要全部都有'],
  ['not-all', '不能全都有'],
  ['not-any', '一个都不能有'],
];
type EntryForm = Pick<Entry, 'title' | 'keys' | 'content' | 'constant' | 'enabled' | 'secondaryKeys' | 'logic' | 'order' | 'caseSensitive' | 'wholeWords'> & { from?: number; until?: number };
const entryForm = (e?: Entry): EntryForm => ({
  title: e?.title ?? '',
  keys: e?.keys ?? [],
  content: e?.content ?? '',
  constant: !!e?.constant,
  enabled: e ? e.enabled : true,
  secondaryKeys: e?.secondaryKeys ?? [],
  logic: e?.logic ?? 'and-any',
  order: e?.order ?? 100,
  caseSensitive: !!e?.caseSensitive,
  wholeWords: !!e?.wholeWords,
  from: e?.from,
  until: e?.until,
});

export function LoreEntryPage({ work, id }: { work: string; id: string }) {
  const { data: w, setData, error, reload } = useWork(work);
  if (error) return <Failed error={error} retry={reload} />;
  if (!w) return <div class="plg-empty-line">正在读取…</div>;
  const e = id === 'new' ? undefined : w.lore.find((x) => x.id === id);
  if (id !== 'new' && !e) return <div class="plg-empty-line">这条设定已经不在了。</div>;
  return <EntryEditor w={w} e={e} key={e?.id ?? 'new'} onSaved={() => readWork(work).then(setData)} />;
}

function EntryEditor({ w, e, onSaved }: { w: Work; e?: Entry; onSaved: () => Promise<unknown> }) {
  const base = useMemo(() => entryForm(e), [e]);
  const [f, setF] = useState<EntryForm>(base);
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof EntryForm>(k: K, v: EntryForm[K]) => setF({ ...f, [k]: v });
  const changed = JSON.stringify(f) !== JSON.stringify(base);
  const stCount = e?.st ? Object.keys(e.st).length : 0;
  const save = async () => {
    if (!f.title.trim() && !f.content.trim()) return showToast('标题和内容至少写一个');
    setBusy(true);
    const body: Record<string, unknown> = { work: w.id, ...(e ? { id: e.id } : {}) };
    for (const k of Object.keys(f) as (keyof EntryForm)[]) if (!e || JSON.stringify(f[k]) !== JSON.stringify(base[k])) body[k] = typeof f[k] === 'string' ? (f[k] as string).trim() : (f[k] ?? null);
    const saved = await run(() => mutate<Entry>('upsert-entry', body), e ? '已保存' : '已添加');
    setBusy(false);
    if (!saved) return;
    void refreshWorks();
    await onSaved();
    if (!e) replaceTop(`lore-entry:${w.id}:${saved.id}`);
  };
  const sw = (k: 'constant' | 'enabled' | 'caseSensitive' | 'wholeWords', title: string, sub?: string) => (
    <div class="plg-row static lo-sw">
      <div class="plg-row-m">
        <div class="plg-row-t">{title}</div>
        {sub && <div class="plg-row-s">{sub}</div>}
      </div>
      <Switch on={f[k]} label={title} onChange={(v) => set(k, v)} />
    </div>
  );
  return (
    <div class="plg lo">
      <div class="plg-group sk-form">
        <Field label="标题">
          <Text value={f.title} onInput={(v) => set('title', v)} max={40} placeholder="青州" />
        </Field>
        <Field label="关键词" hint="对话里出现任一个就带上这条">
          <Tags values={f.keys} onChange={(v) => set('keys', v)} max={30} maxLen={40} placeholder="青州（回车加一个）" />
        </Field>
        <Field label="内容">
          <Text value={f.content} onInput={(v) => set('content', v)} max={2000} area rows={6} placeholder="北境门户，城门入夜即闭……" />
        </Field>
        {len(f.content) > INJECT_MAX && <p class="plg-note warn lo-pad">超过 600 字的设定不会自动带上，只能让 AI 查。</p>}
        {sw('constant', '常驻', '不用提到也每轮都带。常驻设定合计最多 250 字，超出的那轮会放不下')}
        {sw('enabled', '启用')}
        <div class="lo-two">
          <Field label="从第几章（可空）">
            <NumberInput value={f.from} onInput={(v) => set('from', v)} placeholder="一开始" label="从第几章" />
          </Field>
          <Field label="到第几章（可空）">
            <NumberInput value={f.until} onInput={(v) => set('until', v)} placeholder="一直" label="到第几章" />
          </Field>
        </div>
        <button class="lo-more" type="button" aria-expanded={adv} onClick={() => setAdv(!adv)}>
          高级
          <MIc n="chevronDown" />
        </button>
        {adv && (
          <>
            <Field label="次要关键词">
              <Tags values={f.secondaryKeys} onChange={(v) => set('secondaryKeys', v)} max={30} maxLen={40} />
            </Field>
            <div class="sk-field lo-field">
              <span>次要关键词的规则</span>
              <select class="sf-input lo-select" aria-label="次要关键词的规则" value={f.logic} onChange={(ev) => set('logic', (ev.target as HTMLSelectElement).value as Logic)}>
                {LOGIC.map(([v, t]) => (
                  <option value={v} key={v}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <Field label="排序" hint="数大的先放">
              <NumberInput value={f.order} onInput={(v) => set('order', v ?? 0)} label="排序" />
            </Field>
            {sw('caseSensitive', '区分大小写', '只对英文有用')}
            {sw('wholeWords', '整词匹配', '只对英文有用：关键词要是一个完整的词')}
            {stCount > 0 && <p class="lo-hint pad">导入自酒馆的 {stCount} 项设置在这里不生效，导出时会带回。</p>}
          </>
        )}
        <div class="plg-actions lo-pad">
          <button class="plg-btn pri" type="button" disabled={busy || (!!e && !changed)} onClick={() => void save()}>
            {e ? '保存' : '添加设定'}
          </button>
          {e && changed && (
            <button class="plg-btn" type="button" onClick={() => setF(base)}>
              撤销修改
            </button>
          )}
        </div>
      </div>
      {e && (
        <div class="plg-actions">
          <button
            class="plg-btn danger"
            type="button"
            onClick={() =>
              confirm(`删除「${e.title}」？`, '这条设定和记在它上面的状态都会删掉。', '删除', async () => {
                if (await run(() => mutate('delete-entry', { work: w.id, id: e.id }), '已删除')) {
                  void refreshWorks();
                  pages.value = pages.value.slice(0, -1);
                }
              })
            }
          >
            删除设定
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 关系

function Relations({ w, chapter, reload }: { w: Work; chapter: number; reload: () => void }) {
  const name = (id: string) => w.characters.find((x) => x.id === id)?.name ?? '?';
  const rows = relationsAt(w, chapter);
  return (
    <>
      <div class="plg-group">
        {rows.map((r) => (
          <button class="lo-pair" type="button" key={`${r.a}${r.b}${r.key}`} onClick={() => pairSheet(w, r.a, r.b, reload)}>
            <span class="lo-pair-avs">
              <Avatar name={name(r.a)} size="s" />
              <Avatar name={name(r.b)} size="s" />
            </span>
            <span class="lo-pair-n">
              {name(r.a)} 和 {name(r.b)}
            </span>
            <span class="lo-pair-v" key={r.value}>
              {r.key !== '关系' ? `${r.key}：` : ''}
              {r.value}
            </span>
          </button>
        ))}
        {!rows.length && <div class="plg-empty-line">{chapterName(chapter)}时还没有记关系。</div>}
        <button class="plg-link" type="button" disabled={w.characters.length < 2} onClick={() => relationSheet(w, undefined, chapter, reload)}>
          <span>{w.characters.length < 2 ? '先加两个人物，才能记关系' : '记一条关系'}</span>
          <MIc n="plus" />
        </button>
      </div>
      <p class="plg-note">关系也按章节记：拖动时间轴，看他们在每一章时是什么关系。</p>
    </>
  );
}

// ---------------------------------------------------------------- 导入与设置

function More({ w, reload }: { w: Work; reload: () => void }) {
  const [adv, setAdv] = useState(false);
  const imports = [...w.imports].sort((a, b) => b.at - a.at);
  return (
    <>
      <button class="lo-bigbtn" type="button" onClick={() => openPage(`lore-import:${w.id}`)}>
        <MIc n="download" />
        <span>
          导入酒馆角色卡或世界书
          <small>.png / .json，只取人物和设定</small>
        </span>
        <MIc n="chevron" />
      </button>
      <section class="plg-sec">
        <h2 class="plg-sec-t">导入记录</h2>
        <div class="plg-group">
          {imports.map((j) => (
            <div class="plg-row static" key={j.id}>
              <div class="plg-row-m">
                <div class="plg-row-t">{j.filename || (j.kind === 'card' ? '角色卡' : '世界书')}</div>
                <div class="plg-row-s wrap">
                  {ago(j.at)} · {j.kind === 'card' ? '角色卡' : '世界书'} · 新增 {j.added.characters.length} 个人物、{j.added.entries.length} 条设定
                </div>
              </div>
              {j.undone ? (
                <span class="plg-row-s">已撤销</span>
              ) : (
                <button class="plg-text-btn danger" type="button" onClick={() => undoAsk(w.id, j.id, reload)}>
                  撤销这次导入
                </button>
              )}
            </div>
          ))}
          {!imports.length && <div class="plg-empty-line">还没导入过。</div>}
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">设置</h2>
        <div class="plg-group">
          <AutoSettings work={w} onChanged={reload} />
          <button
            class="plg-row"
            type="button"
            onClick={() => askText('导入时把 {{user}} 换成', w.settings.userName, (v) => void run(() => mutate('settings', { work: w.id, userName: v.trim() }), '已保存').then((x) => x && reload()), { ok: '保存' })}
          >
            <div class="plg-row-m">
              <div class="plg-row-t">{'导入时把 {{user}} 换成'}</div>
              <div class="plg-row-s">酒馆的卡里用 {'{{user}}'} 指你自己</div>
            </div>
            <span class="plg-row-v">{w.settings.userName}</span>
            <MIc n="chevron" />
          </button>
          <button class="lo-more" type="button" aria-expanded={adv} onClick={() => setAdv(!adv)}>
            高级
            <MIc n="chevronDown" />
          </button>
          {adv && (
            <button
              class="plg-row"
              type="button"
              onClick={() =>
                askText('看上一条回复的最后多少字', String(w.settings.scanTail), (v) => {
                  const n = Number(v.trim());
                  if (!Number.isInteger(n) || n < 0 || n > 4000) return showToast('要是 0 到 4000 之间的整数');
                  void run(() => mutate('settings', { work: w.id, scanTail: n }), '已保存').then((x) => x && reload());
                })
              }
            >
              <div class="plg-row-m">
                <div class="plg-row-t">看上一条回复的最后多少字</div>
                <div class="plg-row-s">写长章节时，只看上一条回复的结尾找提到了谁</div>
              </div>
              <span class="plg-row-v">{w.settings.scanTail} 字</span>
              <MIc n="chevron" />
            </button>
          )}
        </div>
      </section>
    </>
  );
}

function undoAsk(work: string, jobId: string, after: () => void) {
  confirm('撤销这次导入？', '这次导入加进来的人物和设定会删掉；导入后改过的人物会保留。', '撤销', async () => {
    const r = await run(() => undoImport(work, jobId));
    if (!r) return;
    const parts = [`撤销了：删掉 ${r.removed.characters} 个人物、${r.removed.entries} 条设定`];
    if (r.kept.length) parts.push(`这些人物导入后改过，保留了：${r.kept.join('、')}`);
    if (r.merged.length) parts.push(`合并进已有人物的内容没有回退：${r.merged.join('、')}`);
    showToast(parts.join('。'));
    void refreshWorks();
    after();
  });
}

// ---------------------------------------------------------------- 导入

type Picked = { filename: string; kind: 'card' | 'worldbook' | null; json?: unknown; pngBase64?: string };
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PNG = 9 * 1024 * 1024;

async function bytesOf(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  const r = stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
function base64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function kindOf(j: unknown): 'card' | 'worldbook' | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (o.spec === 'chara_card_v2' || o.spec === 'chara_card_v3' || (typeof o.name === 'string' && 'description' in o)) return 'card';
  if ('entries' in o) return 'worldbook';
  return null;
}

/** Reads a picked .json / .png into what /import takes; a message when it can't. */
export async function readPicked(name: string, size: number, stream: () => ReadableStream<Uint8Array>, text: () => Promise<string>): Promise<Picked | string> {
  if (/\.png$/i.test(name)) {
    if (size > MAX_PNG) return '图片太大了（上限 9 MB）';
    return { filename: name, kind: 'card', pngBase64: base64(await bytesOf(stream())) };
  }
  if (!/\.json$/i.test(name)) return '只能导入 .json 或 .png';
  if (size > MAX_JSON) return '文件太大了（上限 2 MB）';
  try {
    const json = JSON.parse(await text());
    return { filename: name, kind: kindOf(json), json };
  } catch {
    return '这个文件不是有效的 JSON';
  }
}

/** The engine's report, as it says it, laid out: the headline, what was skipped (folded), the notes. */
function Report({ text, open }: { text: string; open?: boolean }) {
  const lines = text.split('\n').filter((l) => l.trim());
  const at = lines.findIndex((l) => /^跳过了[:：]/.test(l));
  const skipped = at < 0 ? [] : lines.slice(at + 1).filter((l) => /^\s*-/.test(l));
  const notes = lines.slice(1).filter((l, i) => !(at >= 0 && (i + 1 === at || skipped.includes(l))));
  const [show, setShow] = useState(!!open);
  return (
    <div class="lo-report">
      <div class="lo-report-h">{lines[0]}</div>
      {notes.map((n) => (
        <div class="lo-report-n" key={n}>
          {n}
        </div>
      ))}
      {skipped.length > 0 && (
        <>
          <button class="lo-more plain small" type="button" aria-expanded={show} onClick={() => setShow(!show)}>
            <span>跳过了 {skipped.length} 类内容</span>
            <MIc n="chevronDown" />
          </button>
          <ul class="lo-report-skip" hidden={!show}>
            {skipped.map((s) => (
              <li key={s}>{s.replace(/^\s*-\s*/, '')}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <ol class="lo-steps" aria-label={`第 ${at} 步，共 3 步`}>
      {['选文件', '确认', '完成'].map((t, i) => (
        <li class={i + 1 < at ? 'done' : i + 1 === at ? 'on' : ''} key={t}>
          <span>{i + 1 < at ? <MIc n="check" /> : i + 1}</span>
          {t}
        </li>
      ))}
    </ol>
  );
}

export function LoreImportPage({ work: into }: { work?: string }) {
  const [file, setFile] = useState<Picked | null>(null);
  const [kind, setKind] = useState<'card' | 'worldbook'>('card');
  const [target, setTarget] = useState<string>(into ?? 'new');
  const [title, setTitle] = useState('');
  const [userName, setUserName] = useState('主角');
  const [dry, setDry] = useState<ImportAnswer | null>(null);
  const [force, setForce] = useState(false);
  const [onConflict, setOnConflict] = useState<'merge' | 'new' | 'skip'>('merge');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [done, setDone] = useState<(ImportAnswer & { workId: string }) | null>(null);
  const { data: list, error, reload } = useLoad(refreshWorks);

  // {{user}} defaults to what the chosen work already uses
  useEffect(() => {
    if (target === 'new') return;
    readWork(target).then((w) => setUserName(w.settings.userName), () => {});
  }, [target]);

  const body = (extra: Partial<ImportBody> = {}): ImportBody => ({
    ...(target === 'new' ? { title: title.trim() || undefined } : { work: target }),
    kind,
    filename: file!.filename,
    ...(file!.pngBase64 ? { pngBase64: file!.pngBase64 } : { json: file!.json }),
    userName: userName.trim() || '主角',
    ...extra,
  });
  // the report again whenever what it depends on changes
  useEffect(() => {
    if (!file) return;
    setDry(null);
    setForce(false);
    importFile(body({ dryRun: true })).then(setDry, (e) => showToast(errText(e)));
  }, [file, kind, target, userName]);

  if (error) return <Failed error={error} retry={reload} />;
  if (!list) return <div class="plg-empty-line">正在读取…</div>;

  const pick = async () => {
    try {
      const [f] = await native.pickDocuments(['.json', '.png', 'application/json', 'image/png']);
      if (!f) return;
      const r = await readPicked(f.name, f.size, () => f.stream(), () => f.text());
      f.release?.();
      if (typeof r === 'string') return showToast(r);
      setFile(r);
      if (r.kind) setKind(r.kind);
      setTitle('');
    } catch (e) {
      showToast(errText(e));
    }
  };
  const go = async () => {
    if (!file || !dry) return;
    setBusy(true);
    try {
      const r = await importFile(body({ onConflict, ...(force ? { force: true } : {}) }));
      if (r.needsChoice) {
        setDry({ ...dry, conflicts: r.conflicts, report: r.report });
        return showToast('有重名的人物，先选怎么办');
      }
      setDone({ ...r, workId: r.work?.id ?? target });
      void refreshWorks();
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const intoTitle = into ? workTitle(into) : undefined;

  if (done) {
    const name = done.work?.title ?? workTitle(done.workId) ?? '';
    return (
      <div class="plg lo">
        <Steps at={3} />
        <div class="lo-done">
          <span class="lo-done-i">
            <MIc n="check" />
          </span>
          <h2 class="plg-sec-t">导入好了</h2>
          <Report text={done.report} />
        </div>
        <div class="plg-actions lo-center">
          <button class="plg-btn pri" type="button" onClick={() => replaceTop(`lore:${done.workId}`)}>
            打开《{name}》
          </button>
          {done.jobId && (
            <button class="plg-btn" type="button" onClick={() => undoAsk(done.workId, done.jobId!, () => (setDone(null), setFile(null), setDry(null)))}>
              撤销这次导入
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!file)
    return (
      <div class="plg lo">
        <Steps at={1} />
        <button class="lo-drop" type="button" onClick={() => void pick()}>
          <MIc n="download" />
          <span class="lo-drop-t">选一个角色卡或世界书</span>
          <span class="lo-drop-s">SillyTavern 的 .png 或 .json{intoTitle ? `，导入到《${intoTitle}》` : ''}</span>
        </button>
        <div class="lo-keeps">
          <div>
            <span class="lo-keep yes">
              <MIc n="check" />
            </span>
            <span>
              <b>会导入</b>人物（名字、简介、外貌、性格、背景……）和世界书里的设定
            </span>
          </div>
          <div>
            <span class="lo-keep no">
              <MIc n="x" />
            </span>
            <span>
              <b>不导入</b>开场白、给 AI 的指令、脚本、用到变量的设定——确认前会列出来
            </span>
          </div>
          <div>
            <span class="lo-keep">
              <MIc n="refresh" />
            </span>
            <span>
              <b>导错了</b>可以整次撤销
            </span>
          </div>
        </div>
      </div>
    );

  const conflicts = dry?.conflicts ?? [];
  const suggested = file.filename.replace(/\.[^.]+$/, '');
  return (
    <div class="plg lo">
      <Steps at={2} />
      <div class="lo-file">
        <MIc n="doc" />
        <span class="lo-file-m">
          <span class="lo-file-n">{file.filename}</span>
          <span class="lo-faint">{file.kind === 'worldbook' || (!file.kind && kind === 'worldbook') ? '世界书' : '角色卡'}</span>
        </span>
        <button class="plg-text-btn" type="button" onClick={() => void pick()}>
          换一个
        </button>
      </div>
      {!file.kind && (
        <div class="lo-panel">
          <div class="lo-panel-t">认不出是哪种文件，请选一下</div>
          <Seg
            value={kind}
            label="文件类型"
            onChange={setKind}
            options={[
              ['card', '角色卡'],
              ['worldbook', '世界书'],
            ]}
          />
        </div>
      )}
      <div class="lo-panel">
        {dry ? (
          <>
            <div class="lo-counts">
              <span>
                <b>{dry.characters ?? 0}</b>个人物
              </span>
              <span>
                <b>{dry.entries ?? 0}</b>条设定
              </span>
            </div>
            <Report text={dry.report} />
          </>
        ) : (
          <div class="plg-empty-line">正在看这个文件…</div>
        )}
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">放进哪部作品</h2>
        <div class="lo-targets" role="radiogroup" aria-label="导到哪部作品">
          <button type="button" role="radio" aria-checked={target === 'new'} onClick={() => setTarget('new')}>
            <MIc n="plus" />
            新作品
          </button>
          {list.map((w) => (
            <button type="button" role="radio" key={w.id} aria-checked={target === w.id} onClick={() => setTarget(w.id)}>
              《{w.title}》
            </button>
          ))}
        </div>
        {target === 'new' && (
          <div class="plg-group sk-form">
            <Field label="书名">
              <Text value={title} onInput={setTitle} max={40} placeholder={suggested || '书名'} />
            </Field>
          </div>
        )}
      </section>
      {dry?.duplicate && (
        <div class="plg-group lo-warn">
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">这个文件已经导入过这部作品</div>
              <div class="plg-row-s">再导一次会重复，确实要的话打开「仍然导入」</div>
            </div>
            <Switch on={force} label="仍然导入" onChange={setForce} />
          </div>
        </div>
      )}
      {conflicts.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">已经有叫{conflicts.map((n) => `「${n}」`).join('')}的人物</h2>
          <div class="lo-choice" role="radiogroup" aria-label="重名的人物怎么办">
            {(
              [
                ['merge', '合并', '补上空着的栏、加上别名，已有的内容不动'],
                ['new', '另建', `新建一个「${conflicts[0]}（导入）」`],
                ['skip', '跳过', '这个人物不导入，只导入设定'],
              ] as const
            ).map(([v, t, s]) => (
              <button class="lo-optcard" type="button" role="radio" aria-checked={onConflict === v} key={v} onClick={() => setOnConflict(v)}>
                <span class="lo-optcard-t">
                  {t}
                  {v === 'merge' && <em class="lo-tag-s main">推荐</em>}
                </span>
                <span class="lo-optcard-s">{s}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section class="plg-sec">
        <button class="lo-more plain small" type="button" aria-expanded={more} onClick={() => setMore(!more)}>
          <span>{`更多选项：{{user}} 换成「${userName || '主角'}」`}</span>
          <MIc n="chevronDown" />
        </button>
        {more && (
          <div class="plg-group sk-form">
            <Field label="{{user}} 换成" hint="酒馆的卡里用 {{user}} 指你自己">
              <Text value={userName} onInput={setUserName} max={20} />
            </Field>
          </div>
        )}
      </section>
      <div class="lo-savebar">
        <button class="plg-btn pri wide" type="button" disabled={busy || !dry || (dry.duplicate && !force)} onClick={() => void go()}>
          {busy ? '导入中…' : dry ? `导入 ${dry.characters ?? 0} 个人物、${dry.entries ?? 0} 条设定` : '导入'}
        </button>
      </div>
    </div>
  );
}

/** For the settings row: 「《长夜》等 2 部」 / 「还没有作品」. */
export function worksValue() {
  const l = works.value;
  if (!l) return '';
  if (!l.length) return '还没有作品';
  return l.length === 1 ? `《${l[0].title}》` : `《${l[0].title}》等 ${l.length} 部`;
}
