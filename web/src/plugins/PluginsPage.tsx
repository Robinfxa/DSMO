// 插件: 发现 / 已安装, a detail page per plugin (effect preview, description,
// permissions, info) and a second-level 管理 page (switch single entries off,
// local data, engine half, uninstall). Shared by the desktop page column and
// the phone's full-screen pages.

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { backPage, closeOverlay, confirm, errText, openOverlay, openPage, pages, prefs, showToast, toast } from '../state/store';
import { ENGINE_DATA } from './engineData';
import { Switch } from '../ui/common';
import { MIc } from '../ui/mobile/MIc';
import type { MIconName } from '../ui/mobile/icons';
import { openFeature } from '../ui/pages/registry';
import { contributions } from './dshgo';
import {
  catalogPlugins,
  clearPluginData,
  findPlugin,
  hasUpdate,
  installPlugin,
  pluginUpdates,
  updatePlugin,
  runSlotAction,
  pluginJobs,
  type PluginJob,
  installed,
  isEnabled,
  isInstalled,
  isOptionOn,
  madeBy,
  pluginCssSuspended,
  pluginDataSize,
  removePlugin,
  removeStrayBundles,
  strayEngineBundles,
  setPluginEnabled,
  setPluginOption,
  setTrialSkin,
  trialSkin,
  type ApiDemoManifest,
} from './frontend';
import { CATEGORIES, PERM_INFO, SHELF, TIER_INFO, catInfo, categoryOf, hasToggle, matches, optionsOf, relevance, type Category } from './meta';
import { FEATURED, MARKET_TIER } from './official';
import { affectsOf, clashesOf, loadHostBundles, setPersonaSkipBots, tagInfo } from './conflicts';
import { AutomationPreview, EnginePreview, LayoutPreview, SkillPreview, SkinPreview, SkinSwatch, ToolsPreview, themeNow } from './preview';
import { describeTiming, runSchedule, scheduleState, setScheduleTime, skillsInstallable } from './automation';
import { local } from '../bridge/native';
import { onLocalHost } from '../setup/state';
import type { InstallOutcome } from './frontend';

/** After an install: an engine plugin that loads only once the engine restarts says so (and offers it on this phone). */
function afterInstall(p: ApiDemoManifest, outcome: InstallOutcome, offerGuide = true) {
  const title = p.title;
  // the toast offers the guide: 怎么用 is the first question after 获取 (on the detail page it's already there)
  const say = (text: string) => (p.guide && offerGuide ? showToast(text, '怎么用', () => openPluginGuide(p.id)) : showToast(text));
  if (!outcome.restart) return say(`已安装「${title}」`);
  if (!onLocalHost.value) return say(`已安装「${title}」，在主机上重启 DSH 后生效`);
  confirm(`「${title}」装好了`, '重启本机引擎后生效。正在生成的回复会中断。', '重启引擎', () => {
    void local('engine.restart')
      .then(() => showToast('引擎正在重启'))
      .catch((e) => showToast(errText(e)));
  }, false);
}

/** After updating one or more plugins: an engine half that loads only after a restart says so. */
export function afterUpdate(titles: string[], restart: boolean) {
  if (!titles.length) return;
  const what = titles.length === 1 ? `「${titles[0]}」` : `「${titles[0]}」等 ${titles.length} 个插件`;
  if (!restart) return showToast(`已更新${what}`);
  if (!onLocalHost.value) return showToast(`已更新${what}，在主机上重启 DSH 后生效`);
  confirm(`已更新${what}`, '重启本机引擎后用上新版本。正在生成的回复会中断。', '重启引擎', () => {
    void local('engine.restart')
      .then(() => showToast('引擎正在重启'))
      .catch((e) => showToast(errText(e)));
  }, false);
}

/** Installs after saying what it would clash with (conflicts.ts), if anything. */
function installChecked(p: ApiDemoManifest, go: () => void) {
  const c = clashesOf(p);
  if (!c.length) return go();
  confirm(`「${p.title}」可能和${[...new Set(c.map((x) => `「${x.with}」`))].join('、')}冲突`, c.map((x) => x.text).join('\n\n'), '仍然安装', go, false);
}

