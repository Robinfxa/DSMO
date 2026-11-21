import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { native } from '../../bridge/native';
import type { JobInfo } from '../../engine/client';
import type { LogEvent } from '../../engine/events';
import { dshGoPanels } from '../../plugins/dshgo';
import { PluginDetailPage, PluginGuidePage, PluginManagePage, PluginsPage } from '../../plugins/PluginsPage';
import { findPlugin } from '../../plugins/frontend';
import { ImportRunPage, ImportedChatPage, ImportedListPage } from '../../history/ui';
import {
  DirectoryPickerPage,
  EnginePluginsPage,
  EngineSettingsNsPage,
  EngineSettingsPage,
  ProviderDetailPage,
  ProviderNewPage,
  ProvidersPage,
  ScheduleDetailPage,
  ScheduleNewPage,
  SchedulesPage,
  WorkspacesPage,
} from './host/pages';
import { TerminalPage } from './host/terminal';
import { AccessPage, EnginePage, HostEditPage, HostsPage, NotifySettingsPage, PhonePage, UpdatePage, VoiceSettingsPage } from './host/local';
import { A11yRestorePage, AndroidShellPage, PhoneDndPage, PhoneLogPage } from './host/phone';
import { PresetsPage, TeamPage } from './agents';
import { CompanionPage } from './companion';
import { LongMemoryEditPage, LongMemoryPage } from './memory';
import { LoreCardPage, LoreCharacterPage, LoreEntryPage, LoreImportPage, LoreWorkActions, LoreWorkPage, LoreWorksActions, LoreWorksPage, loreWorkTitle } from './lore';
import { PersonaDetailPage, PersonaEditPage, PersonaPage } from './persona';
import { SkillEditPage, SkillInfoPage, SkillsPage } from './skills';
import { imported } from '../../history/imported';
import { exportConversations, exportFileName } from '../../history/export';
import { ShareImportPage, ShareOpenPage, ShareOutPage, ShareProfilePage } from '../../share/pages';
import { BotChatPage, BotDetailsPage, BotModelPage, BotsHomePage, FolderPage, MemoryPage, NewBotPage, NewRoomPage, RoomChatPage, RoomDetailsPage, botStatusLine, homeSub, roomStatusLine } from '../../bots/pages';
import { dsBot } from '../../bots/store';
import { FailureLogPage } from '../../setup/recovery';
import { MIc } from '../mobile/MIc';
import {
  LOCATION_TAG,
  backPage,
  currentId,
  errText,
  getClient,
  getTranscript,
  openOverlay,
  openPage,
  openSession,
  pages,
  sessions,
  setPermission,
  showToast,
  txVersion,
} from '../../state/store';
import { describeTool } from '../Chat';
import { Empty, Ic, Lrow, Switch, fmtSize, fmtTime, useAsync } from '../common';
import { hiddenByPlugin, setSiderShown, siderHidden, siderRows, siderShown } from '../siderFeats';
import { Protected } from '../Protected';
import { CATALOG, catalogItem, nativePlaceholder, openFeature, type PageDef } from './registry';

const sid = () => currentId.value;

