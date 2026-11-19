// 人设 (plugin 「人设库」): the community persona library dsh-persona-dafeiyu runs on the host and
// adds the chosen persona to every turn's system prompt. Its own settings and chips are DSH Web
// UI, which DSMO doesn't render, so these pages drive its loopback API through the local proxy:
//
//   GET  /api/dsh-persona-dafeiyu/status          current persona, the list (metadata only)
//   GET  /api/dsh-persona-dafeiyu/persona?id=…    one persona's text
//   POST /api/dsh-persona-dafeiyu/mutate          {action: set-current | import | rename | remove, …}
//
// `set-current` with `id: null` switches personas off. The package writes only on JSON same-origin
// requests (its CSRF guard); the proxy's requests are both. It has no "edit text" action: an edit
// imports the new text under a temporary name, moves the choice to it, removes the old one and
// renames the new one back.
//
// Pages: 人设 (choose; › for details), persona:<id> (the text; use / edit / copy / delete),
// persona-edit:new | persona-edit:<id> | persona-edit:copy:<id> (name and text).

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { dsBot } from '../../bots/store';
import { personaSkipBots, setPersonaSkipBots } from '../../plugins/conflicts';
import { backPage, confirm, errText, openPage, showToast } from '../../state/store';
import { Switch } from '../common';
import { MIc } from '../mobile/MIc';

const BASE = '/api/dsh-persona-dafeiyu';
/** What these pages let a persona be (the package takes up to 64 000; every character goes into every turn). */
export const MAX_CHARS = 20_000;
/** The package's MAX_PERSONA_NAME. */
const MAX_NAME = 60;

interface Persona {
  id: string;
  name: string;
  source: string;
  builtin: boolean;
  enabled: boolean;
  current: boolean;
  chars: number;
  description?: string;
}
interface Status {
  globalOff: boolean;
  current: string | null;
  currentName: string | null;
  personas: Persona[];
}

export const PERSONA_TEMPLATE = `# 人设：

## 你是谁
（名字、年龄、身份，和我是什么关系）

## 性格
-
-

## 说话风格
（怎么称呼我、口头禅、语气，会不会用颜文字）

## 对话示例
我：今天好累
你：

## 边界
（不会做的事、不会说的话）
`;

/** The package answers `{ok: true, value}` or `{ok: false, error}` (HTTP 200 either way). */
async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (res.status === 404) throw new Error('missing');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { ok?: boolean; value?: unknown; error?: string };
  if (j.ok === false) throw new Error(j.error || '人设库没有回应');
  return j.value ?? j;
}

/** One change; the package answers with the new status. */
async function mutate(body: Record<string, unknown>): Promise<Status> {
  const res = await fetch(`${BASE}/mutate`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; value?: unknown };
  if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
  return (status.value = j.value ? readStatus(j.value) : await refresh());
}

function readStatus(v: unknown): Status {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const list = Array.isArray(m.personas) ? m.personas : [];
  return {
    globalOff: m.globalOff === true || m.current === null,
    current: typeof m.current === 'string' ? m.current : null,
    currentName: typeof m.currentName === 'string' ? m.currentName : null,
    personas: list.map((p) => {
      const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      return {
        id: String(x.id ?? ''),
        name: String(x.name ?? x.id ?? ''),
        source: String(x.source ?? ''),
        builtin: x.builtin === true,
        enabled: x.enabled !== false,
        current: x.current === true,
        chars: typeof x.chars === 'number' ? x.chars : 0,
        description: typeof x.description === 'string' ? x.description : undefined,
      };
    }),
  };
}

/** Shared by the three pages; the list reloads it when it opens. */
const status = signal<Status | null>(null);
const failure = signal<string | null>(null);

async function refresh(): Promise<Status> {
  try {
    const s = readStatus(await getJson(`${BASE}/status`));
    failure.value = null;
    return (status.value = s);
  } catch (e) {
    failure.value = (e as Error).message === 'missing' ? 'missing' : errText(e);
    throw e;
  }
}

