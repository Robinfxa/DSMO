// 长期记忆 (plugin 「长期记忆」): what dsh-plugin-memory-share keeps and puts into every
// conversation. The package registers a Remote namespace on the engine:
//
//   memoryShare/list                → { entries: [{id, text, scope, tier, tags, …}], total, counts, dataDir }
//   memoryShare/update {id, text}   → { ok }
//   memoryShare/forget {id}         → { removed }
//
// It has no "create": a memory needs a scope and a source, which the AI's memory_save tool
// decides. So 让它记住… hands the AI a 「记住：」 line instead of a form.

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { DshRemoteError } from '../../engine/errors';
import { backPage, confirm, draft, errText, getClient, openPage, pages, showToast } from '../../state/store';
import { MIc } from '../mobile/MIc';

export interface Memory {
  id: string;
  text: string;
  scope: 'user' | 'workspace' | 'session';
  tier: 'hot' | 'cold';
  tags: string[];
  updatedAt: number;
  ttlDays?: number;
}
interface MemoryList {
  entries: Memory[];
  dataDir: string;
}

const SCOPE: Record<Memory['scope'], { title: string; note: string }> = {
  user: { title: '关于你', note: '每个对话都会用到' },
  workspace: { title: '某个工作区', note: '只在那个文件夹的对话里用' },
  session: { title: '某个对话', note: '只在那一个对话里用' },
};
const TIER: Record<Memory['tier'], string> = { hot: '常驻', cold: '按话题' };

const memories = signal<MemoryList | null>(null);
const failure = signal<string | null>(null);

function readList(v: unknown): MemoryList {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const entries = (Array.isArray(m.entries) ? m.entries : []).map((x) => {
    const e = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return {
      id: String(e.id ?? ''),
      text: String(e.text ?? ''),
      scope: e.scope === 'workspace' || e.scope === 'session' ? e.scope : 'user',
      tier: e.tier === 'hot' ? 'hot' : 'cold',
      tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
      ...(typeof e.ttlDays === 'number' ? { ttlDays: e.ttlDays } : {}),
    } as Memory;
  });
  return { entries: entries.filter((e) => e.id), dataDir: String(m.dataDir ?? '') };
}

async function refresh() {
  try {
    memories.value = readList(await getClient().call('memoryShare/list', {}));
    failure.value = null;
  } catch (e) {
    // the package isn't loaded: not installed, or installed and the engine not restarted yet
    failure.value = e instanceof DshRemoteError && /unknown|not-found|no-such|endpoint/i.test(e.code) ? 'missing' : errText(e);
  }
}

const when = (t: number) => (t ? new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }) : '');