export const PAGES: Record<string, PageDef> = {
  features: { title: '全部功能', body: FeaturesPage },
  'sider-feats': { title: '边栏功能区', body: SiderFeatsPage },
  native: { title: '原生页面', body: NativePage },
  plugins: { title: '插件', body: PluginsPage },
  'session-detail': { title: '对话详情', session: true, body: DetailPage },
  artifacts: { title: '产出的文件', session: true, body: ArtifactsPage },
  files: { title: '文件', session: true, body: FilesPage },
  export: { title: '导出对话日志', session: true, body: ExportPage },
  jobs: { title: '后台任务', session: true, body: JobsPage },
  'plan-goal': { title: '计划与目标', session: true, body: PlanGoalPage },
  skills: { title: '技能', body: SkillsPage },
  subagents: { title: '子代理', session: true, body: SubagentsPage },
  reference: { title: '引用文件和对话', body: ReferencePage },
  permission: { title: '权限', sub: () => '执行前是否确认', session: true, body: PermissionPage },
  // dsh-Go's engine pages, rebuilt here (docs/native-pages.md)
  schedules: { title: '自动化任务', body: SchedulesPage },
  'schedule-new': { title: '新建自动化任务', body: ScheduleNewPage },
  workspaces: { title: '工作区', body: WorkspacesPage },
  'workspace-pick': { title: '选择文件夹', body: DirectoryPickerPage },
  'engine-plugins': { title: '引擎插件', body: EnginePluginsPage },
  'engine-settings': { title: '引擎设置', body: EngineSettingsPage },
  providers: { title: '模型提供方', body: ProvidersPage },
  'provider-new': { title: '添加提供方', body: ProviderNewPage },
  terminal: { title: '终端', session: true, body: TerminalPage },
  // round 2: the phone's own state, through the app-local bridge
  hosts: { title: '远程主机', body: HostsPage },
  engine: { title: '本机引擎', body: EnginePage },
  'notify-settings': { title: '通知', body: NotifySettingsPage },
  'voice-settings': { title: '识别方式', body: VoiceSettingsPage },
  update: { title: '检查更新', body: UpdatePage },
  access: { title: '系统权限', body: AccessPage },
  phone: { title: '手机操控', body: PhonePage },
  'phone-dnd': { title: '不打扰模式', body: PhoneDndPage },
  'agent-team': { title: '智能体团队', body: TeamPage },
  presets: { title: 'Agent 预设', body: PresetsPage },
  persona: { title: '人设', body: PersonaPage },
  memory: { title: '长期记忆', body: LongMemoryPage },
  companion: { title: '陪伴', body: () => <CompanionPage /> },
  'companion:learn': { title: '陪伴', body: () => <CompanionPage tab="learn" /> },
  'phone-a11y-restore': { title: '自动恢复无障碍', body: A11yRestorePage },
  'phone-shell': { title: 'Android Shell', body: AndroidShellPage },
  'phone-log': { title: '操作记录', body: PhoneLogPage },
  'engine-log': { title: '失败前后的日志', body: FailureLogPage },
  'share-profile': { title: '分享配置', body: ShareProfilePage },
  'share-out': { title: '分享码', body: ShareOutPage },
  'share-open': { title: '打开分享码', body: ShareOpenPage },
  'share-import': { title: '导入', body: ShareImportPage },
  bots: { title: 'DS Bot', sub: homeSub, body: BotsHomePage },
  'bot-new': { title: '新建 Bot', body: NewBotPage },
  'room-new': { title: '新建群聊', body: NewRoomPage },
};

