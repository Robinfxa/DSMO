// 陪伴 (MaiDSH): how TA is now, what TA remembers and has picked up from you, when TA may come to
// you, and feeding TA material to learn. Five tabs over the MaiDSH plugins' routes (maidsh/api.ts);
// the design is the 「陪伴」页面 UI 说明 doc, the rules and numbers maidsh/CONTRACT.md.
//
// A tab whose plugin isn't installed says how to get it; one that is installed but doesn't answer
// (404) says to restart the engine. Wording: the person is 你, the character TA; no 系统 / 插件 /
// 分析 / token except in the learning estimate; words before numbers, numbers in 详情.

import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { native } from '../../bridge/native';
import {
  MaidshError,
  actOnJob,
  aspect,
  hasModule,
  learn,
  mutateExpression,
  mutateInitiative,
  mutateMemory,
  readExpression,
  readInitiative,
  readJobs,
  readMemory,
  readOverview,
  type BondState,
  type Episode,
  type Expression,
  type Fact,
  type FactCat,
  type InitiativeState,
  type Job,
  type MemoryList,
  type Module,
  type MoodState,
  type Overview,
  type TextType,
} from '../../maidsh/api';
import { installed } from '../../plugins/frontend';
import { confirm, currentId, errText, getTranscript, openPage, pages, showToast } from '../../state/store';
import { Switch } from '../common';
import { MIc } from '../mobile/MIc';

export type Tab = 'overview' | 'memory' | 'expression' | 'initiative' | 'learn';
const TABS: { id: Tab; title: string; module: Module }[] = [
  { id: 'overview', title: '总览', module: 'core' },
  { id: 'memory', title: '记忆', module: 'memory' },
  { id: 'expression', title: '表达', module: 'expression' },
  { id: 'initiative', title: '主动', module: 'initiative' },
  { id: 'learn', title: '学习与导入', module: 'core' },
];
const MODULE_TITLE: Record<Module, string> = {
  core: 'MaiDSH 总控',
  mood: 'MaiDSH 心情',
  bond: 'MaiDSH 羁绊',
  memory: 'MaiDSH 记忆',
  expression: 'MaiDSH 表达',
  initiative: 'MaiDSH 主动',
};

export const companionTab = signal<Tab>('overview');

