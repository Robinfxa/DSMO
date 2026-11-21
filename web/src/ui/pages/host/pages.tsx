// dsh-Go's engine pages, rebuilt in the bundled page (docs/native-pages.md,
// round 1): 自动化任务, 工作区, 引擎插件, 模型提供方, 引擎设置. They talk to the
// DSH Host directly, like every other page here; the same lists-and-rows idiom
// as 设置 and 插件.

import { COST_NOTE, netLine, replyLine, useProbe } from '../../probe';
import { PI_AI_NS, modelsOf, baseUrlError, createProvider, discoverModels, isPiAiNs, keyError, normalizeBaseUrl, normalizeKey, removeProvider, type DiscoveredModel, type ProviderApi } from '../../../engine/providers';
import { hasLore, readBindings, refreshWorks, workTitle } from '../../../lore/api';
import { chooseWork } from '../../lore/pick';
import { useEffect, useState } from 'preact/hooks';
import type { WorkspaceInfo } from '../../../engine/client';
import { askText, backPage, catalog, confirm, errText, getClient, openPage, openSession, pages, showToast } from '../../../state/store';
import { Switch, fmtTime } from '../../common';
import { sharePlugin } from '../../../share/pages';
import { MIc } from '../../mobile/MIc';
import { SchemaFields, parseSchema, text, type SchemaNode } from './schema';

const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown) => (typeof v === 'string' ? v : undefined);

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then(
      (d) => live && (setData(d), setError(null)),
      (e) => live && setError(errText(e)),
    );
    return () => void (live = false);
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

const Loading = ({ error }: { error?: string | null }) => <div class="plg-empty-line">{error ? `没能读到：${error}` : '正在读取…'}</div>;
const back = () => backPage();

// ================================================================ 自动化任务

const WD = ['', '一', '二', '三', '四', '五', '六', '日'];

export function timingText(r: Record<string, unknown>): string {
  const time = s(r.time)?.slice(0, 5);
  switch (r.kind) {
    case 'daily':
      return `每天 ${time}`;
    case 'weekly':
      return `每周${(Array.isArray(r.weekdays) ? r.weekdays : []).map((d) => WD[Number(d)]).join('、')} ${time}`;
    case 'every': {
      const sec = Number(r.everySeconds ?? 0);
      return sec >= 3600 && sec % 3600 === 0 ? `每 ${sec / 3600} 小时` : `每 ${Math.round(sec / 60)} 分钟`;
    }
    case 'cron':
      return `cron ${s(r.expression) ?? ''}`;
    case 'at':
    case 'after':
      return r.scheduledAt ? `${fmtTime(Date.parse(String(r.scheduledAt)))} 一次` : '一次';
    default:
      return String(r.kind ?? '');
  }
}
const targetText = (r: Record<string, unknown>) => {
  const k = s(o(r.target).kind);
  return k === 'new' ? '每次新开对话' : k === 'new_once' ? '新开一个对话' : '发到原对话';
};

export function SchedulesPage() {
  const { data, error, reload } = useLoad(() => getClient().scheduleCatalog());
  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, []);
  if (!data) return <Loading error={error} />;
  const active = data.filter((r) => r.status !== 'inactive');
  const done = data.filter((r) => r.status === 'inactive');
  return (
    <div class="plg">
      <div class="plg-group">
        <button class="plg-link" type="button" onClick={() => openPage('schedule-new')}>
          <span>新建自动化任务</span>
          <MIc n="plus" />
        </button>
      </div>
      {[
        ['进行中', active],
        ['已结束', done],
      ].map(([title, rows]) =>
        (rows as Record<string, unknown>[]).length ? (
          <section class="plg-sec" key={String(title)}>
            <h2 class="plg-sec-t">{title as string}</h2>
            <div class="plg-group">
              {(rows as Record<string, unknown>[]).map((r) => (
                <div class="plg-row" role="button" tabIndex={0} key={String(r.id)} onClick={() => openPage(`schedule:${r.id}`)}>
                  <span class="plg-tile">
                    <MIc n="clock" />
                  </span>
                  <div class="plg-row-m">
                    <div class="plg-row-t">{s(r.title) || s(r.prompt)?.split('\n')[0]}</div>
                    <div class="plg-row-s">
                      {timingText(r)} · {targetText(r)}
                    </div>
                  </div>
                  <MIc n="chevron" />
                </div>
              ))}
            </div>
          </section>
        ) : null,
      )}
      {!data.length && <p class="plg-note">还没有自动化任务。可以在这里新建，也可以在对话里让 AI 帮你定，或者去插件市场装一个。</p>}
    </div>
  );
}