/** Pages with a parameter: `plugin:<id>` (detail), `plugin-manage:<id>` (its 管理 page), `plugin-guide:<id>` (使用说明). */
function pageDef(id: string | undefined): PageDef | undefined {
  if (!id) return undefined;
  if (id.startsWith('memory:')) {
    const mid = id.slice('memory:'.length);
    return { title: '记忆', body: () => <LongMemoryEditPage id={mid} /> };
  }
  if (id.startsWith('persona-edit:')) {
    const t = id.slice('persona-edit:'.length);
    return { title: t === 'new' ? '新建人设' : t.startsWith('copy:') ? '复制人设' : '编辑人设', body: () => <PersonaEditPage target={t} /> };
  }
  if (id.startsWith('persona:')) {
    const pid = id.slice('persona:'.length);
    return { title: '人设详情', body: () => <PersonaDetailPage id={pid} /> };
  }
  if (id.startsWith('skill-info:')) {
    const name = id.slice('skill-info:'.length);
    return { title: name, body: () => <SkillInfoPage name={name} /> };
  }
  if (id.startsWith('skill:')) {
    const name = id.slice('skill:'.length);
    return { title: name === 'new' ? '新建技能' : name, body: () => <SkillEditPage name={name} /> };
  }
  if (id === 'lore') return { title: '设定集', actions: () => <LoreWorksActions />, body: LoreWorksPage };
  if (id === 'lore-import' || id.startsWith('lore-import:')) {
    const w = id.slice('lore-import:'.length) || undefined;
    return { title: w ? `导入到${loreWorkTitle(w)}` : '导入角色卡或世界书', body: () => <LoreImportPage work={id === 'lore-import' ? undefined : w} /> };
  }
  const lo = /^lore(-char|-entry|-card)?:([^:]+)(?::(.+))?$/.exec(id);
  if (lo) {
    const [, kind, w, x] = lo;
    if (!kind) return { title: '设定集', actions: () => <LoreWorkActions id={w} />, body: () => <LoreWorkPage id={w} /> };
    if (kind === '-char') return { title: '人物', body: () => <LoreCharacterPage work={w} id={x ?? ''} /> };
    if (kind === '-card') return { title: x === 'new' ? '新人物' : '编辑人物', body: () => <LoreCardPage work={w} id={x ?? 'new'} /> };
    return { title: x === 'new' ? '新建设定' : '设定', body: () => <LoreEntryPage work={w} id={x ?? 'new'} /> };
  }
  if (id === 'imported') return { title: '保存在这台设备上的对话', body: ImportedListPage };
  if (id === 'import-run') return { title: '导入历史对话', body: ImportRunPage };
  if (id.startsWith('imported:')) {
    const iid = id.slice('imported:'.length);
    return { title: imported.value.find((c) => c.id === iid)?.title ?? '导入的对话', body: () => <ImportedChatPage id={iid} /> };
  }
  if (id.startsWith('host-edit:')) {
    const hid = id.slice('host-edit:'.length);
    return { title: hid === 'new' ? '添加 SSH 主机' : '编辑主机', body: () => <HostEditPage id={hid} /> };
  }
  const bt = /^(bot|room|bot-details|room-details|bot-model|bot-folder|bot-memory):(.+)$/.exec(id);
  if (bt) {
    const [, kind, arg] = bt;
    const team = dsBot.value.team;
    const name = (x: string) => team?.bots.find((b) => b.id === x)?.name ?? team?.rooms.find((r) => r.id === x)?.name ?? '';
    const details = (to: string) => () => (
      <button class="ib xl" type="button" aria-label="详情" onClick={() => openPage(to)}>
        <MIc n="more" />
      </button>
    );
    if (kind === 'bot') return { title: name(arg) || 'Bot', sub: () => botStatusLine(arg), actions: details(`bot-details:${arg}`), body: () => <BotChatPage id={arg} /> };
    if (kind === 'room') return { title: name(arg) || '群聊', sub: () => roomStatusLine(arg), actions: details(`room-details:${arg}`), body: () => <RoomChatPage id={arg} /> };
    if (kind === 'bot-details') return { title: 'Bot 详情', body: () => <BotDetailsPage id={arg} /> };
    if (kind === 'room-details') return { title: '群聊详情', body: () => <RoomDetailsPage id={arg} /> };
    if (kind === 'bot-model') return { title: '模型', body: () => <BotModelPage id={arg} /> };
    const [k, x] = arg.split(':') as ['bot' | 'room', string];
    if (kind === 'bot-folder') return { title: '工作目录', body: () => <FolderPage kind={k} id={x} /> };
    return { title: k === 'room' ? '群记忆' : '记忆', body: () => <MemoryPage kind={k} id={x} /> };
  }
  const h = /^(schedule|engine-settings|provider):(.+)$/.exec(id);
  if (h) {
    const arg = h[2];
    if (h[1] === 'schedule') return { title: '自动化任务', body: () => <ScheduleDetailPage id={arg} /> };
    if (h[1] === 'engine-settings') return { title: '引擎设置', body: () => <EngineSettingsNsPage ns={arg} /> };
    return { title: arg, body: () => <ProviderDetailPage id={arg} /> };
  }
  const m = /^(plugin|plugin-manage|plugin-guide):(.+)$/.exec(id);
  if (!m) return PAGES[id];
  const pid = m[2];
  if (m[1] === 'plugin') return { title: '插件详情', body: () => <PluginDetailPage id={pid} /> };
  if (m[1] === 'plugin-guide') return { title: '使用说明', body: () => <PluginGuidePage id={pid} /> };
  return { title: findPlugin(pid) ? `管理「${findPlugin(pid)!.title}」` : '管理插件', body: () => <PluginManagePage id={pid} /> };
}

