// 技能: the skills the AI can use, and the person's own ones to write, edit and
// delete. A skill is a folder with a SKILL.md; the person's own live in the
// on-device engine's ~/.dsh/skills/, which DSH has no Remote for, so they are
// read and written through the app-local bridge (share.localFiles /
// share.writeSkill — the same folder, validation and backup as a share import)
// and deleted with skills.remove. Built-in and project skills come from the
// engine's skills/list and are read-only. On a remote host only the list shows.

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { native } from '../../bridge/native';
import type { SkillInfo } from '../../engine/client';
import { findPlugin, installed } from '../../plugins/frontend';
import { skillsInstallable } from '../../plugins/automation';
import { readLocalFiles, writeSkill, type LocalSkill } from '../../share/files';
import { MAX_FILE_CHARS, SKILL_NAME, SKILL_TEMPLATE, parseSkillMd, skillMd } from '../../skills/skillFile';
import { backPage, confirm, currentId, draft, errText, getClient, openPage, pages, sessions, showToast } from '../../state/store';
import { MIc } from '../mobile/MIc';

interface Listing {
  /** The person's own skills with their files; null when they can't be edited from here (a remote host). */
  mine: LocalSkill[] | null;
  /** What the engine offers (needs a conversation to ask); null when it couldn't be asked. */
  engine: SkillInfo[] | null;
}

/** The last listing, so the editor opens on the files the list just read. */
const listing = signal<Listing | null>(null);

async function load(): Promise<Listing> {
  const sid = currentId.value ?? sessions.value[0]?.sessionId;
  const [mine, engine] = await Promise.all([
    skillsInstallable()
      ? readLocalFiles().then((r) =>
          r.skills
            // the description as SKILL.md says it (quoted or folded YAML included), in folder order like dsh-Go
            .map((x) => ({ ...x, description: parseSkillMd(x.files['SKILL.md'] ?? '', x.name).description || x.description }))
            .sort((a, b) => (a.name < b.name ? -1 : 1)),
        )
      : Promise.resolve(null),
    sid
      ? getClient()
          .listSkills(sid)
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return (listing.value = { mine, engine });
}

/** The plugin that installed a skill (its record keeps the names it made). */
function fromPlugin(name: string): string | undefined {
  const rec = installed.value.find((x) => x.made?.skills?.includes(name));
  return rec ? findPlugin(rec.id)?.title : undefined;
}

const SOURCE: Record<string, string> = { bundled: '内置', builtin: '内置', project: '项目', plugin: '插件', user: '我的' };

export function useSkill(name: string) {
  draft.value = `/${name} `;
  pages.value = [];
  setTimeout(() => document.getElementById('input')?.focus(), 50);
}

function UseButton({ name }: { name: string }) {
  return (
    <button
      class="plg-get"
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        useSkill(name);
      }}
    >
      使用
    </button>
  );
}