export function ScheduleDetailPage({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => getClient().scheduleCatalog(), [id]);
  const hist = useLoad(() => getClient().scheduleHistory(id), [id]);
  const [busy, setBusy] = useState(false);
  if (!data) return <Loading error={error} />;
  const r = data.find((x) => x.id === id);
  if (!r) return <div class="plg-empty-line">这个任务已经删除了。</div>;
  const edit = async (patch: Record<string, unknown>, ok: string) => {
    try {
      const fresh = (await getClient().scheduleCatalog()).find((x) => x.id === id);
      await getClient().editSchedule(id, 'update', s(fresh?.updatedAt), patch);
      showToast(ok);
      reload();
    } catch (e) {
      showToast(errText(e));
    }
  };
  const canTime = r.kind === 'daily' || r.kind === 'weekly';
  const runs = (Array.isArray(o(hist.data).records) ? (o(hist.data).records as unknown[]) : []).map(o);
  return (
    <div class="plg">
      <div class="plg-group">
        <EditRow label="名称" value={s(r.title) ?? ''} onSave={(v) => edit({ title: v }, '已改名')} />
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">时间</div>
            <div class="plg-row-s">
              {timingText(r)} · {s(r.timeZone) ?? '本机时区'}
            </div>
          </div>
          {canTime && (
            <input
              class="sk-time"
              type="time"
              aria-label="时间"
              value={s(r.time)?.slice(0, 5) ?? ''}
              onChange={(e) => {
                const time = `${(e.target as HTMLInputElement).value}:00`;
                const sel = r.kind === 'daily' ? { time, time_zone: r.timeZone } : { time, time_zone: r.timeZone, weekdays: r.weekdays };
                void edit({ timing: { kind: r.kind, [String(r.kind)]: sel } }, '时间已更新');
              }}
            />
          )}
        </div>
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">发到哪里</div>
            <div class="plg-row-s">{targetText(r)}</div>
          </div>
        </div>
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">每次发送的内容</h2>
        <PromptEditor value={s(r.prompt) ?? ''} onSave={(v) => edit({ prompt: v }, '内容已保存')} />
      </section>
      <section class="plg-sec">
        <div class="plg-group">
          <button
            class="plg-link"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await getClient().runSchedule(id);
                showToast('已运行，新对话在边栏里');
                hist.reload();
              } catch (e) {
                showToast(errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <span>立即运行一次</span>
            <MIc n="chevron" />
          </button>
          <button
            class="plg-link danger"
            type="button"
            onClick={() =>
              confirm('删除这个自动化任务？', '运行记录会一起删除。', '删除', async () => {
                try {
                  await getClient().editSchedule(id, 'delete', s(r.updatedAt));
                  back();
                  showToast('已删除');
                } catch (e) {
                  showToast(errText(e));
                }
              })
            }
          >
            <span>删除</span>
          </button>
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">运行记录</h2>
        <div class="plg-group">
          {runs.map((x, i) => (
            <div class={`plg-row ${x.targetSessionId ? '' : 'static'}`} key={i} onClick={() => x.targetSessionId && (void openSession(String(x.targetSessionId)), (pages.value = []))}>
              <div class="plg-row-m">
                <div class="plg-row-t">{x.deliveredAt ? fmtTime(Date.parse(String(x.deliveredAt))) : '—'}</div>
                {x.prompt ? <div class="plg-row-s">{String(x.prompt).slice(0, 60)}</div> : null}
              </div>
              {x.targetSessionId ? <MIc n="chevron" /> : null}
            </div>
          ))}
          {!runs.length && <div class="plg-empty-line">{hist.error ? `没能读到：${hist.error}` : '还没有运行过。'}</div>}
        </div>
      </section>
    </div>
  );
}

export function ScheduleNewPage() {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'daily' | 'weekly' | 'every'>('daily');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([1]);
  const [hours, setHours] = useState(4);
  const [busy, setBusy] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const create = async () => {
    if (!prompt.trim()) return showToast('写一下每次要发的内容');
    setBusy(true);
    try {
      const timing =
        kind === 'every' ? { kind, every_seconds: hours * 3600 } : kind === 'daily' ? { kind, daily: { time: `${time}:00`, time_zone: tz } } : { kind, weekly: { time: `${time}:00`, time_zone: tz, weekdays: [...days].sort() } };
      await getClient().createSchedule({ title: title.trim() || prompt.trim().slice(0, 16), prompt: prompt.trim(), timing, target: { kind: 'new' } });
      showToast('已创建');
      back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      showToast(/unknown-endpoint/.test(code) ? '这台主机的 DSH 版本不能从这里创建（需要 0.2.2 以上），可以在对话里让 AI 帮你定' : errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="plg">
      <div class="plg-group">
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">名称</div>
          </div>
          <input class="sf-input" value={title} placeholder="例如：每日计划" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </div>
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">频率</div>
          </div>
          <select class="sf-select" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as typeof kind)}>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="every">每隔几小时</option>
          </select>
        </div>
        {kind === 'weekly' && (
          <div class="plg-row static">
            <div class="wd-pick">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button class={`wd ${days.includes(d) ? 'on' : ''}`} type="button" key={d} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) || [] : [...days, d])}>
                  {WD[d]}
                </button>
              ))}
            </div>
          </div>
        )}
        {kind === 'every' ? (
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">间隔（小时）</div>
            </div>
            <input class="sf-num" type="number" min={1} max={168} value={hours} onInput={(e) => setHours(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
          </div>
        ) : (
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">时间</div>
              <div class="plg-row-s">{tz}</div>
            </div>
            <input class="sk-time" type="time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
          </div>
        )}
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">每次发送的内容</h2>
        <div class="plg-group">
          <textarea class="sf-input area big" rows={5} value={prompt} placeholder="到点时 AI 会收到这段话，每次都在一个新对话里" onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} />
        </div>
      </section>
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={busy || (kind === 'weekly' && !days.length)} onClick={create}>
          {busy ? '正在创建…' : '创建'}
        </button>
      </div>
    </div>
  );
}