/**
 * Page bodies built per id (`bot:<id>`, `schedule:<id>`…) are new functions on
 * every pageDef call; rendering them as-is would remount the page — and lose
 * its state — whenever the host re-renders. One body per id stays mounted.
 */
const bodies = new Map<string, () => JSX.Element>();
function stableBody(id: string, body: () => JSX.Element) {
  let b = bodies.get(id);
  if (!b) {
    b = body;
    bodies.set(id, b);
    if (bodies.size > 64) bodies.delete(bodies.keys().next().value!);
  }
  return b;
}

export function PageHost() {
  const id = pages.value[pages.value.length - 1];
  const p = pageDef(id);
  const Body = p ? stableBody(id, p.body) : null;
  txVersion.value;
  const title = id === 'native' ? catalogItem(nativePlaceholder.id)?.title ?? '原生页面' : p?.title ?? '';
  const sub = p?.sub?.();
  const noSession = p?.session && !sid();
  return (
    <section class={`page ${p ? 'open' : ''}`} id="page" aria-label="功能页" data-page={id ?? ''}>
      {p && (
        <>
          <header class="pg-head">
            <button class="ib xl pri" type="button" aria-label="返回" onClick={backPage}>
              <Ic n="Back" />
            </button>
            <div class="pg-titles">
              <h1 class="pg-title">{title}</h1>
              {sub && <div class="pg-sub">{sub}</div>}
            </div>
            <div class="pg-actions">{p.actions?.()}</div>
          </header>
          <div class="pg-body">
            <div class="pg-col" key={id}>
              {noSession ? <Empty title="先打开一个对话" desc="这一页显示的是当前对话的内容" /> : Body && <Body />}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ 全部功能

function FeaturesPage() {
  const panels = dshGoPanels.value;
  const off = siderRows.value.filter((r) => siderHidden.value.has(r.key)).length;
  return (
    <>
      <div>
        <div class="group-h">边栏</div>
        <Lrow
          title="管理边栏功能区"
          sub={off ? `${off} 个按钮没有显示` : '选哪些按钮显示在边栏「功能」里'}
          onClick={() => openPage('sider-feats')}
          end={<span class="lrow-end"><Ic n="IconChevronRightOutline14" /></span>}
        />
      </div>
      {CATALOG.map(([group, items]) => (
        <div key={group}>
          <div class="group-h">{group}</div>
          {items.map((it) => (
            <Lrow
              key={it.id}
              title={it.title}
              sub={it.sub}
              onClick={() => openFeature(it.id)}
              end={'native' in it.to ? <span class="lrow-end">原生<Ic n="IconChevronRightOutline14" /></span> : <span class="lrow-end"><Ic n="IconChevronRightOutline14" /></span>}
            />
          ))}
        </div>
      ))}
      {panels.length > 0 && (
        <div>
          <div class="group-h">插件面板</div>
          {panels.map((p) => (
            <Lrow key={p.key} title={p.title} sub={p.pluginTitle} onClick={p.open} end={<span class="lrow-end"><Ic n="IconChevronRightOutline14" /></span>} />
          ))}
        </div>
      )}
    </>
  );
}

/** 全部功能 › 管理边栏功能区: a switch per row of the sidebar's 「功能」. */
function SiderFeatsPage() {
  const rows = siderRows.value;
  return (
    <>
      <div class="group-h">显示在边栏「功能」里</div>
      {rows.map((r) => {
        const by = hiddenByPlugin(r.key);
        return (
          <Lrow
            key={r.key}
            title={r.title}
            sub={by ? `被插件「${by}」藏起来了，在它的「管理」里改` : r.sub}
            end={<Switch on={!by && siderShown(r.key)} disabled={!!by} label={`在边栏显示${r.title}`} onChange={(v) => setSiderShown(r.key, v)} />}
          />
        );
      })}
      <Lrow title="全部功能" sub="一直显示：不常用的功能都能从这里找到" end={<Switch on disabled label="在边栏显示全部功能" onChange={() => {}} />} />
      <div class="note" style="margin-top:12px">关掉的按钮只是不在边栏显示，功能本身还在，随时能从「全部功能」打开。</div>
    </>
  );
}

function NativePage() {
  const it = catalogItem(nativePlaceholder.id);
  return (
    <Empty title={`「${it?.title ?? '这一页'}」是 dsh-Go 的原生页面`} desc="在 App 里会直接打开 dsh-Go 自带的界面；浏览器里的原型没有它。">
      <div class="note" style="margin-top:12px">
        对应链接：<code>dshgo://open/{it && 'native' in it.to ? it.to.native : nativePlaceholder.id}</code>
      </div>
    </Empty>
  );
}

// ------------------------------------------------------------------ 对话详情

function DetailPage() {
  txVersion.value;
  const t = getTranscript();
  if (!t) return <Empty title="正在加载" />;
  const turns: { n: number; q: string; start: number; end?: number; steps: number; tokens: number; reason?: string }[] = [];
  const changes = new Map<string, number>();
  let cur: (typeof turns)[number] | null = null;
  for (const e of t.events) {
    if (e.kind === 'turn-start') turns.push((cur = { n: e.turn, q: '', start: e.time, steps: 0, tokens: 0 }));
    else if (cur && e.kind === 'user' && e.human && !cur.q) cur.q = e.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').replace(LOCATION_TAG, '');
    else if (cur && e.kind === 'tool-call') {
      cur.steps++;
      const d = describeTool(e);
      if ((d.verb === '修改' || d.verb === '写入') && d.detail) changes.set(d.detail, (changes.get(d.detail) ?? 0) + 1);
    } else if (cur && e.kind === 'assistant') cur.tokens += e.usage?.totalTokens ?? 0;
    else if (cur && e.kind === 'turn-end') {
      cur.end = e.time;
      cur.reason = e.reason.kind;
    }
  }
  const total = turns.reduce((a, x) => a + x.tokens, 0);
  return (
    <>
      <div class="kv">
        <div>
          <span class="k">轮数</span>
          <span class="v">{turns.length}</span>
        </div>
        <div>
          <span class="k">工具调用</span>
          <span class="v">{turns.reduce((a, x) => a + x.steps, 0)} 次</span>
        </div>
        <div>
          <span class="k">用量</span>
          <span class="v">{total ? `约 ${total.toLocaleString()} tokens` : '—'}</span>
        </div>
        <div>
          <span class="k">权限</span>
          <span class="v">{t.permissionPreset ?? '—'}</span>
        </div>
      </div>
      <div class="group-h">每一轮</div>
      {!turns.length && <div class="note">还没有开始</div>}
      {turns.map((x) => (
        <div class="turn" key={x.n}>
          <div class="turn-h">
            <span>第 {x.n} 轮</span>
            <span>
              {x.end ? `${x.steps} 步 · 用时 ${Math.max(1, Math.round((x.end - x.start) / 1000))} 秒` : '进行中'}
              {x.reason && x.reason !== 'completed' ? ` · ${x.reason === 'aborted' ? '已停止' : x.reason}` : ''}
            </span>
          </div>
          <div class="turn-q">{x.q}</div>
        </div>
      ))}
      {changes.size > 0 && (
        <>
          <div class="group-h">改过的文件</div>
          {[...changes].map(([p, n]) => (
            <Lrow key={p} title={<code>{p}</code>} sub={`改了 ${n} 次`} onClick={() => openOverlay({ kind: 'file', path: relPath(p) })} />
          ))}
        </>
      )}
    </>
  );
}

function relPath(p: string) {
  const cwd = (getTranscript()?.header.cwd as string | undefined) ?? '';
  return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
}

// ------------------------------------------------------------------ 产出的文件

function presented(events: LogEvent[]) {
  const out = new Map<string, { path: string; description?: string; turn: number }>();
  for (const e of events) {
    if (e.type !== 'deliverables/presented') continue;
    const files = Array.isArray(e.data.files) ? e.data.files : [];
    for (const f of files) {
      if (!f || typeof f !== 'object') continue;
      const path = typeof (f as any).path === 'string' ? (f as any).path.trim() : '';
      if (!path) continue;
      const description = typeof (f as any).description === 'string' ? (f as any).description : undefined;
      out.delete(path);
      out.set(path, { path, description, turn: Number(e.data.turn) || 0 });
    }
  }
  return [...out.values()].reverse();
}

function ArtifactsPage() {
  txVersion.value;
  const t = getTranscript();
  const list = t ? presented(t.events) : [];
  if (!list.length) return <Empty title="还没有产出的文件" desc="AI 用 present 交给你的文件会出现在这里" />;
  return (
    <>
      {list.map((f) => (
        <Lrow key={f.path} icon="StepFile" title={f.path.split('/').pop()} sub={`${f.description ? f.description + ' · ' : ''}第 ${f.turn} 轮`} onClick={() => openOverlay({ kind: 'file', path: relPath(f.path) })} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ 文件

function FilesPage() {
  const [dir, setDir] = useState('');
  const s = sid()!;
  const { data, error, loading } = useAsync(() => getClient().listFiles(s, dir), [s, dir]);
  const parts = dir ? dir.split('/') : [];
  return (
    <>
      <div class="crumbs">
        <button class="crumb" type="button" onClick={() => setDir('')}>
          工作区
        </button>
        {parts.map((p, i) => (
          <span key={i}>
            {' / '}
            <button class="crumb" type="button" onClick={() => setDir(parts.slice(0, i + 1).join('/'))}>
              {p}
            </button>
          </span>
        ))}
      </div>
      {loading && <div class="note">正在读取…</div>}
      {error && <div class="note">{errText(error)}</div>}
      {data && !data.length && <div class="note">空文件夹</div>}
      {data
        ?.slice()
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
        .map((f) =>
          f.kind === 'directory' ? (
            <Lrow key={f.path} icon="FolderIco" title={f.name} onClick={() => setDir(f.path)} end={<span class="lrow-end"><Ic n="IconChevronRightOutline14" /></span>} />
          ) : (
            <Lrow key={f.path} icon="StepFile" title={f.name} onClick={() => openOverlay({ kind: 'file', path: f.path })} end={fmtSize(f.size)} />
          ),
        )}
    </>
  );
}

// ------------------------------------------------------------------ 导出

function ExportPage() {
  const [busy, setBusy] = useState(false);
  const s = sessions.value.find((x) => x.sessionId === sid());
  const run = async () => {
    setBusy(true);
    try {
      // DSMO's own JSON (导入历史对话 reads it back); DSH's /api/session.export zip can't be imported.
      const r = await exportConversations([{ sessionId: sid()!, title: s?.title }]);
      if (!r.count) throw new Error('empty');
      await native.saveFile(exportFileName(s?.title || '对话'), 'application/json', new Blob([r.json], { type: 'application/json' }));
      showToast('已导出');
    } catch {
      // The prototype (and relay hosts) have no HTTP export route: fall back to the loaded log.
      const t = getTranscript();
      const json = JSON.stringify({ sessionId: sid(), header: t?.header, events: t?.events.map(({ seq, time, type, data }) => ({ seq, time, type, data })) }, null, 2);
      await native.saveFile(`${s?.title ?? 'session'}.json`, 'application/json', new Blob([json], { type: 'application/json' }));
      showToast('已导出已加载的部分');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div class="p-body">把这个对话的完整记录保存成 JSON 文件，可以留档，也能在「数据管理 › 导入历史对话」里导回来。</div>
      <div class="pg-foot">
        <button class="btn primary" type="button" disabled={busy} onClick={run}>
          {busy ? '正在导出…' : '导出'}
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ 后台任务

const JOB_STATE: Record<string, string> = { running: '运行中', succeeded: '已完成', failed: '失败', killed: '已停止', exited: '已结束' };
function JobsPage() {
  const [jobs, setJobs] = useState<JobInfo[] | null>(null);
  const s = sid()!;
  useEffect(() => getClient().watchJobs(s, setJobs), [s]);
  if (!jobs) return <div class="note">正在读取…</div>;
  if (!jobs.length) return <Empty title="没有后台任务" desc="让 AI 在后台运行服务或长任务时，会出现在这里" />;
  return (
    <>
      {jobs.map((j) => (
        <Lrow
          key={j.jobId}
          title={<code>{j.command}</code>}
          sub={`${j.startedAt ? fmtTime(j.startedAt) + ' 开始' : ''}${j.detail ? ' · ' + j.detail : ''}`}
          end={
            j.status === 'running' ? (
              <button class="btn" type="button" onClick={() => getClient().killJob(s, j.jobId).then((ok) => showToast(ok ? '已请求停止' : '已经结束了'), (e) => showToast(errText(e)))}>
                停止
              </button>
            ) : (
              <span class="lrow-end">{JOB_STATE[j.status] ?? j.status}</span>
            )
          }
        />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ 计划与目标

const TODO_LABEL: Record<string, string> = { pending: '待做', in_progress: '进行中', completed: '已完成' };
function PlanGoalPage() {
  txVersion.value;
  const s = sid()!;
  const t = getTranscript();
  const goal = useAsync(() => getClient().goal(s), [s, txVersion.value]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const todos = t?.todos ?? [];
  const g = goal.data;
  const act = (fn: () => Promise<unknown>) => fn().then(goal.reload, (e) => showToast(errText(e)));
  return (
    <>
      <div class="group-h">目标</div>
      {editing ? (
        <form
          class="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setEditing(false);
            act(() => getClient().createGoal(s, text));
          }}
        >
          <input autoFocus placeholder="比如：把登录模块的测试覆盖到 80%" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          <button class="btn primary" type="submit">
            设置
          </button>
        </form>
      ) : g ? (
        <>
          <Lrow title={g.objective} sub={`${GOAL_PHASE[g.status] ?? g.status}${g.rounds ? ` · 已进行 ${g.rounds} 轮` : ''}${g.maxRounds ? ` / 最多 ${g.maxRounds} 轮` : ''}`} />
          <div class="chips">
            {g.status === 'active' && (
              <button class="btn" type="button" onClick={() => act(() => getClient().goalAction(s, 'pause'))}>
                暂停
              </button>
            )}
            {g.status === 'paused' && (
              <button class="btn" type="button" onClick={() => act(() => getClient().goalAction(s, 'resume'))}>
                继续
              </button>
            )}
            {g.status !== 'complete' && (
              <button class="btn" type="button" onClick={() => act(() => getClient().goalAction(s, 'complete'))}>
                标记完成
              </button>
            )}
            <button class="btn" type="button" onClick={() => act(() => getClient().goalAction(s, 'clear'))}>
              清除
            </button>
          </div>
        </>
      ) : (
        <Lrow
          title={<span class="muted">还没有目标</span>}
          sub="设一个目标，AI 会一轮轮推进直到完成"
          end={
            <button class="btn" type="button" onClick={() => setEditing(true)}>
              设置
            </button>
          }
        />
      )}
      <div class="group-h">待办</div>
      {todos.length ? (
        todos.map((x, i) => (
          <div class={`todo ${x.status === 'completed' ? 'done' : ''}`} key={i}>
            <span class={`todo-st ${x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'doing' : ''}`}>{x.status === 'completed' && <Ic n="IconCheckOutline16" />}</span>
            <span class="todo-t">{x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content}</span>
            <span class="lrow-end">{TODO_LABEL[x.status] ?? x.status}</span>
          </div>
        ))
      ) : (
        <div class="note">复杂任务里 AI 会列出待办，进度在这里看</div>
      )}
    </>
  );
}
const GOAL_PHASE: Record<string, string> = { active: '进行中', paused: '已暂停', complete: '已完成', blocked: '受阻' };

// ------------------------------------------------------------------ 子代理

function SubagentsPage() {
  const s = sid()!;
  const me = sessions.value.find((x) => x.sessionId === s);
  const root = me?.parentSessionId ? sessions.value.find((x) => x.sessionId === me.parentSessionId) : me;
  const kids = sessions.value.filter((x) => x.parentSessionId === root?.sessionId);
  return (
    <>
      {root && (
        <Lrow
          title={
            <>
              {root.title ?? '对话'}
              {root.sessionId === s && <span class="badge">当前</span>}
            </>
          }
          sub="上级对话"
          onClick={() => openSession(root.sessionId)}
        />
      )}
      {kids.length ? (
        kids.map((k) => (
          <Lrow
            key={k.sessionId}
            class="indent"
            title={
              <>
                {k.title ?? '子代理'}
                {k.sessionId === s && <span class="badge">当前</span>}
              </>
            }
            sub={k.running ? '运行中' : '已结束'}
            onClick={() => openSession(k.sessionId)}
          />
        ))
      ) : (
        <div class="note">这个对话还没有派出子代理</div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ 引用

function ReferencePage() {
  return (
    <>
      <div class="p-body">在输入框里输入 <code>@</code>，可以引用工作区里的文件或文件夹；AI 会把它们读进这一轮。</div>
      <div class="kv">
        <div>
          <span class="k">文件</span>
          <span class="v code">@src/app.ts</span>
        </div>
        <div>
          <span class="k">带空格的路径</span>
          <span class="v code">@"我的 文档/说明.md"</span>
        </div>
        <div>
          <span class="k">文件夹</span>
          <span class="v code">@src/</span>
        </div>
      </div>
      <div class="note">需要打开高级模式。</div>
    </>
  );
}

// ------------------------------------------------------------------ 权限 (protected)

function PermissionPage(): JSX.Element {
  txVersion.value;
  const t = getTranscript();
  const { data, error } = useAsync(() => getClient().permissionPresets(), []);
  const cur = t?.permissionPreset ?? data?.defaultPreset;
  return (
    <Protected zone="permission">
      {error && <div class="err">{errText(error)}</div>}
      {!data && !error && <div class="note">正在读取…</div>}
      {data?.options.map((o) => (
        <button class="opt" type="button" role="radio" aria-checked={o.value === cur} key={o.value} onClick={() => void setPermission(o.value)}>
          <span class="radio" />
          <span>
            <span class="t">
              {PRESET_NAME[o.value] ?? o.name}
              {o.value === data.defaultPreset && <span class="badge">默认</span>}
            </span>
            <span class="s">{o.description ?? PRESET_DESC[o.value] ?? o.value}</span>
          </span>
        </button>
      ))}
      <div class="meta" style="margin-top:12px">只改当前对话。插件不能修改这一页，也不能替你授权。</div>
    </Protected>
  );
}
const PRESET_NAME: Record<string, string> = { 'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问' };
const PRESET_DESC: Record<string, string> = {
  'read-only': '只能查看，不能改文件、不能联网',
  'workspace-write': '可以改工作区里的文件；越界的操作先问你',
  'danger-full-access': '不再询问，直接执行（谨慎）',
};