export function SkillsPage() {
  const [data, setData] = useState<Listing | null>(listing.value);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    load().then(setData, (e) => setError(errText(e)));
  }, []);
  if (!data) return <div class="plg-empty-line">{error ?? '正在读取…'}</div>;

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (name: string, desc = '') => words.every((w) => `${name}\n${desc}`.toLowerCase().includes(w));
  const mineNames = new Set((data.mine ?? []).map((s) => s.name));
  const mine = (data.mine ?? []).filter((s) => hit(s.name, s.description));
  // On a remote host the person's own skills are only in the engine's list.
  const remoteMine = data.mine ? [] : (data.engine ?? []).filter((s) => s.source === 'user' && hit(s.name, s.description));
  const others = (data.engine ?? []).filter((s) => s.source !== 'user' && !mineNames.has(s.name) && hit(s.name, s.description));
  const total = (data.mine?.length ?? 0) + (data.engine ?? []).filter((s) => !mineNames.has(s.name)).length;

  return (
    <div class="plg">
      <p class="plg-note">技能是写给 AI 的做事方法。AI 遇到对得上的请求会自己用；也可以在输入框里输入 /名字 直接用。</p>
      {total > 6 && (
        <label class="hist-find plg-find">
          <MIc n="search" />
          <input type="search" placeholder="搜索技能" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} enterKeyHint="search" />
        </label>
      )}

      <section class="plg-sec">
        <h2 class="plg-sec-t">我的技能</h2>
        <div class="plg-group">
          {data.mine ? (
            <>
              {mine.map((s) => {
                const plugin = fromPlugin(s.name);
                return (
                  <div class="plg-row" role="button" tabIndex={0} key={s.name} onClick={() => openPage(`skill:${s.name}`)}>
                    <span class="plg-tile">
                      <MIc n="bolt" />
                    </span>
                    <div class="plg-row-m">
                      <div class="plg-row-t">
                        {s.name}
                        {plugin && <em class="tm-badge">来自「{plugin}」</em>}
                      </div>
                      <div class="plg-row-s">{s.description || `${Object.keys(s.files).length} 个文件`}</div>
                    </div>
                    <div class="plg-row-e">
                      <UseButton name={s.name} />
                    </div>
                  </div>
                );
              })}
              {!mine.length && <div class="plg-empty-line">{q ? '没有对得上的技能。' : '还没有自己的技能。'}</div>}
              <button class="plg-link" type="button" onClick={() => openPage('skill:new')}>
                <span>
                  新建技能
                  <small>写下 AI 遇到某类事时该怎么做</small>
                </span>
                <MIc n="chevron" />
              </button>
            </>
          ) : (
            <>
              {remoteMine.map((s) => (
                <SkillRow key={s.name} s={s} />
              ))}
              <div class="plg-empty-line">技能文件在这台主机上，这里只能查看和使用。切到本机时可以在这里新建和编辑；也可以在主机上改 ~/.dsh/skills/。</div>
            </>
          )}
        </div>
      </section>

      {others.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">内置和项目里的</h2>
          <div class="plg-group">
            {others.map((s) => (
              <SkillRow key={s.name} s={s} />
            ))}
          </div>
        </section>
      )}
      {!data.engine && <p class="plg-note">打开或新建一个对话后，这里还会列出引擎内置的技能。</p>}
    </div>
  );
}