function askToRemember() {
  draft.value = '记住：';
  pages.value = [];
  setTimeout(() => {
    const el = document.getElementById('input') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, 50);
}

function Waiting() {
  if (failure.value === 'missing')
    return (
      <div class="plg">
        <p class="plg-note">还没装「长期记忆」插件，或者装好后引擎还没重启。</p>
        <div class="plg-actions">
          <button class="plg-btn pri" type="button" onClick={() => openPage('plugins')}>
            去插件市场
          </button>
          <button class="plg-btn" type="button" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </div>
    );
  if (failure.value)
    return (
      <div class="plg-empty-line">
        没能读取记忆：{failure.value}
        <button class="plg-text-btn" type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  return <div class="plg-empty-line">正在读取…</div>;
}

// ---------------------------------------------------------------- 长期记忆: the list

export function LongMemoryPage() {
  const [q, setQ] = useState('');
  useEffect(() => void refresh(), []);
  const m = memories.value;
  if (!m) return <Waiting />;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = m.entries.filter((e) => words.every((w) => `${e.text}\n${e.tags.join(' ')}`.toLowerCase().includes(w)));
  // hot first, then the newest
  const order = (a: Memory, b: Memory) => (a.tier === b.tier ? b.updatedAt - a.updatedAt : a.tier === 'hot' ? -1 : 1);

  return (
    <div class="plg">
      <p class="plg-note">AI 记住的事会带进之后的对话里。「常驻」的每次都带上，「按话题」的聊到相关的事才带。想让它记住或忘掉什么，也可以直接跟它说。</p>
      {m.entries.length > 6 && (
        <label class="hist-find plg-find">
          <MIc n="search" />
          <input type="search" placeholder="搜索记忆" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} enterKeyHint="search" />
        </label>
      )}
      {!m.entries.length && (
        <div class="plg-empty">
          <span>还没有记住什么</span>
        </div>
      )}
      {q && !shown.length && m.entries.length > 0 && <div class="plg-empty-line">没有对得上的记忆。</div>}
      {(['user', 'workspace', 'session'] as const).map((scope) => {
        const list = shown.filter((e) => e.scope === scope).sort(order);
        if (!list.length) return null;
        return (
          <section class="plg-sec" key={scope}>
            <h2 class="plg-sec-t">
              {SCOPE[scope].title} · {list.length}
            </h2>
            <div class="plg-group">
              {list.map((e) => (
                <div class="plg-row" role="button" tabIndex={0} key={e.id} onClick={() => openPage(`memory:${e.id}`)}>
                  <div class="plg-row-m">
                    <div class="plg-row-t mem-text">{e.text}</div>
                    <div class="plg-row-s">
                      {[TIER[e.tier], ...e.tags.slice(0, 3)].join(' · ')}
                      {e.updatedAt ? ` · ${when(e.updatedAt)}` : ''}
                    </div>
                  </div>
                  <MIc n="chevron" />
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" onClick={askToRemember}>
          <MIc n="plus" />
          让它记住…
        </button>
      </div>
      {m.dataDir && <p class="plg-note foot">记忆存在主机的 {m.dataDir}/memories.json 里。</p>}
    </div>
  );
}

// ---------------------------------------------------------------- memory:<id>: edit or forget one

export function LongMemoryEditPage({ id }: { id: string }) {
  const e = memories.value?.entries.find((x) => x.id === id);
  const [text, setText] = useState(e?.text ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!memories.value) void refresh();
  }, []);
  useEffect(() => {
    if (e && !text) setText(e.text);
  }, [e?.id]);
  if (!memories.value) return <Waiting />;
  if (!e) return <div class="plg-empty-line">这条记忆已经不在了</div>;
  const dirty = text.trim() !== e.text;

  const save = async () => {
    const t = text.trim();
    if (!t) return showToast('写点什么，或者点「忘掉」');
    setBusy(true);
    try {
      const r = (await getClient().call('memoryShare/update', { id, text: t })) as { ok?: boolean };
      if (r && r.ok === false) throw new Error('这条记忆已经不在了');
      await refresh();
      showToast('已保存');
      backPage();
    } catch (err) {
      showToast(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const forget = () =>
    confirm('忘掉这条记忆？', '之后的对话里不会再带上它。', '忘掉', async () => {
      try {
        await getClient().call('memoryShare/forget', { id });
        await refresh();
        showToast('已忘掉');
        backPage();
      } catch (err) {
        showToast(errText(err));
      }
    });

  return (
    <div class="plg">
      <div class="plg-group sk-form">
        <label class="sk-field">
          <span>内容</span>
          <textarea class="sf-input area mem-edit" rows={5} value={text} onInput={(ev) => setText((ev.target as HTMLTextAreaElement).value)} />
        </label>
        <div class="sk-field">
          <span>用在哪里</span>
          <small>
            {SCOPE[e.scope].title}：{SCOPE[e.scope].note}；{e.tier === 'hot' ? '常驻，每次都带上' : '按话题，聊到相关的事才带'}
            {e.ttlDays ? `；${e.ttlDays} 天后过期` : ''}
            {e.tags.length ? `；标签 ${e.tags.join('、')}` : ''}
          </small>
        </div>
      </div>
      <div class="plg-actions">
        <button class={`plg-btn ${dirty ? 'pri' : ''}`} type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? '保存中' : '保存'}
        </button>
        <button class="plg-btn danger" type="button" disabled={busy} onClick={forget}>
          忘掉
        </button>
      </div>
    </div>
  );
}