// ---------------------------------------------------------------- small helpers

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
function ago(t: number): string {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
const strength = (x: number) => (x >= 0.7 ? '强烈' : x >= 0.35 ? '明显' : '轻微');
const clarity = (r: number, pinned: boolean) => (pinned || r >= 0.6 ? '记得清楚' : r >= 0.3 ? '有点模糊' : '快忘了');
const SOURCE: Record<string, string> = {
  auto: '聊天里记的',
  user: '你加的',
  import: '导入的',
};

/** Not installed: where to get it. Installed but not answering: restart. */
function Missing({ module, inline }: { module: Module; inline?: boolean }) {
  const inst = hasModule(module);
  const text = inst ? `${MODULE_TITLE[module]}装好了，重启引擎后生效。` : `还没装「${MODULE_TITLE[module]}」。`;
  const btn = !inst && (
    <button class="plg-text-btn" type="button" onClick={() => openPage(`plugin:${encodeURIComponent('@api-demo/maidsh-' + module)}`)}>
      去插件市场安装
    </button>
  );
  if (inline)
    return (
      <span class="cp-missing">
        {text}
        {btn}
      </span>
    );
  return (
    <div class="plg-empty">
      <span>{text}</span>
      {btn}
    </div>
  );
}

/** Loads with [read]; `missing` when the plugin's routes aren't there. */
function useLoad<T>(read: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const reload = () =>
    read().then(
      (v) => {
        setData(v);
        setError(null);
        setMissing(false);
      },
      (e) => (e instanceof MaidshError && e.missing ? setMissing(true) : setError(errText(e))),
    );
  useEffect(() => void reload(), deps);
  return { data, setData, error, missing, reload };
}

function Failed({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div class="plg-empty-line">
      没能读取：{error}
      <button class="plg-text-btn" type="button" onClick={retry}>
        重试
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the page

export function CompanionPage({ tab }: { tab?: Tab }) {
  useEffect(() => {
    if (tab) companionTab.value = tab;
  }, [tab]);
  const t = companionTab.value;
  return (
    <div class="plg cp">
      <div class="plg-seg cp-tabs" role="tablist">
        {TABS.map((x) => (
          <button type="button" role="tab" key={x.id} aria-selected={t === x.id} onClick={() => (companionTab.value = x.id)}>
            {x.title}
          </button>
        ))}
      </div>
      {t === 'overview' && <OverviewTab />}
      {t === 'memory' && <MemoryTab />}
      {t === 'expression' && <ExpressionTab />}
      {t === 'initiative' && <InitiativeTab />}
      {t === 'learn' && <LearnTab />}
    </div>
  );
}

// ---------------------------------------------------------------- 总览

/** The bond levels' boundaries (CONTRACT §6): -227 / -73 / 227 / 587 / 900. */
const BOUNDS = [-1000, -227, -73, 227, 587, 900, 1000];

function MoodCard({ m }: { m: MoodState }) {
  const x = 50 + m.valence * 44;
  const y = 50 - m.arousal * 44;
  return (
    <div class="plg-group cp-card">
      <div class="cp-card-h">
        <span class="cp-card-t">心情</span>
        <span class="cp-card-m">{ago(m.updatedAt)}</span>
      </div>
      <div class="cp-mood">
        <div class="cp-big">{m.label}</div>
        <svg class="cp-plot" viewBox="0 0 100 100" role="img" aria-label={`愉悦 ${m.valence.toFixed(2)}，激动 ${m.arousal.toFixed(2)}`}>
          <line x1="6" y1="50" x2="94" y2="50" />
          <line x1="50" y1="6" x2="50" y2="94" />
          <text x="94" y="46" text-anchor="end">
            愉悦
          </text>
          <text x="54" y="12">
            激动
          </text>
          <circle cx={x} cy={y} r="5" />
        </svg>
      </div>
      {m.personality && (
        <div class="cp-traits">
          <span>情绪起伏 {m.personality.neuroticism >= 0.6 ? '大' : m.personality.neuroticism <= 0.4 ? '小' : '适中'}</span>
          <span>性子 {m.personality.agreeableness >= 0.6 ? '随和' : m.personality.agreeableness <= 0.4 ? '有点倔' : '适中'}</span>
        </div>
      )}
    </div>
  );
}

function BondCard({ b }: { b: BondState }) {
  const [more, setMore] = useState(false);
  const seg = Math.max(0, Math.min(5, b.level));
  const within = (b.value - BOUNDS[seg]) / (BOUNDS[seg + 1] - BOUNDS[seg]);
  return (
    <div class="plg-group cp-card">
      <div class="cp-card-h">
        <span class="cp-card-t">和你的关系</span>
        <button class="plg-text-btn" type="button" onClick={() => setMore(!more)}>
          {more ? '收起' : '详情'}
        </button>
      </div>
      <div class="cp-big">{b.levelName}</div>
      <div class="cp-levels" role="img" aria-label={`${b.levelName}，第 ${seg + 1} 档，共 6 档`}>
        {(b.levels?.length ? b.levels : ['厌恶', '冷淡', '一般', '亲近', '喜欢', '暧昧']).map((name, i) => (
          <div class={`cp-level ${i < seg ? 'past' : i === seg ? 'on' : ''}`} key={i}>
            <div class="cp-level-bar">
              {i === seg && (
                <span
                  style={{
                    width: `${Math.round(Math.max(0.06, Math.min(1, within)) * 100)}%`,
                  }}
                />
              )}
            </div>
            <div class="cp-level-n">{name}</div>
          </div>
        ))}
      </div>
      {b.recent?.length > 0 && (
        <div class="cp-recent">
          {b.recent.slice(0, 5).map((r, i) => (
            <span class={`cp-chg ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}`} key={i} title={ago(r.at)}>
              {r.label}
              {r.delta > 0 ? ' ↑' : r.delta < 0 ? ' ↓' : ''}
            </span>
          ))}
        </div>
      )}
      {more && (
        <div class="cp-detail">
          好感 {b.value > 0 ? '+' : ''}
          {Math.round(b.value)}（-1000 到 1000）{b.streak ? ` · 连着 ${Math.abs(b.streak)} 次${b.streak > 0 ? '变好' : '变差'}` : ''}
          {b.recent?.length > 0 && (
            <ul>
              {b.recent.map((r, i) => (
                <li key={i}>
                  {ago(r.at)} · {r.label} · {r.delta > 0 ? `+${r.delta}` : r.delta}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function OverviewTab() {
  const { data: o, error, missing, reload } = useLoad<Overview>(readOverview);
  if (missing) return <Missing module="core" />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!o) return <div class="plg-empty-line">正在读取…</div>;
  const mood = aspect<MoodState>(o, 'mood');
  const bond = aspect<BondState>(o, 'bond');
  const mem = aspect<{ facts?: number; episodes?: number; short?: string }>(o, 'memory');
  const ex = aspect<{ styles?: number; slang?: number }>(o, 'expression');
  const ini = aspect<InitiativeState>(o, 'initiative');
  const go = (t: Tab) => (companionTab.value = t);
  return (
    <>
      {o.lastError && <p class="plg-note cp-faint">最近一次没能读懂这一轮：{o.lastError}</p>}
      {mood && <MoodCard m={mood} />}
      {bond && <BondCard b={bond} />}
      {o.lastFeeling && (
        <div class="plg-group cp-card">
          <div class="cp-card-h">
            <span class="cp-card-t">最近的感受</span>
            <span class="cp-card-m">{ago(o.lastTurnAt)}</span>
          </div>
          <div class="cp-line">
            上一轮让 TA <b>{o.lastFeeling.label}</b>，{strength(o.lastFeeling.intensity)}
          </div>
        </div>
      )}
      <div class="plg-group cp-sums">
        <button class="cp-sum" type="button" onClick={() => go('memory')}>
          <span class="cp-sum-t">记忆</span>
          <span class="cp-sum-s">{mem ? `记得 ${mem.facts ?? 0} 件事、${mem.episodes ?? 0} 段经历` : <Missing module="memory" inline />}</span>
          <MIc n="chevron" />
        </button>
        <button class="cp-sum" type="button" onClick={() => go('expression')}>
          <span class="cp-sum-t">表达</span>
          <span class="cp-sum-s">{ex ? `学会 ${ex.styles ?? 0} 种说法、${ex.slang ?? 0} 个黑话` : <Missing module="expression" inline />}</span>
          <MIc n="chevron" />
        </button>
        <button class="cp-sum" type="button" onClick={() => go('initiative')}>
          <span class="cp-sum-t">主动</span>
          <span class="cp-sum-s">
            {ini ? (
              !ini.enabled ? (
                '已关闭'
              ) : ini.stopped ? (
                'TA 等你先开口'
              ) : (
                `今天主动 ${ini.today}/${ini.perDay} 次${ini.nextAt ? `，下次大约 ${hhmm(ini.nextAt)}` : ''}`
              )
            ) : (
              <Missing module="initiative" inline />
            )}
          </span>
          <MIc n="chevron" />
        </button>
      </div>
      {!mood && !bond && <p class="plg-note">装上「MaiDSH 心情」「MaiDSH 羁绊」，这里会显示 TA 的心情和你们的关系。</p>}
    </>
  );
}

// ---------------------------------------------------------------- 记忆

const FACT_GROUPS: { cat: FactCat; title: string }[] = [
  { cat: 'identity', title: '身份' },
  { cat: 'relation', title: '你们的关系设定' },
  { cat: 'stable', title: '稳定的事' },
  { cat: 'pref', title: '喜好和雷点' },
  { cat: 'recent', title: '近况' },
  { cat: 'uncertain', title: '拿不准的' },
];
const ADD_CATS: { cat: FactCat; title: string }[] = [...FACT_GROUPS.filter((g) => g.cat !== 'uncertain'), { cat: 'world', title: '故事设定' }];

/** One fact or episode: tap to edit, pin, delete. */
function MemoryRow({ item, open, onOpen, apply }: { item: Fact | Episode; open: boolean; onOpen: () => void; apply: (body: Record<string, unknown>, done?: string) => Promise<boolean> }) {
  const isEp = 'summary' in item;
  const [text, setText] = useState(isEp ? (item as Episode).summary : (item as Fact).text);
  // before paint: the editor opens with the current text and never resets what's typed into it
  useLayoutEffect(() => setText(isEp ? (item as Episode).summary : (item as Fact).text), [item.id, open]);
  const max = isEp ? 80 : 60;
  const fade = item.pinned ? 1 : Math.max(0.45, Math.min(1, 0.4 + item.r));
  return (
    <div class={`cp-mem ${open ? 'open' : ''}`}>
      <button class="cp-mem-row" type="button" onClick={onOpen} aria-expanded={open}>
        <div class="cp-mem-m" style={{ opacity: fade }}>
          {isEp ? (
            <>
              <div class="cp-mem-t">
                <span class="cp-date">{(item as Episode).at}</span>
                {(item as Episode).title}
                {(item as Episode).story && <em class="tm-badge quiet">故事里</em>}
              </div>
              <div class="cp-mem-s">
                {(item as Episode).summary}
                {(item as Episode).feeling?.label ? ` · ${(item as Episode).feeling!.label}` : ''}
              </div>
            </>
          ) : (
            <>
              <div class="cp-mem-t">{(item as Fact).text}</div>
              {(item as Fact).quote && <div class="cp-quote">你说过：「{(item as Fact).quote}」</div>}
              <div class="cp-mem-s">
                {SOURCE[(item as Fact).source] ?? ''} · {clarity(item.r, item.pinned)}
              </div>
            </>
          )}
        </div>
        {item.pinned && (
          <span class="cp-pin" aria-label="钉住了">
            <MIc n="pin" />
          </span>
        )}
      </button>
      {open && (
        <div class="cp-edit">
          <textarea class="sf-input area" rows={2} maxLength={max} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <div class="cp-edit-row">
            <small>
              {text.length} / {max}
            </small>
            <Switch on={item.pinned} label="钉住，不会忘" onChange={(v) => void apply({ action: 'pin', id: item.id, pinned: v }, v ? '钉住了' : '取消钉住')} />
            <span class="cp-edit-l">钉住</span>
          </div>
          <div class="plg-actions">
            <button
              class="plg-btn pri"
              type="button"
              disabled={!text.trim() || text.trim() === (isEp ? (item as Episode).summary : (item as Fact).text)}
              onClick={() => void apply({ action: 'edit', id: item.id, text: text.trim() }, '已改好')}
            >
              保存
            </button>
            <button class="plg-btn danger" type="button" onClick={() => confirm('删掉这条记忆？', '删掉后找不回来。', '删除', () => void apply({ action: 'delete', id: item.id }, '已删除'))}>
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryTab() {
  const { data: m, setData, error, missing, reload } = useLoad<MemoryList>(readMemory);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editImp, setEditImp] = useState(false);
  if (missing) return <Missing module="memory" />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!m) return <div class="plg-empty-line">正在读取…</div>;

  const apply = async (body: Record<string, unknown>, done?: string) => {
    try {
      const v = await mutateMemory(body);
      setData(v);
      if (done) showToast(done);
      if (body.action === 'delete' || body.action === 'edit') setOpen(null);
      return true;
    } catch (e) {
      showToast(errText(e));
      return false;
    }
  };
  const row = (x: Fact | Episode) => <MemoryRow key={x.id} item={x} open={open === x.id} onOpen={() => setOpen(open === x.id ? null : x.id)} apply={apply} />;
  const about = m.facts.filter((f) => f.cat !== 'world');
  const world = m.facts.filter((f) => f.cat === 'world');
  const episodes = [...m.episodes].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const memoryShare = installed.value.some((x) => x.id === '@api-demo/memory-share' && x.enabled);

  return (
    <>
      <section class="plg-sec">
        <div class="plg-shelf-h">
          <h2 class="plg-sec-t">印象</h2>
          <button class="plg-text-btn" type="button" onClick={() => setEditImp(!editImp)}>
            {editImp ? '取消' : '改一改'}
          </button>
        </div>
        {editImp ? (
          <ImpressionEdit m={m} onSave={async (short, impression) => (await apply({ action: 'edit-impression', short, impression }, '已改好')) && setEditImp(false)} />
        ) : (
          <div class="plg-group cp-card">
            {m.profile.short || m.profile.impression ? (
              <>
                {m.profile.short && <div class="cp-imp-s">{m.profile.short}</div>}
                {m.profile.impression && <p class="cp-imp">{m.profile.impression}</p>}
              </>
            ) : (
              <div class="plg-empty-line">多聊几句，TA 会慢慢形成对你的印象。</div>
            )}
          </div>
        )}
      </section>

      <section class="plg-sec">
        <div class="plg-shelf-h">
          <h2 class="plg-sec-t">关于你 · {about.length}</h2>
          <button class="plg-text-btn" type="button" onClick={() => setAdding(!adding)}>
            {adding ? '取消' : '记一件事'}
          </button>
        </div>
        {adding && <AddFact onAdd={async (text, cat) => (await apply({ action: 'add', text, cat, pinned: true }, '记下了')) && setAdding(false)} />}
        {!about.length && !adding && (
          <div class="plg-group">
            <div class="plg-empty-line">还没记住关于你的事。</div>
          </div>
        )}
        {FACT_GROUPS.map((g) => {
          const list = about.filter((f) => f.cat === g.cat);
          if (!list.length) return null;
          return (
            <div class="cp-group" key={g.cat}>
              <div class="cp-group-t">{g.title}</div>
              <div class="plg-group">{list.map(row)}</div>
            </div>
          );
        })}
      </section>

      <section class="plg-sec">
        <h2 class="plg-sec-t">你们的经历 · {episodes.length}</h2>
        <div class="plg-group">{episodes.length ? episodes.map(row) : <div class="plg-empty-line">还没有一起的经历。</div>}</div>
      </section>

      {world.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">故事设定 · {world.length}</h2>
          <div class="plg-group">{world.map(row)}</div>
        </section>
      )}

      <ForgetBox onForget={(text) => apply({ action: 'forget', text }, '忘掉了')} />
      {memoryShare && (
        <div class="plg-actions">
          <button
            class="plg-btn"
            type="button"
            onClick={async () => {
              try {
                const v = await mutateMemory({ action: 'import-memory-share' });
                setData(v);
                showToast(v.imported ? `从「长期记忆」带过来 ${v.imported} 条` : '「长期记忆」里没有新的可以带过来');
              } catch (e) {
                showToast(errText(e));
              }
            }}
          >
            从「长期记忆」带过来
          </button>
        </div>
      )}
    </>
  );
}

function ImpressionEdit({ m, onSave }: { m: MemoryList; onSave: (short: string, impression: string) => void }) {
  const [short, setShort] = useState(m.profile.short);
  const [imp, setImp] = useState(m.profile.impression);
  return (
    <div class="plg-group sk-form">
      <label class="sk-field">
        <span>一句话印象</span>
        <input class="sf-input" type="text" maxLength={30} value={short} onInput={(e) => setShort((e.target as HTMLInputElement).value)} />
      </label>
      <label class="sk-field">
        <span>TA 对你的了解</span>
        <textarea class="sf-input area" rows={5} maxLength={300} value={imp} onInput={(e) => setImp((e.target as HTMLTextAreaElement).value)} />
        <small>{imp.length} / 300</small>
      </label>
      <div class="plg-actions cp-pad">
        <button class="plg-btn pri" type="button" onClick={() => onSave(short.trim(), imp.trim())}>
          保存
        </button>
      </div>
    </div>
  );
}

function AddFact({ onAdd }: { onAdd: (text: string, cat: FactCat) => void }) {
  const [text, setText] = useState('');
  const [cat, setCat] = useState<FactCat>('stable');
  return (
    <div class="plg-group sk-form cp-add">
      <label class="sk-field">
        <span>记下什么</span>
        <input class="sf-input" type="text" maxLength={60} placeholder="例如：不吃香菜" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
      </label>
      <div class="sk-field">
        <span>放在哪</span>
        <div class="cp-chips">
          {ADD_CATS.map((c) => (
            <button type="button" key={c.cat} aria-pressed={cat === c.cat} onClick={() => setCat(c.cat)}>
              {c.title}
            </button>
          ))}
        </div>
        <small>自己加的会钉住，TA 不会忘。</small>
      </div>
      <div class="plg-actions cp-pad">
        <button class="plg-btn pri" type="button" disabled={!text.trim()} onClick={() => onAdd(text.trim(), cat)}>
          记下
        </button>
      </div>
    </div>
  );
}

function ForgetBox({ onForget }: { onForget: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  return (
    <section class="plg-sec">
      <h2 class="plg-sec-t">让 TA 忘掉</h2>
      <div class="plg-group cp-forget">
        <input class="sf-input" type="text" maxLength={40} placeholder="说一句，比如「前任的事」" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button
          class="plg-btn"
          type="button"
          disabled={!text.trim()}
          onClick={() =>
            confirm(`让 TA 忘掉「${text.trim()}」？`, '和这句话有关的记忆都会删掉，找不回来。', '忘掉', async () => {
              if (await onForget(text.trim())) setText('');
            })
          }
        >
          忘掉
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 表达

const TONE: Record<string, string> = {
  playful: '俏皮',
  soft: '温柔',
  neutral: '',
};

function ExpressionRow({
  item,
  max,
  open,
  onOpen,
  apply,
}: {
  item: Expression;
  max: number;
  open: boolean;
  onOpen: () => void;
  apply: (body: Record<string, unknown>, done?: string) => Promise<boolean>;
}) {
  const slang = item.kind === 'slang';
  const [when, setWhen] = useState(item.when?.[0] ?? '');
  const [say, setSay] = useState(item.say);
  const [means, setMeans] = useState(item.means ?? '');
  useLayoutEffect(() => {
    setWhen(item.when?.[0] ?? '');
    setSay(item.say);
    setMeans(item.means ?? '');
  }, [item.id, open]);
  const fade = item.pinned ? 1 : Math.max(0.45, Math.min(1, 0.35 + (max ? item.weight / max : 1) * 0.65));
  const changed = say.trim() !== item.say || (slang ? means.trim() !== (item.means ?? '') : when.trim() !== (item.when?.[0] ?? ''));
  return (
    <div class={`cp-mem ${open ? 'open' : ''}`}>
      <button class="cp-mem-row" type="button" onClick={onOpen} aria-expanded={open}>
        <div class="cp-mem-m" style={{ opacity: fade }}>
          <div class="cp-mem-t">
            {slang ? (
              <>
                <b>{item.say}</b>：{item.means}
              </>
            ) : (
              <>
                {item.when?.[0] ?? '平时'} → 「{item.say}」
              </>
            )}
            {!slang && item.tone && TONE[item.tone] && <em class="tm-badge quiet">{TONE[item.tone]}</em>}
          </div>
          <div class="cp-mem-s">
            你说过 {item.n} 次{item.seen ? ` · 上次 ${ago(item.seen)}` : ''}
          </div>
        </div>
        {item.pinned && (
          <span class="cp-pin" aria-label="钉住了">
            <MIc n="pin" />
          </span>
        )}
      </button>
      {open && (
        <div class="cp-edit">
          {slang ? (
            <div class="cp-two">
              <input class="sf-input" type="text" maxLength={8} aria-label="黑话" value={say} onInput={(e) => setSay((e.target as HTMLInputElement).value)} />
              <input class="sf-input" type="text" maxLength={24} aria-label="意思" value={means} onInput={(e) => setMeans((e.target as HTMLInputElement).value)} />
            </div>
          ) : (
            <div class="cp-two">
              <input class="sf-input" type="text" maxLength={12} aria-label="什么时候" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} />
              <input class="sf-input" type="text" maxLength={16} aria-label="说法" value={say} onInput={(e) => setSay((e.target as HTMLInputElement).value)} />
            </div>
          )}
          <div class="cp-edit-row">
            <Switch on={item.pinned} label="钉住，不会淡" onChange={(v) => void apply({ action: 'pin', id: item.id, pinned: v }, v ? '钉住了' : '取消钉住')} />
            <span class="cp-edit-l">钉住</span>
          </div>
          <div class="plg-actions">
            <button
              class="plg-btn pri"
              type="button"
              disabled={!say.trim() || !changed}
              onClick={() =>
                void apply(
                  {
                    action: 'edit',
                    id: item.id,
                    say: say.trim(),
                    ...(slang ? { means: means.trim() } : { when: when.trim() }),
                  },
                  '已改好',
                )
              }
            >
              保存
            </button>
            <button class="plg-btn danger" type="button" onClick={() => confirm('删掉这一条？', '', '删除', () => void apply({ action: 'delete', id: item.id }, '已删除'))}>
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpressionTab() {
  const { data, setData, error, missing, reload } = useLoad(readExpression);
  const { data: o } = useLoad<Overview>(readOverview);
  const [open, setOpen] = useState<string | null>(null);
  const [teach, setTeach] = useState<'style' | 'slang' | null>(null);
  if (missing) return <Missing module="expression" />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!data) return <div class="plg-empty-line">正在读取…</div>;
  const apply = async (body: Record<string, unknown>, done?: string) => {
    try {
      setData(await mutateExpression(body));
      if (done) showToast(done);
      if (body.action !== 'pin') setOpen(null);
      return true;
    } catch (e) {
      showToast(errText(e));
      return false;
    }
  };
  const byWeight = (a: Expression, b: Expression) => b.weight - a.weight;
  const styles = data.items.filter((x) => x.kind === 'style').sort(byWeight);
  const slang = data.items.filter((x) => x.kind === 'slang').sort(byWeight);
  const max = Math.max(0, ...data.items.map((x) => x.weight));
  const bond = aspect<BondState>(o, 'bond');
  const row = (x: Expression) => <ExpressionRow key={x.id} item={x} max={max} open={open === x.id} onOpen={() => setOpen(open === x.id ? null : x.id)} apply={apply} />;
  return (
    <>
      <p class="plg-note">
        还不熟的时候，TA 只听得懂你的黑话；熟了才会借用你的说法。
        {bond ? `现在你们是「${bond.levelName}」。` : ''}
      </p>
      <section class="plg-sec">
        <div class="plg-shelf-h">
          <h2 class="plg-sec-t">说法 · {styles.length}</h2>
          <button class="plg-text-btn" type="button" onClick={() => setTeach(teach === 'style' ? null : 'style')}>
            {teach === 'style' ? '取消' : '教一句'}
          </button>
        </div>
        {teach === 'style' && <Teach kind="style" onTeach={async (b) => (await apply({ action: 'add', ...b }, '学会了')) && setTeach(null)} />}
        <div class="plg-group">{styles.length ? styles.map(row) : <div class="plg-empty-line">还没学到你的说法。</div>}</div>
      </section>
      <section class="plg-sec">
        <div class="plg-shelf-h">
          <h2 class="plg-sec-t">黑话 · {slang.length}</h2>
          <button class="plg-text-btn" type="button" onClick={() => setTeach(teach === 'slang' ? null : 'slang')}>
            {teach === 'slang' ? '取消' : '教一个'}
          </button>
        </div>
        {teach === 'slang' && <Teach kind="slang" onTeach={async (b) => (await apply({ action: 'add', ...b }, '记住了')) && setTeach(null)} />}
        <div class="plg-group">{slang.length ? slang.map(row) : <div class="plg-empty-line">还没有你们之间的黑话。</div>}</div>
      </section>
      <p class="plg-note foot">你常说的会越来越重，三周不说就淡一半；钉住的不会淡。</p>
    </>
  );
}

function Teach({ kind, onTeach }: { kind: 'style' | 'slang'; onTeach: (body: Record<string, string>) => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const slang = kind === 'slang';
  return (
    <div class="plg-group sk-form cp-add">
      <label class="sk-field">
        <span>{slang ? '词' : '什么时候'}</span>
        <input class="sf-input" type="text" maxLength={slang ? 8 : 12} placeholder={slang ? '小狗勾' : '被夸的时候'} value={a} onInput={(e) => setA((e.target as HTMLInputElement).value)} />
      </label>
      <label class="sk-field">
        <span>{slang ? '意思' : '会说'}</span>
        <input class="sf-input" type="text" maxLength={slang ? 24 : 16} placeholder={slang ? '撒娇时的自称' : '哼，那还用说'} value={b} onInput={(e) => setB((e.target as HTMLInputElement).value)} />
      </label>
      <div class="plg-actions cp-pad">
        <button class="plg-btn pri" type="button" disabled={!a.trim() || !b.trim()} onClick={() => onTeach(slang ? { say: a.trim(), means: b.trim() } : { when: a.trim(), say: b.trim() })}>
          {slang ? '记住' : '学会'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 主动

function InitiativeTab() {
  const { data: s, setData, error, missing, reload } = useLoad<InitiativeState>(readInitiative);
  const [busy, setBusy] = useState(false);
  if (missing) return <Missing module="initiative" />;
  if (error) return <Failed error={error} retry={reload} />;
  if (!s) return <div class="plg-empty-line">正在读取…</div>;
  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      setData(await mutateInitiative(body));
      showToast(done);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!s.enabled)
    return (
      <div class="plg-group cp-card">
        <div class="cp-big">已关闭</div>
        <div class="cp-line">TA 不会主动来找你。</div>
      </div>
    );
  const full = s.today >= s.perDay;
  return (
    <>
      {s.stopped && (
        <div class="plg-group cp-card">
          <div class="cp-big">TA 等你先开口</div>
          <div class="cp-line">你连着 {s.ignored} 次没回，TA 就不再主动了。</div>
          <div class="plg-actions">
            <button class="plg-btn pri" type="button" disabled={busy} onClick={() => void act({ action: 'resume' }, 'TA 会继续主动来找你')}>
              让 TA 继续主动
            </button>
          </div>
        </div>
      )}
      <div class="plg-group">
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">今天</div>
          </div>
          <span class="cp-v">
            {s.today} / {s.perDay} 次
          </span>
        </div>
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">下次</div>
          </div>
          <span class="cp-v">{s.stopped ? '等你先开口' : full ? '今天不会再来了' : s.nextAt ? `大约 ${hhmm(s.nextAt)}` : '还没想好'}</span>
        </div>
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">不打扰</div>
          </div>
          <span class="cp-v">{s.quiet}</span>
        </div>
      </div>
      {s.followups.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">约好的</h2>
          <div class="plg-group">
            {s.followups
              .slice()
              .sort((a, b) => a.at - b.at)
              .map((f, i) => (
                <div class="plg-row static" key={i}>
                  <div class="plg-row-m">
                    <div class="plg-row-t">
                      {hhmm(f.at)} 来问问你{f.reason}的事
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}
      <section class="plg-sec">
        <h2 class="plg-sec-t">先别来找我</h2>
        <div class="plg-actions cp-pause">
          {[2, 8, 24].map((h) => (
            <button class="plg-btn" type="button" key={h} disabled={busy} onClick={() => void act({ action: 'pause', hours: h }, `${h} 小时内 TA 不会主动来找你`)}>
              {h} 小时
            </button>
          ))}
          <button class="plg-btn" type="button" disabled={busy} onClick={() => void act({ action: 'pause', hours: 0 }, '好，TA 可以随时来找你')}>
            现在就可以
          </button>
        </div>
      </section>
      <p class="plg-note foot">手机上只有打开 DSMO 时 TA 才能主动，错过的时刻下次打开时会补上。每天几次、间隔和不打扰的时段，这一版只能看，不能改。</p>
    </>
  );
}

// ---------------------------------------------------------------- 学习与导入

const TYPES: {
  id: Exclude<TextType, 'session'>;
  title: string;
  hint: string;
}[] = [
  { id: 'aboutme', title: '关于我', hint: '你的自我介绍、喜好清单' },
  { id: 'backstory', title: '我们的过往', hint: '你们的关系设定、相识经过' },
  {
    id: 'story',
    title: '故事 / 剧情',
    hint: '你们一起写的故事，和你本人的事分开记',
  },
  {
    id: 'chatlog',
    title: '聊天记录',
    hint: '别处导出的聊天记录：「我：」「用户：」开头的算你说的，别的名字开头的算 TA',
  },
];
const TYPE_NAME: Record<TextType, string> = {
  aboutme: '关于我',
  backstory: '我们的过往',
  story: '故事',
  chatlog: '聊天记录',
  session: '这段对话',
};
const MAX_LEARN = 200_000;
const ACTIVE: Job['status'][] = ['queued', 'running'];

export function estimateLine(est: Job['est']) {
  const tokens = est.tokens >= 10_000 ? `${Math.round(est.tokens / 1000) / 10} 万` : `${est.tokens}`;
  return `大约调用模型 ${est.calls} 次、${tokens} token、${est.minutes} 分钟，用的是你当前的默认模型。`;
}

const jobs = signal<Job[] | null>(null);

function JobRow({ j }: { j: Job }) {
  const act = (action: 'cancel' | 'pause' | 'resume' | 'undo', done: string) => async () => {
    try {
      const v = await actOnJob(action, j.id);
      jobs.value = (jobs.value ?? []).map((x) => (x.id === v.id ? v : x));
      showToast(done);
    } catch (e) {
      showToast(errText(e));
    }
  };
  const undo = () => confirm('撤销这次学习？', '这次学到的记忆和说法都会删掉。', '撤销', () => void act('undo', '撤销了')());
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  const status: Record<Job['status'], string> = {
    queued: '排队中',
    running: `学习中 ${j.done} / ${j.total}`,
    paused: `已暂停 ${j.done} / ${j.total}`,
    done: `学完了，学到 ${j.added} 条`,
    failed: `没学完：${j.error ?? ''}`,
    cancelled: '已取消',
    undone: '已撤销',
  };
  return (
    <div class="cp-job">
      <div class="cp-job-h">
        <span class="cp-job-t">{j.title || TYPE_NAME[j.textType]}</span>
        <em class="tm-badge quiet">{TYPE_NAME[j.textType]}</em>
      </div>
      <div class={`cp-job-s ${j.status === 'failed' ? 'danger' : ''}`}>
        {status[j.status]}
        {j.errors > 0 && j.status !== 'failed' ? `，${j.errors} 块没学成` : ''}
      </div>
      {(j.status === 'running' || j.status === 'paused' || j.status === 'queued') && (
        <div class="cp-prog" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {j.status === 'failed' && /模型/.test(j.error ?? '') && <div class="cp-job-s">先在 DSMO 里随便聊一句，再回来点「撤销」后重新导入。</div>}
      <div class="cp-job-a">
        {j.status === 'queued' && (
          <button class="plg-text-btn" type="button" onClick={act('cancel', '取消了')}>
            取消
          </button>
        )}
        {j.status === 'running' && (
          <>
            <button class="plg-text-btn" type="button" onClick={act('pause', '暂停了')}>
              暂停
            </button>
            <button class="plg-text-btn" type="button" onClick={act('cancel', '取消了')}>
              取消
            </button>
          </>
        )}
        {j.status === 'paused' && (
          <>
            <button class="plg-text-btn" type="button" onClick={act('resume', '继续学了')}>
              继续
            </button>
            <button class="plg-text-btn" type="button" onClick={act('cancel', '取消了')}>
              取消
            </button>
          </>
        )}
        {j.status === 'done' && (
          <button class="plg-text-btn" type="button" onClick={() => (companionTab.value = 'memory')}>
            去记忆里看看
          </button>
        )}
        {(j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') && (
          <button class="plg-text-btn danger" type="button" onClick={undo}>
            撤销
          </button>
        )}
      </div>
    </div>
  );
}

/** While the tab shows and something is learning: GET /api/maidsh/jobs every 3 s (only while the page is visible). */
function useJobs() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        jobs.value = await readJobs();
      } catch (e) {
        if (e instanceof MaidshError && e.missing) setMissing(true);
      }
    };
    void tick();
    const t = setInterval(() => live && (jobs.value ?? []).some((j) => ACTIVE.includes(j.status)) && void tick(), 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return missing;
}

function LearnTab() {
  const missing = useJobs();
  const [type, setType] = useState<Exclude<TextType, 'session'>>('aboutme');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [est, setEst] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  if (missing) return <Missing module="core" />;
  const learnable = hasModule('memory') || hasModule('expression');
  const over = text.length > MAX_LEARN;

  const pick = async () => {
    try {
      const [f] = await native.pickDocuments(['.txt', '.md', 'text/plain', 'text/markdown']);
      if (!f) return;
      setText(await f.text());
      f.release?.();
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 40));
      setEst(null);
    } catch (e) {
      showToast(errText(e));
    }
  };
  const estimate = async () => {
    setBusy(true);
    try {
      const r = await learn({
        textType: type,
        title: title.trim(),
        text,
        dryRun: true,
      });
      if (!r.ok) return showToast(r.error ?? '估算失败');
      setEst(r.value as Job);
    } finally {
      setBusy(false);
    }
  };
  const start = async (force = false) => {
    setBusy(true);
    try {
      const r = await learn({
        textType: type,
        title: title.trim(),
        text,
        ...(force ? { force: true } : {}),
      });
      if (!r.ok) {
        if (r.duplicateOf && !force) return confirm('这份内容已经学过了', '再学一次会重复记下同样的东西。', '还是再学一次', () => void start(true), false);
        return showToast(r.error ?? '没能开始');
      }
      jobs.value = [r.value as Job, ...(jobs.value ?? []).filter((j) => j.id !== (r.value as Job).id)];
      setEst(null);
      setText('');
      setTitle('');
      showToast('开始学了，可以离开这一页');
    } finally {
      setBusy(false);
    }
  };

  const list = (jobs.value ?? []).slice().sort((a, b) => b.createdAt - a.createdAt);
  return (
    <>
      {!learnable && (
        <p class="plg-note">
          学到的东西会放进记忆和表达：先装「MaiDSH 记忆」或「MaiDSH 表达」。
          <button class="plg-text-btn" type="button" onClick={() => openPage(`plugin:${encodeURIComponent('@api-demo/maidsh-memory')}`)}>
            去插件市场
          </button>
        </p>
      )}
      <section class="plg-sec">
        <h2 class="plg-sec-t">喂给 TA 什么</h2>
        <div class="plg-group" role="radiogroup" aria-label="材料类型">
          {TYPES.map((t) => (
            <div
              class="plg-row"
              role="radio"
              tabIndex={0}
              aria-checked={type === t.id}
              key={t.id}
              onClick={() => {
                setType(t.id);
                setEst(null);
              }}
            >
              <div class="plg-row-m">
                <div class="plg-row-t">{t.title}</div>
                <div class="plg-row-s wrap">{t.hint}</div>
              </div>
              <span class="ps-check">{type === t.id && <MIc n="check" />}</span>
            </div>
          ))}
        </div>
        <p class="plg-note">
          「TA 是谁」的角色设定不在这里，
          <button class="plg-text-btn" type="button" onClick={() => openPage('persona')}>
            去「人设」
          </button>
        </p>
      </section>
      <div class="plg-group sk-form">
        <label class="sk-field">
          <span>标题（可以不填）</span>
          <input class="sf-input" type="text" maxLength={40} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </label>
        <label class="sk-field">
          <span>内容</span>
          <textarea
            class="sf-input area cp-learn-text"
            rows={8}
            placeholder="粘贴进来，或者选一个文本文件"
            value={text}
            onInput={(e) => {
              setText((e.target as HTMLTextAreaElement).value);
              setEst(null);
            }}
          />
          <small class={over ? 'ps-over' : ''}>
            {text.length.toLocaleString()} / {MAX_LEARN.toLocaleString()} 字{over ? '，太多了，请分几次' : ''}
          </small>
        </label>
      </div>
      {est && (
        <div class="plg-group cp-card cp-est">
          <div class="cp-line">{estimateLine(est.est)}</div>
          {est.duplicateOf && <div class="cp-line danger">这份内容已经学过了。</div>}
        </div>
      )}
      <div class="plg-actions">
        <button class="plg-btn" type="button" onClick={() => void pick()}>
          选文件
        </button>
        {est ? (
          <button class="plg-btn pri" type="button" disabled={busy} onClick={() => void start(false)}>
            开始学习
          </button>
        ) : (
          <button class="plg-btn pri" type="button" disabled={busy || !text.trim() || over || !learnable} onClick={() => void estimate()}>
            {busy ? '估算中…' : '先估算一下'}
          </button>
        )}
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">学习记录</h2>
        <div class="plg-group">{list.length ? list.map((j) => <JobRow key={j.id} j={j} />) : <div class="plg-empty-line">还没有。学的时候在后台慢慢跑，关掉 App 下次打开会接着学。</div>}</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 让 TA 深度学习这段对话

/** The open conversation's messages, for when the engine can't read it (an imported one). */
function messagesOfOpen(): {
  role: 'user' | 'assistant';
  text: string;
  at?: number;
}[] {
  const items = getTranscript()?.items ?? [];
  const out: { role: 'user' | 'assistant'; text: string; at?: number }[] = [];
  for (const it of items) {
    if (it.kind === 'user' && it.sourceKind === 'user' && it.text.trim()) out.push({ role: 'user', text: it.text, at: it.time });
    else if (it.kind === 'assistant' && it.text.trim()) out.push({ role: 'assistant', text: it.text, at: it.time });
  }
  return out;
}

/** Estimates, asks, then starts learning [sessionId]; progress is on 陪伴 › 学习与导入. */
export async function learnConversation(sessionId: string, title?: string) {
  let body: Record<string, unknown> = {
    kind: 'session',
    sessionId,
    title: title?.slice(0, 40),
  };
  let r = await learn({ ...body, dryRun: true });
  if (!r.ok && /读不到这段对话/.test(r.error ?? '') && sessionId === currentId.value) {
    const messages = messagesOfOpen();
    if (messages.length) {
      body = { kind: 'session', messages, title: title?.slice(0, 40) };
      r = await learn({ ...body, dryRun: true });
    }
  }
  if (r.status === 404) return showToast('这台主机还没有「MaiDSH 总控」，或者装好后引擎还没重启');
  if (!r.ok) return showToast(r.error ?? '没能估算');
  const est = r.value as Job;
  const go = async (force: boolean) => {
    const s = await learn({ ...body, ...(force ? { force: true } : {}) });
    if (!s.ok) {
      if (s.duplicateOf && !force) return confirm('这段对话已经学过了', '再学一次会重复记下同样的东西。', '还是再学一次', () => void go(true), false);
      return showToast(s.error ?? '没能开始');
    }
    showToast('TA 正在细读这段对话', '看进度', () => {
      companionTab.value = 'learn';
      pages.value = [...pages.value.filter((p) => !p.startsWith('companion')), 'companion:learn'];
    });
  };
  confirm(
    '让 TA 深度学习这段对话？',
    `${estimateLine(est.est)}${est.duplicateOf ? '这段对话已经学过了。' : ''}学到的会放进 TA 的记忆和表达，可以在「陪伴 › 学习与导入」里撤销。`,
    '开始',
    () => void go(false),
    false,
  );
}