function EditRow({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState<string | null>(null);
  return (
    <div class="plg-row static">
      <div class="plg-row-m">
        <div class="plg-row-t">{label}</div>
      </div>
      <input
        class="sf-input"
        value={v ?? value}
        onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onBlur={() => {
          if (v !== null && v.trim() && v !== value) onSave(v.trim());
          setV(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

function PromptEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div class="plg-group">
      <textarea class="sf-input area big" rows={5} value={v} onInput={(e) => setV((e.target as HTMLTextAreaElement).value)} />
      {v !== value && v.trim() && (
        <div class="sf-save">
          <button class="plg-text-btn" type="button" onClick={() => setV(value)}>
            撤销
          </button>
          <button class="plg-text-btn" type="button" onClick={() => onSave(v.trim())}>
            保存
          </button>
        </div>
      )}
    </div>
  );
}

// ================================================================ 工作区

export function WorkspacesPage() {
  const [items, setItems] = useState<WorkspaceInfo[] | null>(null);
  useEffect(() => getClient().watchWorkspaces(setItems), []);
  // 设定集: which work each workspace uses (only when it's installed)
  const lore = hasLore();
  const [loreMap, setLoreMap] = useState<Record<string, string> | null>(null);
  const readLore = () => void Promise.all([readBindings(), refreshWorks()]).then(([b]) => setLoreMap(b.workspaces), () => setLoreMap(null));
  useEffect(() => void (lore && readLore()), [lore]);
  const loreLabel = (id: string) => {
    const v = loreMap?.[id];
    return v === undefined ? '跟随默认' : v === 'off' ? '关' : `《${workTitle(v) ?? '?'}》`;
  };
  if (!items) return <Loading />;
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) showToast(ok);
    } catch (e) {
      showToast(errText(e));
    }
  };
  return (
    <div class="plg">
      <div class="plg-group">
        <button class="plg-link" type="button" onClick={() => openPage('workspace-pick')}>
          <span>添加工作区</span>
          <MIc n="plus" />
        </button>
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">工作区</h2>
        <div class="plg-group">
          {items.map((w, i) => (
            <div class="ws" key={w.workspaceId}>
              <div class="plg-row static">
                <span class="plg-tile">
                  <MIc n="doc" />
                </span>
                <div class="plg-row-m">
                  <div class="plg-row-t">{w.title || w.path.split('/').pop()}</div>
                  <div class="plg-row-s mono">{w.path}</div>
                </div>
                <span class="plg-row-s">{w.sessionIds.length ? `${w.sessionIds.length} 个对话` : ''}</span>
              </div>
              <div class="ws-acts">
                <button
                  class="plg-text-btn"
                  type="button"
                  onClick={() =>
                    act(async () => {
                      const { sessionId } = await getClient().createSession({ workspaceId: w.workspaceId, cwd: w.path });
                      pages.value = [];
                      openSession(sessionId);
                    })
                  }
                >
                  在这里新建对话
                </button>
                <button
                  class="plg-text-btn"
                  type="button"
                  onClick={() => askText('工作区名称', w.title, (t) => void act(() => getClient().renameWorkspace(w.workspaceId, t), '已改名'))}
                >
                  改名
                </button>
                {i > 0 && (
                  <button class="plg-text-btn" type="button" onClick={() => act(() => getClient().moveWorkspace(w.workspaceId, items[i - 1].workspaceId))}>
                    上移
                  </button>
                )}
                {lore && loreMap && (
                  <button class="plg-text-btn" type="button" onClick={() => chooseWork({ kind: 'workspace', workspaceId: w.workspaceId }, readLore)}>
                    设定集：{loreLabel(w.workspaceId)}
                  </button>
                )}
                <span class="grow" />
                <button
                  class="plg-text-btn danger"
                  type="button"
                  onClick={() => confirm('移除这个工作区？', '只是不再列出，文件夹和里面的文件不会删除；里面的对话还在。', '移除', () => void act(() => getClient().deleteWorkspace(w.workspaceId), '已移除'))}
                >
                  移除
                </button>
              </div>
            </div>
          ))}
          {!items.length && <div class="plg-empty-line">还没有工作区。新对话默认在 ~/workspace。</div>}
        </div>
        <p class="plg-note">工作区是主机上的一个文件夹：在里面新建的对话，读写文件和运行命令都从这个文件夹开始。</p>
      </section>
    </div>
  );
}

export function DirectoryPickerPage() {
  const [path, setPath] = useState<string | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  const { data, error, reload } = useLoad(() => getClient().listDirectory(path), [path]);
  if (!data) return <Loading error={error} />;
  const crumbs = data.path.split('/').filter(Boolean);
  return (
    <div class="plg">
      <div class="dp-crumbs">
        <button type="button" onClick={() => setPath('/')}>
          根目录
        </button>
        {crumbs.map((c, i) => (
          <button type="button" key={i} onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>
            {c}
          </button>
        ))}
      </div>
      <div class="plg-group">
        {data.path !== '/' && (
          <button class="plg-link" type="button" onClick={() => setPath(data.path.split('/').slice(0, -1).join('/') || '/')}>
            <span>上一级</span>
            <MIc n="back" />
          </button>
        )}
        {data.entries
          .filter((e) => showHidden || !e.hidden)
          .map((e) => (
            <button class="plg-link" type="button" key={e.path} onClick={() => setPath(e.path)}>
              <span>{e.name}</span>
              <MIc n="chevron" />
            </button>
          ))}
        {!data.entries.filter((e) => showHidden || !e.hidden).length && <div class="plg-empty-line">这个文件夹是空的。</div>}
      </div>
      <div class="dp-tools">
        <button class="plg-text-btn" type="button" onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? '不显示隐藏文件夹' : '显示隐藏文件夹'}
        </button>
        <button
          class="plg-text-btn"
          type="button"
          onClick={() =>
            askText('新文件夹名称', '', async (name) => {
              try {
                const r = await getClient().createDirectory(data.path, name);
                setPath(s(r.path) ?? `${data.path}/${name}`);
                reload();
              } catch (e) {
                showToast(errText(e));
              }
            })
          }
        >
          新建文件夹
        </button>
      </div>
      <div class="plg-actions">
        <button
          class="plg-btn pri wide"
          type="button"
          onClick={async () => {
            try {
              const r = await getClient().createWorkspace(data.path);
              showToast(r.created ? '已添加工作区' : '这个文件夹已经是工作区了');
              back();
            } catch (e) {
              showToast(errText(e));
            }
          }}
        >
          把「{data.path.split('/').pop() || '/'}」作为工作区
        </button>
      </div>
    </div>
  );
}

