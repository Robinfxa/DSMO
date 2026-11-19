// 人设 (plugin 「人设库」): the community persona library dsh-persona-dafeiyu runs on the host and
// adds the chosen persona to every turn's system prompt. Its own settings and chips are DSH Web
// UI, which DSMO doesn't render, so this page drives its loopback API through the local proxy:
//
//   GET  /api/dsh-persona-dafeiyu/status          current persona, the list (metadata only)
//   GET  /api/dsh-persona-dafeiyu/persona?id=…    one persona's text
//   POST /api/dsh-persona-dafeiyu/mutate          {action: set-current | import | rename | remove, …}
//
// `set-current` with `id: null` switches personas off. The package writes only on JSON same-origin
// requests (its CSRF guard); the proxy's requests are both.

import { useEffect, useState } from 'preact/hooks';
import { confirm, errText, openPage, showToast } from '../../state/store';
import { MIc } from '../mobile/MIc';

const BASE = '/api/dsh-persona-dafeiyu';
/** The persona text the package accepts at most (its MAX_PERSONA_CHARS is larger; keep prompts short). */
const MAX_CHARS = 8000;

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

async function mutate(body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mutate`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
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

/** The first `# 人设：名字` line (the package's file format), for a name when none is typed. */
function nameFromText(text: string): string {
  const m = text.match(/^#\s*人设[:：]\s*(.+)$/m);
  return (m?.[1] ?? '').trim().slice(0, 24);
}

export function PersonaPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState<'missing' | string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<{ name: string; text: string } | null>(null);
  const [draft, setDraft] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setStatus(readStatus(await getJson(`${BASE}/status`)));
      setFailed(null);
    } catch (e) {
      setFailed((e as Error).message === 'missing' ? 'missing' : errText(e));
    }
  };
  useEffect(() => void load(), []);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await mutate(body);
      showToast(done);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
      void load();
    }
  };
  const show = async (p: Persona) => {
    try {
      const one = (await getJson(`${BASE}/persona?id=${encodeURIComponent(p.id)}`)) as Record<string, unknown>;
      setView({ name: p.name, text: typeof one.text === 'string' ? one.text : '（读不到正文）' });
    } catch (e) {
      showToast(errText(e));
    }
  };
  const save = async () => {
    if (!draft) return;
    const text = draft.text.trim();
    const name = (draft.name.trim() || nameFromText(text)).slice(0, 24);
    if (!name) return showToast('给人设起个名字');
    if (!text || text === PERSONA_TEMPLATE.trim()) return showToast('先写一下人设内容');
    if (text.length > MAX_CHARS) return showToast(`人设太长了（${text.length} 字），请控制在 ${MAX_CHARS} 字以内`);
    setBusy(true);
    try {
      await mutate({ action: 'import', name, text });
      // Use it right away: the new one is the imported persona with that name.
      const next = readStatus(await getJson(`${BASE}/status`));
      const made = [...next.personas].reverse().find((p) => p.name === name && !p.builtin);
      if (made) await mutate({ action: 'set-current', id: made.id });
      setDraft(null);
      showToast(`已启用「${name}」`);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
      void load();
    }
  };

  if (failed === 'missing')
    return (
      <div class="plg">
        <p class="plg-note">还没装「人设库」插件，或者装好后引擎还没重启。</p>
        <div class="plg-actions">
          <button class="plg-btn pri" type="button" onClick={() => openPage('plugins')}>
            去插件市场
          </button>
          <button class="plg-btn" type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    );
  if (failed && !status)
    return (
      <div class="plg-empty-line">
        没能读取人设：{failed}
        <button class="plg-text-btn" type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  if (!status) return <div class="plg-empty-line">正在读取…</div>;

  if (view)
    return (
      <div class="plg">
        <div class="plg-group">
          <pre class="dnd-cmd">{view.text}</pre>
        </div>
        <div class="plg-actions">
          <button class="plg-btn" type="button" onClick={() => setView(null)}>
            返回
          </button>
        </div>
      </div>
    );

  if (draft)
    return (
      <div class="plg">
        <p class="plg-note">照下面的格式写，每一节都可以删改。写好后会立刻用在之后的每一句话里。</p>
        <div class="plg-group">
          <input
            class="sf-input"
            type="text"
            maxLength={24}
            placeholder="名字（不填就用「# 人设：」后面那个）"
            value={draft.name}
            onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })}
          />
          <textarea
            class="sf-input area"
            rows={16}
            value={draft.text}
            onInput={(e) => setDraft({ ...draft, text: (e.target as HTMLTextAreaElement).value })}
          />
          <p class="dnd-fine">{draft.text.length} / {MAX_CHARS} 字</p>
        </div>
        <div class="plg-actions">
          <button class="plg-btn pri" type="button" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中' : '保存并启用'}
          </button>
          <button class="plg-btn" type="button" disabled={busy} onClick={() => setDraft(null)}>
            取消
          </button>
        </div>
      </div>
    );

  return (
    <div class="plg">
      <p class="plg-note">
        {status.globalOff ? '现在没有启用人设。' : `现在的人设：${status.currentName ?? status.current}。`}
        选好的人设会带进之后的每一句话里。
      </p>
      <div class="plg-group">
        <div class="plg-row" role="button" tabIndex={0} onClick={() => !status.globalOff && void act({ action: 'set-current', id: null }, '已关闭人设')}>
          <div class="plg-row-m">
            <div class="plg-row-t">
              不启用人设
              {status.globalOff && <em class="tm-badge">使用中</em>}
            </div>
            <div class="plg-row-s">按 AI 原本的样子回答</div>
          </div>
        </div>
        {status.personas.map((p) => {
          const isOpen = open === p.id;
          const using = !status.globalOff && p.current;
          return (
            <div key={p.id}>
              <div class="plg-row" role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>
                <div class="plg-row-m">
                  <div class="plg-row-t">
                    {p.name}
                    {using && <em class="tm-badge">使用中</em>}
                    {p.builtin && <em class="tm-badge">示例</em>}
                  </div>
                  <div class="plg-row-s wrap">{p.description || `${p.chars} 字`}</div>
                </div>
                <span class={`dnd-arrow ${isOpen ? 'open' : ''}`}>
                  <MIc n="chevron" />
                </span>
              </div>
              {isOpen && (
                <div class="dnd-panel">
                  <div class="dnd-next-a">
                    <button class="plg-btn pri" type="button" disabled={busy || using} onClick={() => void act({ action: 'set-current', id: p.id }, `已启用「${p.name}」`)}>
                      {using ? '使用中' : '使用这个人设'}
                    </button>
                    <button class="plg-btn" type="button" onClick={() => void show(p)}>
                      查看内容
                    </button>
                    {!p.builtin && p.source !== 'config' && (
                      <button
                        class="plg-btn danger"
                        type="button"
                        disabled={busy}
                        onClick={() => confirm(`删除「${p.name}」？`, '删除后不能恢复。', '删除', () => void act({ action: 'remove', id: p.id }, '已删除'))}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-link" type="button" onClick={() => setDraft({ name: '', text: PERSONA_TEMPLATE })}>
            <span>
              新建人设
              <small>写下 TA 是谁、性格和说话方式，也可以把别处的人设粘贴进来</small>
            </span>
            <MIc n="chevron" />
          </button>
        </div>
      </section>
    </div>
  );
}