/** A skill this page can't edit: what it does, where it comes from, and 使用. */
function SkillRow({ s }: { s: SkillInfo }) {
  return (
    <div class="plg-row static">
      <span class="plg-tile">
        <MIc n="bolt" />
      </span>
      <div class="plg-row-m">
        <div class="plg-row-t">
          {s.name}
          {s.source && SOURCE[s.source] && <em class="tm-badge">{SOURCE[s.source]}</em>}
        </div>
        <div class="plg-row-s wrap">{s.description}</div>
      </div>
      <div class="plg-row-e">
        <UseButton name={s.name} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editor

interface Draft {
  name: string;
  description: string;
  body: string;
  extra: string[];
  /** The skill's other files, kept as they are. */
  files: Record<string, string>;
}

export function SkillEditPage({ name }: { name: string }) {
  const isNew = name === 'new';
  const [d, setD] = useState<Draft | null>(isNew ? { name: '', description: '', body: SKILL_TEMPLATE, extra: [], files: {} } : null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    const open = (l: Listing) => {
      const s = l.mine?.find((x) => x.name === name);
      if (!s) return setError('这个技能已经不在了');
      const doc = parseSkillMd(s.files['SKILL.md'] ?? '', s.name);
      const { 'SKILL.md': _, ...rest } = s.files;
      const next = { name: s.name, description: doc.description, body: doc.body, extra: doc.extra, files: rest };
      setD(next);
      setSaved(JSON.stringify(next));
    };
    if (listing.value?.mine) open(listing.value);
    else load().then(open, (e) => setError(errText(e)));
  }, [name]);

  if (error) return <div class="plg-empty-line">{error}</div>;
  if (!d) return <div class="plg-empty-line">正在读取…</div>;
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const dirty = isNew || JSON.stringify(d) !== saved;
  const plugin = isNew ? undefined : fromPlugin(name);
  const md = skillMd({ name: d.name.trim(), description: d.description.trim(), body: d.body, extra: d.extra });
  const others = Object.keys(d.files);

  const save = async () => {
    const n = d.name.trim();
    if (!SKILL_NAME.test(n)) return showToast('名字只能用英文字母、数字和 - _ .，开头是字母或数字');
    if (!d.description.trim()) return showToast('写一句什么时候用它，AI 靠这句话判断');
    if (!d.body.trim() || d.body.trim() === SKILL_TEMPLATE.trim()) return showToast('先写一下做法');
    if (md.length > MAX_FILE_CHARS) return showToast(`太长了（${md.length} 字），一个文件最多 ${MAX_FILE_CHARS} 字`);
    const write = async () => {
      setBusy(true);
      try {
        await writeSkill({ name: n, files: { ...d.files, 'SKILL.md': md } });
        await load();
        showToast(isNew ? `已新建「${n}」` : '已保存');
        if (isNew) {
          backPage();
          openPage(`skill:${n}`);
        } else setSaved(JSON.stringify(d));
      } catch (e) {
        showToast(errText(e));
      } finally {
        setBusy(false);
      }
    };
    if (isNew && listing.value?.mine?.some((s) => s.name === n)) confirm(`已经有「${n}」了`, '换掉的话，原来的会移到 ~/.dsh/backups/。', '换掉', () => void write());
    else void write();
  };

  const remove = () =>
    confirm(`删除「${name}」？`, plugin ? `它是插件「${plugin}」装的，卸载插件时也会删掉。` : '技能文件夹会被删掉。', '删除', async () => {
      try {
        await native.removeSkills([name]);
        const after = await load();
        if (after.mine?.some((s) => s.name === name)) return showToast('这个技能在 ~/.agents/skills/ 里，这里删不掉');
        showToast('已删除');
        backPage();
      } catch (e) {
        showToast(errText(e));
      }
    });

  return (
    <div class="plg">
      {plugin && <p class="plg-note">这个技能是插件「{plugin}」装的。可以改，但卸载插件时会一起删掉。</p>}
      <div class="plg-group sk-form">
        <label class="sk-field">
          <span>名字</span>
          {isNew ? (
            <input
              class="sf-input"
              type="text"
              maxLength={64}
              autoCapitalize="off"
              autoCorrect="off"
              spellcheck={false}
              placeholder="例如 weekly-report"
              value={d.name}
              onInput={(e) => set({ name: (e.target as HTMLInputElement).value })}
            />
          ) : (
            <code class="sk-name">/{d.name}</code>
          )}
          {isNew && <small>英文字母、数字和 - _ .，在输入框里用 /名字 调用</small>}
        </label>
        <label class="sk-field">
          <span>什么时候用</span>
          <textarea
            class="sf-input area sk-desc"
            rows={2}
            maxLength={1024}
            placeholder="例如：用户要写周报、总结这周做了什么时"
            value={d.description}
            onInput={(e) => set({ description: (e.target as HTMLTextAreaElement).value })}
          />
          <small>AI 靠这句话判断要不要用这个技能，写清楚是哪类请求</small>
        </label>
        <label class="sk-field">
          <span>做法</span>
          <textarea class="sf-input area ske-body" rows={14} value={d.body} onInput={(e) => set({ body: (e.target as HTMLTextAreaElement).value })} />
          <small>
            {md.length} / {MAX_FILE_CHARS} 字 · 支持 Markdown
          </small>
        </label>
        {others.length > 0 && (
          <div class="sk-field">
            <span>附带的文件</span>
            <small>{others.join('、')}（保存时原样保留）</small>
          </div>
        )}
      </div>
      <div class="plg-actions">
        <button class={`plg-btn ${dirty ? 'pri' : ''}`} type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? '保存中' : isNew ? '新建' : dirty ? '保存' : '已保存'}
        </button>
        {!isNew && (
          <button class="plg-btn" type="button" disabled={busy} onClick={() => useSkill(name)}>
            在对话里用
          </button>
        )}
        {!isNew && (
          <button class="plg-btn danger" type="button" disabled={busy} onClick={remove}>
            删除
          </button>
        )}
      </div>
      {!isNew && <p class="plg-note foot">保存时，改动前的版本会移到 ~/.dsh/backups/。</p>}
    </div>
  );
}