// ================================================================ 引擎插件（引擎自己的插件，pluginManager）

export function EnginePluginsPage() {
  const { data, error, reload } = useLoad(() => getClient().listBundles());
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <Loading error={error} />;
  const title = (b: Record<string, unknown>) => text(o(b.meta).title) || s(b.name) || '';
  const groups: [string, Record<string, unknown>[]][] = [
    ['已装', data.filter((b) => b.installed !== false)],
    ['可以打开的官方插件', data.filter((b) => b.installed === false && b.optional)],
  ];
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      showToast(ok);
      reload();
    } catch (e) {
      showToast(errText(e));
    }
  };
  const install = async () => {
    const x = spec.trim();
    if (!x) return;
    setBusy(true);
    try {
      const info = await getClient().inspectBundle(x);
      confirm(
        `安装 ${s(info.name) ?? x}？`,
        `${s(info.version) ? `版本 ${info.version}。` : ''}${s(info.description) ?? ''}\n插件会在主机的引擎里运行，只装你信任的。`,
        '安装',
        () =>
          void run(async () => {
            await getClient().installBundle(x);
            setSpec('');
          }, '已安装，引擎会重新加载插件'),
        false,
      );
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="plg">
      {groups.map(([g, rows]) =>
        rows.length ? (
          <section class="plg-sec" key={g}>
            <h2 class="plg-sec-t">{g}</h2>
            <div class="plg-group">
              {rows.map((b) => (
                <div class="plg-row static" key={String(b.name)}>
                  <span class="plg-tile">
                    <MIc n="server" />
                  </span>
                  <div class="plg-row-m">
                    <div class="plg-row-t">{title(b)}</div>
                    <div class="plg-row-s wrap">
                      {[s(b.description), s(b.version) && `v${b.version}`, b.official ? '官方' : null].filter(Boolean).join(' · ')}
                    </div>
                    {b.readOnlyReason ? <div class="plg-row-s">{String(b.readOnlyReason)}</div> : null}
                  </div>
                  {b.installed === false ? (
                    <button class="plg-get" type="button" onClick={() => run(() => getClient().installBundle(String(b.name)), '已打开')}>
                      打开
                    </button>
                  ) : (
                    <>
                      {b.installed !== false && (b.official || typeof b.source === 'string') ? (
                        <button class="plg-text-btn" type="button" onClick={() => sharePlugin(b, title(b)) || showToast('本地安装的插件没法分享')}>
                          分享
                        </button>
                      ) : null}
                      {b.removable ? (
                        <button
                          class="plg-text-btn danger"
                          type="button"
                          onClick={() => confirm(`移除 ${title(b)}？`, '会从这台主机的引擎里卸载。', '移除', () => void run(() => getClient().removeBundle(String(b.name)), '已移除'))}
                        >
                          移除
                        </button>
                      ) : null}
                      <Switch on={b.enabled === true} label={`启用${title(b)}`} disabled={!!b.readOnlyReason} onChange={(v) => void run(() => getClient().setBundleEnabled(String(b.name), v), v ? '已启用' : '已停用')} />
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null,
      )}
      <section class="plg-sec">
        <h2 class="plg-sec-t">从 npm 安装</h2>
        <div class="plg-group">
          <div class="plg-row static npm-row">
            <input class="sf-input wide mono" value={spec} placeholder="包名，例如 dsh-plugin-foo@1.2.0" autoCapitalize="off" onInput={(e) => setSpec((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void install()} />
            <button class="plg-get" type="button" disabled={busy || !spec.trim()} onClick={install}>
              {busy ? '读取中' : '安装'}
            </button>
          </div>
        </div>
        <p class="plg-note">这里是装在引擎里的 DSH 插件（会在主机上运行代码）；换皮肤、加按钮这类前端插件在「插件」里。</p>
      </section>
    </div>
  );
}

// ================================================================ 引擎设置（settings/describe）

interface NsView {
  ns: string;
  title?: string;
  schema: SchemaNode;
  value: Record<string, unknown>;
  revision: number;
}
const toView = (n: Record<string, unknown>): NsView => ({ ns: String(n.ns ?? ''), title: s(n.title), schema: parseSchema(n.schema), value: o(n.value), revision: Number(n.revision ?? 0) });
const NS_NAME: Record<string, string> = { subagent: '子代理', 'cot-translation': '思考过程翻译', shell: '命令执行', 'pi-ai': '模型提供方', 'llm-pi-ai': '模型提供方' };
const nsTitle = (v: NsView) => v.title || text(v.schema.meta.title) || NS_NAME[v.ns] || v.ns;

export function EngineSettingsPage() {
  const { data, error } = useLoad(() => getClient().describeSettings());
  if (!data) return <Loading error={error} />;
  const views = (Array.isArray(data.namespaces) ? data.namespaces : []).map((n) => toView(o(n)));
  return (
    <div class="plg">
      {data.writable === false && <p class="plg-note warn">这台主机的配置是只读的，只能查看。</p>}
      <div class="plg-group">
        {views.map((v) => (
          <button class="plg-link" type="button" key={v.ns} onClick={() => openPage(`engine-settings:${v.ns}`)}>
            <span>
              {nsTitle(v)}
              <span class="plg-row-s mono"> {v.ns}</span>
            </span>
            <MIc n="chevron" />
          </button>
        ))}
        {!views.length && <div class="plg-empty-line">引擎没有可以设置的项目。</div>}
      </div>
      <p class="plg-note">这里是引擎插件自带的设置，改动马上生效，保存在主机上。</p>
    </div>
  );
}

export function EngineSettingsNsPage({ ns, path = [] }: { ns: string; path?: string[] }) {
  const [view, setView] = useState<NsView | null>(null);
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getClient()
      .describeSettings()
      .then((d) => {
        setWritable(d.writable !== false);
        const n = (Array.isArray(d.namespaces) ? d.namespaces : []).map((x) => toView(o(x))).find((x) => x.ns === ns);
        n ? setView(n) : setError('这一项已经不在了');
      }, (e) => setError(errText(e)));
  }, [ns]);
  if (!view) return <Loading error={error} />;
  const apply = async (ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[]) => {
    try {
      setView(toView(await getClient().mutateSettings(ns, ops, view.revision)));
    } catch (e) {
      showToast(errText(e));
      if (/conflict/.test((e as { code?: string }).code ?? '')) {
        const d = await getClient().describeSettings().catch(() => null);
        const n = d && (Array.isArray(d.namespaces) ? d.namespaces : []).map((x) => toView(o(x))).find((x) => x.ns === ns);
        if (n) setView(n);
      }
    }
  };
  // A sub-tree (a provider of pi-ai, say): the schema and value under [path].
  let node = view.schema;
  let value: unknown = view.value;
  for (const k of path) {
    node = node.type === 'dict' && node.inner ? node.inner : node.dict[k] ?? node;
    value = o(value)[k];
  }
  return (
    <div class="plg">
      <SchemaFields node={node} value={value} path={path} disabled={!writable} onSet={(p, v) => void apply([{ op: 'set', path: p, value: v }])} onUnset={(p) => void apply([{ op: 'unset', path: p }])} />
      {writable && path.length === 0 && (
        <div class="plg-group sf-reset">
          <button class="plg-link danger" type="button" onClick={() => confirm(`把「${nsTitle(view)}」恢复默认？`, '你改过的项目都会还原。', '恢复默认', () => void apply(Object.keys(view.value).map((k) => ({ op: 'unset' as const, path: [k] }))))}>
            <span>恢复默认</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ================================================================ 模型提供方

export function ProvidersPage() {
  const { data, error } = useLoad(() => getClient().listConfigurableProviders());
  if (!data) return <Loading error={error} />;
  return (
    <div class="plg">
      <div class="plg-group">
        {data.map((p) => {
          const own = isPiAiNs(s(p.settingsNs)) && Array.isArray(p.settingsPath) && p.settingsPath.length > 0;
          return (
            <div class={`plg-row ${own ? '' : 'static'}`} key={String(p.provider)} onClick={() => own && openPage(`provider:${p.provider}`)}>
              <span class="plg-tile">
                <MIc n="model" />
              </span>
              <div class="plg-row-m">
                <div class="plg-row-t">{s(p.displayName) ?? s(p.provider)}</div>
                <div class="plg-row-s">{s(p.error) ?? (own ? '自己加的' : s(p.defaultBaseURL) ?? '内置')}</div>
              </div>
              {own && <MIc n="chevron" />}
            </div>
          );
        })}
        <button class="plg-link" type="button" onClick={() => openPage('provider-new')}>
          <span>添加提供方</span>
          <MIc n="plus" />
        </button>
      </div>
      <p class="plg-note">DeepSeek 的密钥在「设置 › 账号管理」里填。这里加的是其他兼容 OpenAI 或 Anthropic 接口的服务，加好后在模型选择里就能看到。</p>
    </div>
  );
}

/** A provider's 测试连接: 网络连通 (its model list, free) and 真实小额测试 with one of its models. */
function ProviderTest({ id }: { id: string }) {
  const probe = useProbe();
  const models = modelsOf(id);
  const [model, setModel] = useState(models[0]?.id ?? '');
  const name = catalog.value?.groups.find((g) => g.id === id)?.name ?? id;
  return (
    <div class="plg prov-test">
      <section class="plg-sec">
        <h2 class="plg-sec-t">测试连接</h2>
        <div class="plg-group">
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">网络连通</div>
              <div class="plg-row-s wrap">{probe.running === 'net' ? '正在测试…' : probe.net ? netLine(probe.net) : '读一次模型列表，不花钱'}</div>
            </div>
            <button class="plg-btn sm" type="button" disabled={!!probe.running} onClick={() => void probe.runNet(id)}>
              测试
            </button>
          </div>
          {models.length > 1 && (
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-t">用哪个模型</div>
              </div>
              <select class="sf-select" aria-label="用哪个模型测试" value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">真实小额测试</div>
              <div class="plg-row-s wrap">{probe.running === 'reply' ? '正在发测试消息…' : probe.reply ? replyLine(probe.reply) : '发一条很短的消息，按正常价格计费'}</div>
            </div>
            <button
              class="plg-btn sm"
              type="button"
              disabled={!!probe.running || !model}
              onClick={() => confirm('发一条测试消息？', `让「${name} · ${models.find((m) => m.id === model)?.name ?? model}」回复一个「OK」，按正常价格计费，一般不到一分钱。测试用的对话结束后自动删掉。`, '发送', () => void probe.runReply(id, model))}
            >
              测试
            </button>
          </div>
        </div>
        <p class="plg-note">{COST_NOTE}</p>
      </section>
    </div>
  );
}

export function ProviderDetailPage({ id }: { id: string }) {
  return (
    <>
      <ProviderTest id={id} />
      <EngineSettingsNsPage ns={PI_AI_NS} path={['providers', id]} />
      <div class="plg">
        <div class="plg-group sf-reset">
          <button
            class="plg-link danger"
            type="button"
            onClick={() =>
              confirm(`删除提供方「${id}」？`, '用它的对话会换回默认模型。', '删除', async () => {
                try {
                  await removeProvider(id);
                  back();
                  showToast('已删除');
                } catch (e) {
                  showToast(errText(e));
                }
              })
            }
          >
            <span>删除这个提供方</span>
          </button>
        </div>
      </div>
    </>
  );
}

export function ProviderNewPage() {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [api, setApi] = useState<ProviderApi>('openai-completions');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<DiscoveredModel[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = discovering || saving;
  // a model added by hand joins the list, picked
  const addByHand = () =>
    askText('手动添加模型', '', (t) => {
      const id = t.trim();
      if (!id || /\s/.test(id)) return showToast('模型 ID 里不能有空格');
      if (models?.some((m) => m.id === id)) return showToast('已经在列表里了');
      setModels([...(models ?? []), { id }]);
      setPicked([...picked, id]);
      setProblem(null);
    }, { placeholder: '例如 gpt-4o-mini', ok: '添加' });
  const discover = async () => {
    const k = normalizeKey(key);
    const bad = baseUrlError(url) ?? keyError(k, true);
    if (bad) return setProblem(bad);
    setProblem(null);
    setNote(null);
    setDiscovering(true);
    try {
      const r = await discoverModels(api, url, k);
      if (r.baseUrl !== normalizeBaseUrl(url, api)) {
        setUrl(r.baseUrl);
        setNote(`地址已补全为 ${r.baseUrl}`);
      }
      setModels(r.models);
      setPicked(r.models.slice(0, 3).map((m) => m.id));
      if (!r.models.length) setProblem('接口没有列出模型。可以手动添加模型 ID。');
    } catch (e) {
      setProblem(`没能获取模型列表：${errText(e)}`);
    } finally {
      setDiscovering(false);
    }
  };
  const save = async () => {
    const k = normalizeKey(key);
    const bad = baseUrlError(url) ?? keyError(k, true) ?? (picked.length ? null : '至少选一个模型：先获取模型列表，或手动添加');
    if (bad) return setProblem(bad);
    setProblem(null);
    setSaving(true);
    try {
      const chosen = (models ?? []).filter((m) => picked.includes(m.id));
      await createProvider({ name, api, baseUrl: url, apiKey: k, models: chosen });
      showToast('已添加，在模型选择里就能看到');
      back();
    } catch (e) {
      setProblem(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const field = (label: string, v: string, set: (x: string) => void, ph: string, type: string) => (
    <div class="plg-row static" key={label}>
      <div class="plg-row-m">
        <div class="plg-row-t">{label}</div>
      </div>
      <input
        class="sf-input"
        type={type}
        autoComplete="off"
        autoCapitalize="off"
        spellcheck={false}
        value={v}
        placeholder={ph}
        onInput={(e) => (set((e.target as HTMLInputElement).value), setProblem(null))}
      />
    </div>
  );
  return (
    <div class="plg">
      <div class="plg-group">
        {field('名称', name, setName, '例如 芯云', 'text')}
        {field('接口地址', url, (x) => (setUrl(x), setNote(null)), 'https://api.example.com/v1', 'url')}
        {field('密钥', key, setKey, '只保存在主机上', 'password')}
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">接口协议</div>
          </div>
          <select class="sf-select" value={api} onChange={(e) => setApi((e.target as HTMLSelectElement).value as ProviderApi)}>
            <option value="openai-completions">OpenAI 兼容</option>
            <option value="anthropic-messages">Anthropic</option>
            <option value="openai-responses">OpenAI Responses</option>
          </select>
        </div>
      </div>
      {note && <p class="plg-note">{note}</p>}
      <section class="plg-sec">
        <h2 class="plg-sec-t">模型{models?.length ? ` · 已选 ${picked.length}` : ''}</h2>
        <div class="plg-group">
          {models?.map((m) => (
            <div class="plg-row static" key={m.id}>
              <div class="plg-row-m">
                <div class="plg-row-t mono">{m.id}</div>
                {m.name && <div class="plg-row-s">{m.name}</div>}
              </div>
              <Switch on={picked.includes(m.id)} label={m.id} onChange={(v) => (setPicked(v ? [...picked, m.id] : picked.filter((x) => x !== m.id)), setProblem(null))} />
            </div>
          ))}
          <button class="plg-link" type="button" disabled={busy || !url.trim()} onClick={() => void discover()}>
            <span>{discovering ? '正在获取…' : models ? '重新获取模型列表' : '从接口获取模型列表'}</span>
            <MIc n="refresh" />
          </button>
          <button class="plg-link" type="button" disabled={busy} onClick={addByHand}>
            <span>手动添加模型</span>
            <MIc n="plus" />
          </button>
        </div>
        {problem ? <p class="plg-note warn prov-problem">{problem}</p> : !models && <p class="plg-note">填好地址和密钥后获取。地址一般以 /v1 结尾；只填域名也行，获取时会自动试 /v1。</p>}
      </section>
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={busy} onClick={() => void save()}>
          {saving ? '正在添加…' : '添加'}
        </button>
      </div>
    </div>
  );
}