/** 可能冲突: what else writes where this plugin does, and the fix where there is one. */
function ClashCard({ p }: { p: ApiDemoManifest }) {
  const c = clashesOf(p);
  const inst = isInstalled(p.id);
  const [busy, setBusy] = useState(false);
  if (!c.length) return null;
  return (
    <section class="plg-sec">
      <h2 class="plg-sec-t">可能冲突</h2>
      <div class="plg-group plg-clash">
        {c.map((x, i) => (
          <div class="plg-row static" key={i}>
            <span class="plg-tile warn">
              <MIc n="info" />
            </span>
            <div class="plg-row-m">
              <div class="plg-row-t">
                和「{x.with}」
                <em class="tm-badge warn">{tagInfo(x.position).title}</em>
              </div>
              <div class="plg-row-s wrap">{x.text}</div>
              {x.fix === 'persona-skip-bots' &&
                (inst ? (
                  <button
                    class="plg-btn plg-clash-fix"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      showToast('Bot 的对话里不再用人设，可以在「人设」里改回来');
                      setPersonaSkipBots(true).catch((e) => showToast(`没能告诉人设库：${errText(e)}`));
                    }}
                  >
                    Bot 的对话里不用人设
                  </button>
                ) : (
                  <div class="plg-row-s wrap">装好后，可以在「人设」里设成 Bot 的对话不用人设。</div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const tab = signal<'discover' | 'installed'>('discover');

export const openPlugin = (id: string) => openPage(`plugin:${id}`);
export const openPluginManage = (id: string) => openPage(`plugin-manage:${id}`);
export const openPluginGuide = (id: string) => openPage(`plugin-guide:${id}`);

// ---------------------------------------------------------------- small parts

export function PluginTile({ p, size = 'md' }: { p: ApiDemoManifest; size?: 'md' | 'lg' }) {
  const c = categoryOf(p);
  if (c === 'appearance' && p.skin)
    return (
      <span class={`plg-tile ${size} skin`}>
        <SkinSwatch p={p} mode={themeNow()} />
      </span>
    );
  const icon: MIconName = p.slots?.[0]?.title === '随手记' ? 'edit' : p.permissions.includes('engine.read') || p.engine ? 'data' : catInfo(c).icon;
  return (
    <span class={`plg-tile ${size}`}>
      <MIc n={icon} />
    </span>
  );
}

/** 等待中 / 安装中 / 更新中 for a plugin in the install queue (frontend.ts pluginJobs). */
const jobLabel = (j: PluginJob, long = false) => (j.running ? (j.kind === 'install' ? (long ? '正在安装…' : '安装中') : long ? '正在更新…' : '更新中') : long ? '等待中…' : '等待中');

function GetButton({ p }: { p: ApiDemoManifest }) {
  const job = pluginJobs.value[p.id];
  if (job)
    return (
      <button class="plg-get" type="button" disabled onClick={(e) => e.stopPropagation()}>
        {jobLabel(job)}
      </button>
    );
  if (isInstalled(p.id) && hasUpdate(p.id))
    return (
      <button
        class="plg-get"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          updatePlugin(p.id)
            .then((r) => afterUpdate([p.title], r.restart))
            .catch((err) => showToast(errText(err)));
        }}
      >
        更新
      </button>
    );
  if (isInstalled(p.id))
    return (
      <span class="plg-get done" aria-label="已安装">
        {isEnabled(p.id) ? '已安装' : '已停用'}
      </span>
    );
  return (
    <button
      class="plg-get"
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        installChecked(p, () => {
          installPlugin(p.id)
            .then((r) => afterInstall(p, r))
            .catch((err) => showToast(errText(err)));
        });
      }}
    >
      获取
    </button>
  );
}

function Banners() {
  return (
    <>
      {!prefs.value.advanced && <p class="plg-note">基础模式下只有皮肤生效，其余插件在高级模式下出现。</p>}
      {pluginCssSuspended.value && <p class="plg-note warn">插件样式遮住了授权卡或登录框，已暂停。停用相关皮肤后重新启用即可恢复。</p>}
    </>
  );
}

function Row({ p, end }: { p: ApiDemoManifest; end?: preact.ComponentChildren }) {
  return (
    <div class="plg-row" role="button" tabIndex={0} onClick={() => openPlugin(p.id)} onKeyDown={(e) => e.key === 'Enter' && openPlugin(p.id)}>
      <PluginTile p={p} />
      <div class="plg-row-m">
        <div class="plg-row-t">
          {p.title}
          {isEnabled(p.id) && clashesOf(p).length > 0 && <em class="tm-badge warn">可能冲突</em>}
        </div>
        <div class="plg-row-s">{p.summary}</div>
      </div>
      <div class="plg-row-e" onClick={(e) => e.stopPropagation()}>
        {end ?? <GetButton p={p} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 插件 page
//
// A market page that stays short however many plugins there are: a search box,
// category chips, then (under 全部) 精选 cards and one shelf per category with at
// most SHELF entries and 全部 ›. A category or a search shows a flat list.

const query = signal('');
const cat = signal<Category | 'all'>('all');

export function PluginsPage() {
  useEffect(() => void loadHostBundles(), []);
  const mine = installed.value;
  const q = query.value;
  return (
    <div class="plg">
      <div class="plg-seg" role="tablist">
        {(
          [
            ['discover', '发现'],
            ['installed', mine.length ? `已安装 ${mine.length}` : '已安装'],
          ] as const
        ).map(([k, t]) => (
          <button type="button" role="tab" key={k} aria-selected={tab.value === k} onClick={() => (tab.value = k)}>
            {t}
          </button>
        ))}
      </div>
      <label class="hist-find plg-find">
        <MIc n="search" />
        <input type="search" placeholder={tab.value === 'discover' ? '搜索插件、技能、皮肤' : '搜索已安装的插件'} value={q} onInput={(e) => (query.value = (e.target as HTMLInputElement).value)} enterKeyHint="search" />
        {q && (
          <button class="plg-find-x" type="button" aria-label="清除搜索" onClick={() => (query.value = '')}>
            <MIc n="x" />
          </button>
        )}
      </label>
      <Banners />
      {tab.value === 'discover' ? <Discover /> : <Installed />}
    </div>
  );
}

function Chips({ plugins }: { plugins: ApiDemoManifest[] }) {
  const present = CATEGORIES.filter((c) => plugins.some((p) => categoryOf(p) === c.id));
  if (present.length < 2) return null;
  return (
    <div class="plg-chips" role="tablist" aria-label="分类">
      {[{ id: 'all' as const, title: '全部' }, ...present].map((c) => (
        <button type="button" role="tab" key={c.id} aria-selected={cat.value === c.id} onClick={() => (cat.value = c.id)}>
          {c.title}
        </button>
      ))}
    </div>
  );
}

function List({ plugins, end }: { plugins: ApiDemoManifest[]; end?: (p: ApiDemoManifest) => preact.ComponentChildren }) {
  return (
    <div class="plg-group">
      {plugins.map((p) => (
        <Row p={p} key={p.id} end={end?.(p)} />
      ))}
    </div>
  );
}

function NoMatch({ q }: { q: string }) {
  return (
    <div class="plg-empty">
      <span>没有找到「{q.trim()}」</span>
      <button class="plg-text-btn" type="button" onClick={() => (query.value = '')}>
        清除搜索
      </button>
    </div>
  );
}

function FeatureCard({ p }: { p: ApiDemoManifest }) {
  return (
    <div class="plg-card" role="button" tabIndex={0} onClick={() => openPlugin(p.id)} onKeyDown={(e) => e.key === 'Enter' && openPlugin(p.id)}>
      <div class="plg-card-h">
        <PluginTile p={p} size="lg" />
        <div class="plg-row-e" onClick={(e) => e.stopPropagation()}>
          <GetButton p={p} />
        </div>
      </div>
      <div class="plg-card-t">{p.title}</div>
      <div class="plg-card-s">{p.summary}</div>
      <div class="plg-card-c">{catInfo(categoryOf(p)).title}</div>
    </div>
  );
}

function Discover() {
  const all = catalogPlugins.value;
  const q = query.value.trim();
  if (q) {
    const found = all.filter((p) => matches(p, q)).sort((a, b) => relevance(b, q) - relevance(a, q));
    return found.length ? (
      <section class="plg-sec">
        <h2 class="plg-sec-t">{found.length} 个结果</h2>
        <List plugins={found} />
      </section>
    ) : (
      <NoMatch q={q} />
    );
  }
  const c = cat.value;
  if (c !== 'all') {
    const list = all.filter((p) => categoryOf(p) === c);
    return (
      <>
        <Chips plugins={all} />
        <section class="plg-sec">
          <h2 class="plg-sec-t">{catInfo(c).desc}</h2>
          {list.length ? <List plugins={list} /> : <div class="plg-group"><div class="plg-empty-line">暂时没有。</div></div>}
        </section>
      </>
    );
  }
  const featured = FEATURED.map((id) => all.find((p) => p.id === id)).filter((p): p is ApiDemoManifest => !!p);
  return (
    <>
      <Chips plugins={all} />
      {featured.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">精选</h2>
          <div class="plg-cards">
            {featured.map((p) => (
              <FeatureCard p={p} key={p.id} />
            ))}
          </div>
        </section>
      )}
      {CATEGORIES.map((ci) => {
        // featured first (in the market's order), so a family of plugins doesn't push them off the shelf
        const rank = (p: ApiDemoManifest) => (FEATURED.includes(p.id) ? FEATURED.indexOf(p.id) : FEATURED.length);
        const list = all.filter((p) => categoryOf(p) === ci.id).sort((a, b) => rank(a) - rank(b));
        if (!list.length) return null;
        return (
          <section class="plg-sec" key={ci.id}>
            <div class="plg-shelf-h">
              <h2 class="plg-sec-t">{ci.title}</h2>
              {list.length > SHELF && (
                <button class="plg-more" type="button" onClick={() => (cat.value = ci.id)}>
                  全部 {list.length}
                  <MIc n="chevron" />
                </button>
              )}
            </div>
            <List plugins={list.slice(0, SHELF)} />
          </section>
        );
      })}
      <p class="plg-note foot">第一版只上架官方插件。插件在沙箱里运行，碰不到授权卡、权限页和登录框，也拿不到 API Key。</p>
    </>
  );
}

function Installed() {
  const q = query.value.trim();
  const all = installed.value.map((x) => findPlugin(x.id)).filter((p): p is ApiDemoManifest => !!p);
  const mine = all.filter((p) => matches(p, q));
  const fromMarket = new Set(all.map((p) => p.engine?.package).filter(Boolean));
  const host = contributions.value.filter((h) => !fromMarket.has(h.pkg) && (!q || `${h.title}\n${h.pkg}`.toLowerCase().includes(q.toLowerCase())));
  const toggle = (p: ApiDemoManifest) => (hasToggle(p) ? <Switch on={isEnabled(p.id)} label={`启用${p.title}`} onChange={(v) => void setPluginEnabled(p.id, v)} /> : <MIc n="chevron" />);
  if (q && !mine.length && !host.length) return <NoMatch q={q} />;
  return (
    <>
      {!q && pluginUpdates.value.length > 0 && <UpdateAll />}
      {!q && <Strays />}
      {!all.length && !q && (
        <div class="plg-empty">
          <span>还没有装插件</span>
          <button class="plg-text-btn" type="button" onClick={() => (tab.value = 'discover')}>
            去发现
          </button>
        </div>
      )}
      {CATEGORIES.map((c) => {
        const list = mine.filter((p) => categoryOf(p) === c.id);
        if (!list.length) return null;
        return (
          <section class="plg-sec" key={c.id}>
            <h2 class="plg-sec-t">{c.title}</h2>
            <List plugins={list} end={toggle} />
          </section>
        );
      })}
      {(!q || host.length > 0) && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">主机上的引擎插件</h2>
          <div class="plg-group">
            {host.map((h) => (
              <div class="plg-row static" key={h.pkg}>
                <span class="plg-tile">
                  <MIc n="server" />
                </span>
                <div class="plg-row-m">
                  <div class="plg-row-t">{h.title}</div>
                  <div class="plg-row-s">
                    {[
                      h.composerActions.length && `${h.composerActions.length} 个输入框按钮`,
                      h.messageActions.length && `${h.messageActions.length} 个消息动作`,
                      h.strips.length && '状态条',
                      h.panels.length && `${h.panels.length} 个面板`,
                    ]
                      .filter(Boolean)
                      .join(' · ') || h.pkg}
                  </div>
                </div>
              </div>
            ))}
            {!host.length && <div class="plg-empty-line">这台主机没有带界面的引擎插件。</div>}
            <button class="plg-link" type="button" onClick={() => openFeature('cordis')}>
              <span>在主机上安装和管理引擎插件</span>
              <MIc n="chevron" />
            </button>
          </div>
        </section>
      )}
    </>
  );
}

/**
 * Market plugins DSMO no longer has whose engine half the engine still runs: uninstalled while
 * DSMO couldn't finish it (an engine without live recomposition refuses to remove a running
 * plugin, and older DSMO said 已卸载 anyway). One tap removes them.
 */
function Strays() {
  const [list, setList] = useState<{ pkg: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => void strayEngineBundles().then(setList, () => setList([]));
  useEffect(load, [installed.value]);
  if (!list.length) return null;
  const names = [...new Set(list.map((x) => `「${x.title}」`))].join('、');
  const run = async () => {
    setBusy(true);
    try {
      const restart = await removeStrayBundles(list.map((x) => x.pkg));
      load();
      afterRemoval(names, restart);
    } catch (e) {
      showToast(`没能卸掉：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="plg-group">
      <div class="plg-row static">
        <div class="plg-row-m">
          <div class="plg-row-t">{names}没卸干净</div>
          <div class="plg-row-s">在 DSMO 里卸载了，引擎里还装着、还在起作用</div>
        </div>
        <button class="plg-get" type="button" disabled={busy} onClick={() => void run()}>
          {busy ? '卸载中' : '卸掉'}
        </button>
      </div>
    </div>
  );
}

/** After an engine half was removed or switched off: one that keeps running until a restart says so. */
function afterRemoval(what: string, restart: boolean) {
  if (!restart) return showToast(`已卸载${what}`);
  if (!onLocalHost.value) return showToast(`已卸载${what}，在主机上重启 DSH 后完全停下`);
  confirm(`已卸载${what}`, '它要等本机引擎重启后才完全停下。现在重启吗？正在生成的回复会中断。', '重启引擎', () => {
    void local('engine.restart')
      .then(() => showToast('引擎正在重启'))
      .catch((e) => showToast(errText(e)));
  }, false);
}

/** 「N 个插件有更新 · 全部更新」 on 已安装. */
function UpdateAll() {
  const ids = pluginUpdates.value;
  const busy = ids.some((id) => pluginJobs.value[id]);
  const run = async () => {
    // all queued at once (they still run one after another): leaving the page doesn't stop them
    const list = ids.map((id) => ({ id, title: findPlugin(id)?.title ?? id }));
    const done = await Promise.allSettled(list.map((x) => updatePlugin(x.id)));
    const titles: string[] = [];
    const failed: string[] = [];
    let restart = false;
    done.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        titles.push(list[i].title);
        restart = r.value.restart || restart;
      } else failed.push(`${list[i].title}：${errText(r.reason)}`);
    });
    if (failed.length) showToast(`没能更新 ${failed.join('；')}`);
    afterUpdate(titles, restart);
  };
  return (
    <div class="plg-group">
      <div class="plg-row static">
        <div class="plg-row-m">
          <div class="plg-row-t">{ids.length} 个插件有更新</div>
          <div class="plg-row-s">更新后插件的数据和设置都会保留</div>
        </div>
        <button class="plg-get" type="button" disabled={busy} onClick={() => void run()}>
          {busy ? '更新中' : '全部更新'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- detail

export function PluginDetailPage({ id }: { id: string }) {
  const p = findPlugin(id);
  const job = pluginJobs.value[id];
  const busy = !!job;
  const trying = trialSkin.value === id;
  useEffect(() => () => void (trialSkin.value === id && setTrialSkin(null)), [id]);
  useEffect(() => void loadHostBundles(), [id]);
  if (!p) return <div class="plg-empty-line">这个插件已经不在市场里了。</div>;
  const c = categoryOf(p);
  const inst = isInstalled(id);
  const tier = MARKET_TIER[id];
  const paras = (p.description ?? p.summary).split(/\n\s*\n/);
  const install = () => installChecked(p, () => void doInstall());
  const doInstall = async () => {
    try {
      const outcome = await installPlugin(id);
      if (trialSkin.value === id) setTrialSkin(null);
      afterInstall(p, outcome, false);
    } catch (e) {
      showToast(errText(e));
    }
  };
  const kv: [string, string, boolean?][] = [
    ['开发者', p.official ? 'DSMO 官方' : p.author ?? '社区'],
    ['版本', hasUpdate(id) ? `${p.version}（已装 ${installed.value.find((x) => x.id === id)?.version ?? '旧版'}）` : p.version],
    ...(tier ? [['审核', TIER_INFO[tier] ?? `第 ${tier} 级`] as [string, string]] : []),
    ...(p.license ? [['许可证', p.license] as [string, string]] : []),
    ['包名', p.id, true],
    ...(p.engine ? [['引擎部分', `${p.engine.package}@${p.engine.version}`, true] as [string, string, boolean]] : []),
    // its clash tags: another plugin with one of these may clash with it
    ...(affectsOf(p).length ? [['会写到', affectsOf(p).map((t) => tagInfo(t).title).join('、')] as [string, string]] : []),
  ];
  return (
    <div class="plg plg-detail">
      <div class="plg-hero">
        <PluginTile p={p} size="lg" />
        <div class="plg-hero-m">
          <h2>{p.title}</h2>
          <div class="plg-hero-s">
            {catInfo(c).title} · v{p.version}
          </div>
        </div>
      </div>

      <div class="plg-actions">
        {inst ? (
          <>
            {hasToggle(p) ? (
              <div class="plg-enable">
                <span>启用</span>
                <Switch on={isEnabled(id)} label="启用" onChange={(v) => void setPluginEnabled(id, v)} />
              </div>
            ) : (
              <div class="plg-enable">
                <span>已安装</span>
              </div>
            )}
            {hasUpdate(id) && (
              <button
                class="plg-btn pri"
                type="button"
                disabled={busy}
                onClick={() => {
                  updatePlugin(id)
                    .then((r) => afterUpdate([p.title], r.restart))
                    .catch((e) => showToast(errText(e)));
                }}
              >
                {job ? jobLabel(job, true) : `更新到 v${p.version}`}
              </button>
            )}
            <button class="plg-btn" type="button" onClick={() => openPluginManage(id)}>
              管理
            </button>
          </>
        ) : (
          <>
            <button class="plg-btn pri wide" type="button" disabled={busy || (c === 'skills' && !skillsInstallable())} onClick={install}>
              {job ? jobLabel(job, true) : '安装'}
            </button>
            {c === 'appearance' && (
              <button class="plg-btn" type="button" onClick={() => setTrialSkin(trying ? null : id)}>
                {trying ? '结束试用' : '试用'}
              </button>
            )}
          </>
        )}
      </div>
      {trying && <p class="plg-note">正在试用，离开这一页后恢复。</p>}
      {c === 'skills' && !inst && !skillsInstallable() && <p class="plg-note">技能只能装到这台手机上的引擎，先在边栏切回本机。</p>}

      {p.guide && <GuideSections p={p} />}

      <ClashCard p={p} />

      <div class="plg-text">
        {paras.map((x, i) => (
          <p key={i}>{x}</p>
        ))}
      </div>

      <section class="plg-sec">
        <h2 class="plg-sec-t">{c === 'skills' ? '包含的技能' : c === 'automation' ? '包含的自动化任务' : `效果预览${c === 'interface' ? '（高级模式下生效）' : ''}`}</h2>
        {c === 'skills' && <SkillPreview p={p} />}
        {c === 'automation' && <AutomationPreview p={p} />}
        {c === 'appearance' && <SkinPreview p={p} />}
        {c === 'interface' && <LayoutPreview p={p} />}
        {c === 'tools' && <ToolsPreview p={p} />}
        {c === 'engine' && <EnginePreview p={p} />}
        {c === 'engine' && <p class="plg-note">装在当前主机的引擎里运行，卸载后按钮和面板一起消失。</p>}
      </section>

      <section class="plg-sec">
        <h2 class="plg-sec-t">权限</h2>
        <div class="plg-group">
          {p.permissions.length ? (
            p.permissions.map((x) => {
              const info = PERM_INFO[x] ?? { title: x, desc: '', icon: 'info' as const };
              return (
                <div class="plg-row static" key={x}>
                  <div class="plg-row-m">
                    <div class="plg-row-t">{info.title}</div>
                    <div class="plg-row-s wrap">{info.desc}</div>
                  </div>
                </div>
              );
            })
          ) : (
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-t">不需要额外权限</div>
              </div>
            </div>
          )}
        </div>
        <p class="plg-note">插件碰不到授权卡、权限页和登录框，也拿不到你的 API Key。</p>
      </section>

      <section class="plg-sec">
        <h2 class="plg-sec-t">信息</h2>
        <div class="plg-group">
          {kv.map(([k, v, mono]) => (
            <div class="plg-kv" key={k}>
              <span>{k}</span>
              <span class={mono ? 'mono' : ''}>{v}</span>
            </div>
          ))}
        </div>
      </section>

      {inst && (
        <section class="plg-sec">
          <div class="plg-group">
            <button class="plg-link danger" type="button" onClick={() => uninstall(p)}>
              <span>卸载</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 使用说明

/** Where it is, then the numbered steps: the tutorial part of a guide. */
function GuideSteps({ p }: { p: ApiDemoManifest }) {
  const g = p.guide!;
  return (
    <div class="plg-group plg-guide">
      <div class="plg-guide-where">
        <MIc n="pointer" />
        <span>{g.where}</span>
      </div>
      <ol class="plg-steps">
        {g.steps.map((x, i) => (
          <li class="plg-step" key={i}>
            <span class="plg-step-n">{i + 1}</span>
            <div class="plg-step-m">
              <div class="plg-step-t">{x.title}</div>
              <div class="plg-step-s">{x.text}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The whole guide: where, steps, a button that takes you there, tips and questions. */
/** 使用说明 (steps, the button that takes you there), 小贴士, 常见问题: under 已安装 on the detail page, and its own page. */
function GuideSections({ p }: { p: ApiDemoManifest }) {
  const [open, setOpen] = useState<number | null>(null);
  const g = p.guide!;
  const inst = isInstalled(p.id);
  const on = isEnabled(p.id);
  const needsAdvanced = !!g.try && 'panel' in g.try.action && !prefs.value.advanced;
  return (
    <>
      <section class="plg-sec plg-guide-sec">
        <h2 class="plg-sec-t">使用说明</h2>
        <GuideSteps p={p} />
        {g.try && inst && (
          <div class="plg-guide-try">
            <button class="plg-btn pri wide" type="button" disabled={!on} onClick={() => runSlotAction(p, g.try!.action)}>
              {g.try.label}
            </button>
            {!on ? <p class="plg-note">插件停用了，先在「管理」里打开。</p> : needsAdvanced ? <p class="plg-note">边栏里的入口在高级模式下才显示，从这里一样能打开。</p> : null}
          </div>
        )}
      </section>
      {!!g.tips?.length && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">小贴士</h2>
          <div class="plg-group">
            {g.tips.map((t, i) => (
              <div class="plg-row static" key={i}>
                <div class="plg-row-m">
                  <div class="plg-row-s wrap plg-tip">{t}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {!!g.faq?.length && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">常见问题</h2>
          <div class="plg-group plg-faq">
            {g.faq.map((x, i) => (
              <div class={`plg-faq-i ${open === i ? 'open' : ''}`} key={i}>
                <button class="plg-faq-q" type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                  <span>{x.q}</span>
                  <MIc n="chevronDown" />
                </button>
                {open === i && <div class="plg-faq-a">{x.a}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** The guide on its own (from the 已安装 toast and 管理). */
export function PluginGuidePage({ id }: { id: string }) {
  const p = findPlugin(id);
  if (!p?.guide) return <div class="plg-empty-line">这个插件还没有使用说明。</div>;
  return (
    <div class="plg plg-guide-page">
      <div class="plg-hero">
        <PluginTile p={p} size="lg" />
        <div class="plg-hero-m">
          <h2>{p.title}</h2>
          <div class="plg-hero-s">{p.summary}</div>
        </div>
      </div>
      <GuideSections p={p} />
      {!isInstalled(id) && (
        <section class="plg-sec">
          <div class="plg-group">
            <button class="plg-link" type="button" onClick={() => openPlugin(id)}>
              <span>去安装</span>
              <MIc n="chevron" />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function uninstall(p: ApiDemoManifest) {
  const go = async (force = false, wipe = false) => {
    const data = ENGINE_DATA[p.id];
    if (wipe && data) {
      try {
        await data.wipe();
      } catch (e) {
        return showToast(`没能删掉它的数据：${errText(e)}。插件还在，可以再试一次`);
      }
    }
    if (p.engine && !force) showToast(`正在卸载「${p.title}」…`);
    let out: { restart: boolean };
    try {
      out = await removePlugin(p.id, { force });
    } catch (e) {
      // the engine kept it: say why, and let the person still take it out of DSMO
      toast.value = null;
      return confirm(
        `引擎里没卸掉「${p.title}」`,
        `${errText(e).replace(/[。.]?$/, '。')}插件还装在引擎里，每轮对话还会运行。也可以只从 DSMO 里移除，之后到「设置 › 引擎插件」里再卸载引擎那部分。`,
        '只从 DSMO 移除',
        () => void go(true),
      );
    }
    // Leave the detail / manage pages of the removed plugin.
    while (pages.value.length && /^plugin(-manage|-guide)?:/.test(pages.value[pages.value.length - 1]) && pages.value[pages.value.length - 1].endsWith(p.id)) backPage();
    toast.value = null; // 正在卸载…
    if (force) showToast(`已从 DSMO 移除「${p.title}」，引擎里的还在`);
    else afterRemoval(`「${p.title}」`, out.restart);
  };
  // An engine plugin whose data DSMO can delete too (engineData.ts): three plain choices, so that
  // closing the sheet never uninstalls. Otherwise the usual confirm.
  void (async () => {
    const data = ENGINE_DATA[p.id];
    let n = 0;
    if (data && p.engine)
      try {
        n = await data.count();
      } catch {
        n = 0; // not running: nothing DSMO can reach
      }
    if (!data || n === 0)
      return confirm(
        `卸载「${p.title}」？`,
        p.engine
          ? '插件会从 DSMO 和引擎里删掉，它在 DSMO 里的设置和数据也会删除。它在引擎里存的东西（比如记忆、作品）会留着，重新安装后还能接着用。'
          : '插件和它在这台设备上的数据都会删除，之后可以重新安装。',
        '卸载',
        () => void go(),
      );
    const item = (icon: MIconName, label: string, fn: () => void, danger = false) => (
      <button class={`lo-opt ${danger ? 'danger' : ''}`} type="button" onClick={() => (closeOverlay(), fn())}>
        <MIc n={icon} />
        <span class="lo-opt-t">{label}</span>
      </button>
    );
    openOverlay({
      kind: 'sheet',
      title: `卸载「${p.title}」？`,
      body: () => (
        <div class="lo-pick">
          <p class="plg-note">插件会从 DSMO 和引擎里删掉。{data.describe(n)}可以一起删掉（找不回来），也可以留在主机上，以后重新安装还能接着用。</p>
          {item('trash', `卸载，也删掉${data.describe(n)}`, () => void go(false, true), true)}
          {item('check', `卸载，${data.keep}`, () => void go())}
        </div>
      ),
    });
  })();
}

// ---------------------------------------------------------------- 管理 (second level)

export function PluginManagePage({ id }: { id: string }) {
  const p = findPlugin(id);
  const [data, setData] = useState<{ items: number; bytes: number } | null>(null);
  const hasStorage = !!p?.permissions.some((x) => x === 'storage' || x === 'background');
  useEffect(() => {
    if (hasStorage) void pluginDataSize(id).then(setData);
  }, [id, hasStorage]);
  if (!p || !isInstalled(id)) return <div class="plg-empty-line">这个插件已经卸载了。</div>;
  const opts = optionsOf(p);
  const c = categoryOf(p);
  return (
    <div class="plg plg-manage">
      <div class="plg-group">
        <div class="plg-row static">
          <PluginTile p={p} />
          <div class="plg-row-m">
            <div class="plg-row-t">{p.title}</div>
            <div class="plg-row-s">
              {catInfo(c).title} · v{p.version}
            </div>
          </div>
          {hasToggle(p) && <Switch on={isEnabled(id)} label="启用" onChange={(v) => void setPluginEnabled(id, v)} />}
        </div>
        {p.guide && (
          <button class="plg-link" type="button" onClick={() => openPluginGuide(id)}>
            <span>使用说明</span>
            <MIc n="chevron" />
          </button>
        )}
      </div>

      {opts.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">{c === 'interface' ? '要隐藏的地方' : '显示的入口'}</h2>
          <div class="plg-group">
            {opts.map((o) => (
              <div class="plg-row static" key={o.key}>
                <div class="plg-row-m">
                  <div class="plg-row-t">{o.title}</div>
                  {o.sub && <div class="plg-row-s wrap">{o.sub}</div>}
                </div>
                <Switch on={isOptionOn(id, o.key)} label={o.title} disabled={!isEnabled(id)} onChange={(v) => void setPluginOption(id, o.key, v)} />
              </div>
            ))}
          </div>
          {!prefs.value.advanced && <p class="plg-note">高级模式下生效。</p>}
          {c === 'interface' && (
            <LayoutPreview p={p} enabledKeys={new Set((p.layout?.hide ?? []).filter((k) => isOptionOn(id, `hide:${k}`)))} />
          )}
        </section>
      )}

      {c === 'appearance' && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">外观</h2>
          <div class="plg-group">
            <div class="plg-row static">
                <div class="plg-row-m">
                <div class="plg-row-t">浅色和深色各一套</div>
                <div class="plg-row-s wrap">跟着「设置 → 外观」切换。同一时间只用一款皮肤。</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {p.skills && p.skills.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">技能</h2>
          <div class="plg-group">
            {p.skills.map((s) => (
              <div class="plg-row static" key={s.name}>
                <div class="plg-row-m">
                  <div class="plg-row-t mono">/{s.name}</div>
                  <div class="plg-row-s">装在本机引擎的 ~/.dsh/skills/{s.name}</div>
                </div>
              </div>
            ))}
          </div>
          <p class="plg-note">在输入框里输入 / 就能找到。卸载插件会把这些技能一起删掉。</p>
        </section>
      )}

      {p.schedules && p.schedules.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">自动化任务</h2>
          <div class="plg-group">
            {p.schedules.map((s) => (
              <ScheduleRow key={s.id} pluginId={id} s={s} />
            ))}
          </div>
          <p class="plg-note">时间按这台设备的时区。暂停或查看运行记录在「自动化任务」里；卸载插件会删掉这些任务。</p>
        </section>
      )}

      {hasStorage && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">本地数据</h2>
          <div class="plg-group">
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-t">这台设备上保存了 {data ? `${data.items} 项` : '…'}</div>
                <div class="plg-row-s">{data ? fmtBytes(data.bytes) : ''}</div>
              </div>
              <button
                class="plg-btn sm"
                type="button"
                disabled={!data?.items}
                onClick={() =>
                  confirm('清除这个插件的数据？', `「${p.title}」保存的内容会被删除，插件本身保留。`, '清除', async () => {
                    await clearPluginData(id);
                    setData(await pluginDataSize(id));
                    showToast('已清除');
                  })
                }
              >
                清除
              </button>
            </div>
          </div>
        </section>
      )}

      {p.engine && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">引擎部分</h2>
          <div class="plg-group">
            <button class="plg-link" type="button" onClick={() => openFeature('cordis')}>
              <span>在主机上管理 <span class="mono">{p.engine.package}</span></span>
              <MIc n="chevron" />
            </button>
          </div>
        </section>
      )}

      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-link danger" type="button" onClick={() => uninstall(p)}>
            <span>卸载插件</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function ScheduleRow({ pluginId, s }: { pluginId: string; s: NonNullable<ApiDemoManifest['schedules']>[number] }) {
  const sid = madeBy(pluginId)?.schedules?.[s.id];
  const [state, setState] = useState<{ time?: string; active: boolean } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (sid) void scheduleState(sid).then(setState);
  }, [sid]);
  const canTime = s.timing.kind !== 'every';
  const label = state?.time && canTime ? describeTiming({ ...s.timing, time: state.time } as typeof s.timing) : describeTiming(s.timing);
  return (
    <div class="plg-row static">
      <div class="plg-row-m">
        <div class="plg-row-t">{s.title}</div>
        <div class="plg-row-s">{state === null ? '已在「自动化任务」里删除' : `${label}${state && !state.active ? ' · 已暂停' : ''}`}</div>
      </div>
      {sid && state && canTime && (
        <input
          class="sk-time"
          type="time"
          aria-label={`${s.title}的时间`}
          value={state.time ?? (s.timing as { time: string }).time}
          onChange={async (e) => {
            const v = (e.target as HTMLInputElement).value;
            try {
              await setScheduleTime(sid, s.timing, v);
              setState(await scheduleState(sid));
              showToast(`改到 ${v}`);
            } catch (err) {
              showToast(errText(err));
            }
          }}
        />
      )}
      {sid && state && (
        <button
          class="plg-btn sm"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await runSchedule(sid);
              showToast('已运行，新对话在边栏里');
            } catch (err) {
              showToast(errText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          运行
        </button>
      )}
    </div>
  );
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