async function readText(id: string): Promise<string> {
  const one = (await getJson(`${BASE}/persona?id=${encodeURIComponent(id)}`)) as Record<string, unknown>;
  return typeof one.text === 'string' ? one.text : '';
}

const inUse = (s: Status, p: Persona) => !s.globalOff && p.current;
/** Only personas the person added can be edited, renamed or deleted (the package's rules). */
const own = (p: Persona) => !p.builtin && p.source !== 'config';
const sourceLabel = (p: Persona) => (p.builtin ? '示例' : p.source === 'config' ? '配置文件' : null);

/** The first `# 人设：名字` line (the package's file format), for a name when none is typed. */
function nameFromText(text: string): string {
  const m = text.match(/^#\s*人设[:：]\s*(.+)$/m);
  return (m?.[1] ?? '').trim().slice(0, MAX_NAME);
}

function Missing() {
  return (
    <div class="plg">
      <p class="plg-note">还没装「人设库」插件，或者装好后引擎还没重启。</p>
      <div class="plg-actions">
        <button class="plg-btn pri" type="button" onClick={() => openPage('plugins')}>
          去插件市场
        </button>
        <button class="plg-btn" type="button" onClick={() => void refresh().catch(() => {})}>
          重试
        </button>
      </div>
    </div>
  );
}

/** While the status loads, or when it can't. */
function Waiting() {
  if (failure.value === 'missing') return <Missing />;
  if (failure.value)
    return (
      <div class="plg-empty-line">
        没能读取人设：{failure.value}
        <button class="plg-text-btn" type="button" onClick={() => void refresh().catch(() => {})}>
          重试
        </button>
      </div>
    );
  return <div class="plg-empty-line">正在读取…</div>;
}

// ---------------------------------------------------------------- 人设: choose

export function PersonaPage() {
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => void refresh().catch(() => {}), []);
  const s = status.value;
  if (!s) return <Waiting />;

  const choose = async (id: string | null, name: string) => {
    if (busy) return;
    setBusy(id ?? 'off');
    try {
      await mutate({ action: 'set-current', id });
      showToast(id ? `已启用「${name}」` : '已关闭人设');
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="plg">
      <p class="plg-note">选好的人设会带进之后的每一句话里：AI 会用 TA 的身份、性格和说话方式来回答。</p>
      <div class="plg-group" role="radiogroup" aria-label="人设">
        <div class="plg-row" role="radio" tabIndex={0} aria-checked={s.globalOff} onClick={() => !s.globalOff && void choose(null, '')}>
          <div class="plg-row-m">
            <div class="plg-row-t">不启用人设</div>
            <div class="plg-row-s">按 AI 原本的样子回答</div>
          </div>
          <span class="ps-check">{busy === 'off' ? <span class="spin" /> : s.globalOff && <MIc n="check" />}</span>
        </div>
        {s.personas.map((p) => {
          const on = inUse(s, p);
          const tag = sourceLabel(p);
          return (
            <div class="plg-row ps-row" role="radio" tabIndex={0} aria-checked={on} key={p.id} onClick={() => !on && void choose(p.id, p.name)}>
              <div class="plg-row-m">
                <div class="plg-row-t">
                  {p.name}
                  {tag && <em class="tm-badge quiet">{tag}</em>}
                </div>
                <div class="plg-row-s">{p.description || `${p.chars} 字`}</div>
              </div>
              <span class="ps-check">{busy === p.id ? <span class="spin" /> : on && <MIc n="check" />}</span>
              <button
                class="ps-more"
                type="button"
                aria-label={`${p.name}的详情`}
                onClick={(e) => {
                  e.stopPropagation();
                  openPage(`persona:${p.id}`);
                }}
              >
                <MIc n="chevron" />
              </button>
            </div>
          );
        })}
      </div>
      {(dsBot.value.team?.bots.length ?? 0) > 0 && <BotsSwitch />}
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" onClick={() => openPage('persona-edit:new')}>
          <MIc n="plus" />
          新建人设
        </button>
      </div>
      <p class="plg-note foot">可以照模板写，也可以把别处写好的人设整段粘贴进来，最多 {MAX_CHARS.toLocaleString()} 字。</p>
    </div>
  );
}

/** 和 DS Bot：each Bot has its own role; the persona would go into its conversations too. */
function BotsSwitch() {
  const [busy, setBusy] = useState(false);
  const on = personaSkipBots.value;
  const set = async (v: boolean) => {
    setBusy(true);
    try {
      await setPersonaSkipBots(v);
      showToast(v ? 'Bot 的对话里不再用人设' : 'Bot 的对话也会用人设');
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="plg-sec">
      <h2 class="plg-sec-t">和 DS Bot</h2>
      <div class="plg-group">
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">Bot 的对话里不用人设</div>
            <div class="plg-row-s wrap">{on ? '每个 Bot 按自己的角色和说明来，人设只用在你自己的对话里。' : '现在人设也会加进 Bot 的对话，可能盖过 Bot 自己的角色和说明。'}</div>
          </div>
          <Switch on={on} label="Bot 的对话里不用人设" disabled={busy} onChange={(v) => void set(v)} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- persona:<id>: details

export function PersonaDetailPage({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!status.value) void refresh().catch(() => {});
    readText(id).then(setText, (e) => setError(errText(e)));
  }, [id]);
  const s = status.value;
  const p = s?.personas.find((x) => x.id === id);
  if (!s) return <Waiting />;
  if (!p) return <div class="plg-empty-line">这个人设已经不在了</div>;
  const on = inUse(s, p);

  const use = async () => {
    setBusy(true);
    try {
      await mutate({ action: 'set-current', id: p.id });
      showToast(`已启用「${p.name}」`);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = () =>
    confirm(`删除「${p.name}」？`, on ? '它正在使用，删掉后会换回默认的人设。删除后不能恢复。' : '删除后不能恢复。', '删除', async () => {
      try {
        await mutate({ action: 'remove', id: p.id });
        showToast('已删除');
        backPage();
      } catch (e) {
        showToast(errText(e));
      }
    });

  return (
    <div class="plg">
      <div class="ps-head">
        <div class="ps-name">
          {p.name}
          {on && <em class="tm-badge">使用中</em>}
          {sourceLabel(p) && <em class="tm-badge quiet">{sourceLabel(p)}</em>}
        </div>
        <div class="ps-meta">{p.chars.toLocaleString()} 字</div>
      </div>
      <div class="plg-group">{error ? <div class="plg-empty-line">读不到正文：{error}</div> : <pre class="ps-text">{text ?? '正在读取…'}</pre>}</div>
      <div class="plg-actions">
        <button class={`plg-btn ${on ? '' : 'pri'}`} type="button" disabled={busy || on} onClick={() => void use()}>
          {on ? '使用中' : '使用这个人设'}
        </button>
        {own(p) ? (
          <button class="plg-btn" type="button" disabled={text === null} onClick={() => openPage(`persona-edit:${p.id}`)}>
            编辑
          </button>
        ) : (
          <button class="plg-btn" type="button" disabled={text === null} onClick={() => openPage(`persona-edit:copy:${p.id}`)}>
            复制一份来改
          </button>
        )}
        {own(p) && (
          <button class="plg-btn danger" type="button" onClick={remove}>
            删除
          </button>
        )}
      </div>
      {!own(p) && <p class="plg-note foot">{p.builtin ? '示例人设不能直接改，可以复制一份改成自己的。' : '这个人设来自插件的配置文件，在主机上改那份文件。'}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- persona-edit:…: name and text

export function PersonaEditPage({ target }: { target: string }) {
  const isNew = target === 'new';
  const copyOf = target.startsWith('copy:') ? target.slice('copy:'.length) : null;
  const editId = isNew || copyOf ? null : target;
  const [name, setName] = useState('');
  const [text, setText] = useState<string | null>(isNew ? PERSONA_TEMPLATE : null);
  const [orig, setOrig] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    const id = copyOf ?? editId!;
    (async () => {
      const s = status.value ?? (await refresh());
      const p = s.personas.find((x) => x.id === id);
      if (!p) throw new Error('这个人设已经不在了');
      const t = await readText(id);
      setName(copyOf ? `${p.name}（我的）`.slice(0, MAX_NAME) : p.name);
      setText(t);
      if (editId) setOrig({ name: p.name, text: t });
    })().catch((e) => setError(errText(e)));
  }, [target]);

  if (error) return <div class="plg-empty-line">{error}</div>;
  if (text === null) return <div class="plg-empty-line">正在读取…</div>;
  const over = text.length > MAX_CHARS;

  const save = async () => {
    const body = text.trim();
    const n = (name.trim() || nameFromText(body)).slice(0, MAX_NAME);
    if (!n) return showToast('给人设起个名字');
    if (!body || body === PERSONA_TEMPLATE.trim()) return showToast('先写一下人设内容');
    if (body.length > MAX_CHARS) return showToast(`人设太长了（${body.length.toLocaleString()} 字），请控制在 ${MAX_CHARS.toLocaleString()} 字以内`);
    setBusy(true);
    try {
      if (!editId) {
        // New (or a copy): add it and use it right away.
        const after = await mutate({ action: 'import', name: n, text: body });
        const made = [...after.personas].reverse().find((p) => p.name === n && own(p));
        if (made) await mutate({ action: 'set-current', id: made.id });
        showToast(`已启用「${n}」`);
        backPage();
        if (copyOf) backPage();
        return;
      }
      const textChanged = body !== orig!.text.trim();
      if (!textChanged) {
        if (n !== orig!.name) await mutate({ action: 'rename', id: editId, name: n });
        showToast('已保存');
        backPage();
        return;
      }
      // The text changed: add the new version beside the old (names are unique), move the
      // choice over if the old one was in use, remove the old one, then take the name.
      const wasOn = (() => {
        const s = status.value!;
        const p = s.personas.find((x) => x.id === editId);
        return !!p && inUse(s, p);
      })();
      const temp = `${n.slice(0, MAX_NAME - 6)} ·${Date.now().toString(36).slice(-4)}`;
      const after = await mutate({ action: 'import', name: temp, text: body });
      const made = [...after.personas].reverse().find((p) => p.name === temp);
      if (!made) throw new Error('新版本没有存进去');
      if (wasOn) await mutate({ action: 'set-current', id: made.id });
      await mutate({ action: 'remove', id: editId });
      await mutate({ action: 'rename', id: made.id, name: n });
      showToast('已保存');
      // the details page was for the old id
      backPage();
      backPage();
      openPage(`persona:${made.id}`);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="plg">
      {isNew && <p class="plg-note">照下面的格式写，每一节都可以删改；也可以把别处写好的人设整段粘贴进来。</p>}
      <div class="plg-group sk-form">
        <label class="sk-field">
          <span>名字</span>
          <input class="sf-input" type="text" maxLength={MAX_NAME} placeholder="不填就用「# 人设：」后面那个" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label class="sk-field">
          <span>人设内容</span>
          <textarea class="sf-input area ps-edit" rows={18} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <small class={over ? 'ps-over' : ''}>
            {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} 字{over ? '，超出了' : ''}
          </small>
        </label>
      </div>
      <div class="plg-actions">
        <button class="plg-btn pri" type="button" disabled={busy || over} onClick={() => void save()}>
          {busy ? '保存中' : editId ? '保存' : '保存并启用'}
        </button>
        <button class="plg-btn" type="button" disabled={busy} onClick={backPage}>
          取消
        </button>
      </div>
    </div>
  );
}
