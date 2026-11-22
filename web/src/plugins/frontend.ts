// API Demo frontend plugins: skins, layout tweaks, extra entries and
// sandboxed web panels. A plugin is an npm package whose package.json carries
// an `apiDemo` manifest (and optionally a `dshGo` manifest plus engine code,
// installed on the host as usual). Decision Q7: the engine half installs on the
// host through `pluginManager`, the frontend half is stored on the device.
//
// The three hard rules are enforced here and in ui/Protected.tsx + guard.ts:
// nothing a plugin declares can hide, restyle or replace the approval card,
// the permission page or the login / API-key inputs.

import { computed, signal } from '@preact/signals';
import { native } from '../bridge/native';
import { prefs, getClient, draft, openOverlay, showToast, openPage } from '../state/store';
import type { IconName } from '../ui/icons';
import { OFFICIAL, RETIRED } from './official';
import { loadContributions } from './dshgo';
import { createSchedules, deleteSchedules, skillsInstallable } from './automation';

export type SlotName = 'sider.features' | 'composer.buttons';

export interface ApiDemoManifest {
  v: 1;
  id: string;
  title: string;
  summary: string;
  version: string;
  author?: string;
  official?: boolean;
  license?: string;
  /** Optional; derived from `kinds` when absent. */
  category?: 'appearance' | 'interface' | 'tools' | 'skills' | 'automation' | 'engine';
  /** Clash tags (market/tags.json, conflicts.ts): the shared places it writes to. Same tag, may clash. */
  affects?: string[];
  /** Longer text for the detail page; paragraphs separated by a blank line. */
  description?: string;
  /** Up to five short selling points. */
  highlights?: string[];
  /** 使用说明: where it shows up, how to use it step by step, tips, questions (docs/plugins.md). */
  guide?: PluginGuide;
  kinds: ('skin' | 'layout' | 'slot' | 'panel' | 'engine' | 'skill' | 'schedule')[];
  /** Skills written into the local engine (`/root/.dsh/skills/<name>/`). */
  skills?: { name: string; files: Record<string, string> }[];
  /** Automation tasks created on the host; every run starts a new conversation. */
  schedules?: ManifestSchedule[];
  skin?: { light?: Record<string, string>; dark?: Record<string, string>; css?: string };
  layout?: { hide?: string[] };
  slots?: { slot: SlotName; id: string; title: string; icon?: IconName; action: SlotAction }[];
  panels?: Record<string, { title: string; html: string }>;
  permissions: string[];
  /** The engine half: a DSH plugin package installed on the current host. `shows` is for the store page only. */
  engine?: {
    package: string;
    version: string;
    shows?: { pills?: string[]; sider?: string[]; strip?: string[] };
    /**
     * One request the app sends once the package runs (after install, or after the engine restart it
     * needed): a JSON POST to the package's own routes, `/api/<package>/…`. For defaults DSMO wants
     * different from the package's (the persona library starts with its sample persona on).
     */
    setup?: { path: string; body: Record<string, unknown> };
    /**
     * Engine packages this one takes the place of (a fork under another name: 长期记忆 moved from
     * dsh-plugin-memory-share to dsmo-memory-share). Installing or updating removes them from the
     * host first, so the two never run side by side; their data on the host stays.
     */
    replaces?: string[];
  };
}
export interface PluginGuide {
  /** Where it is once installed, in the app's own words: 「设置 › 陪伴 › 人设」. */
  where: string;
  /** The tutorial: 2–6 steps, each a short title and what to do. */
  steps: { title: string; text: string }[];
  tips?: string[];
  faq?: { q: string; a: string }[];
  /** A button on the guide that takes you there (same as a slot's action). */
  try?: { label: string; action: SlotAction };
}
export interface ManifestSchedule {
  id: string;
  title: string;
  prompt: string;
  timing: { kind: 'daily'; time: string } | { kind: 'weekly'; time: string; weekdays: number[] } | { kind: 'every'; seconds: number };
}
export type SlotAction = { insert: string } | { open: string } | { panel: string };

/** Layout keys a plugin may hide. Protected zones are deliberately absent. */
export const HIDEABLE = new Set([
  'composer.think',
  'composer.search',
  'composer.voice',
  'composer.attach',
  'sider.host',
  'sider.features.plugins',
  'sider.features.skills',
  'sider.features.schedules',
  'sider.features.phone',
  'caveat',
]);
const PROTECTED_WORDS = /approval|permission|login|api-?key|credential|protected/i;

interface Installed {
  id: string;
  enabled: boolean;
  version: string;
  /** Options the user switched off on the 管理 page (`slot:<slot>#<id>`, `hide:<key>`). */
  off?: string[];
  /** What installing made outside the device: schedule ids by manifest id, skill names. */
  made?: { schedules?: Record<string, string>; skills?: string[] };
  /** `engine.setup` has been answered (true), or is still owed (false). */
  setupDone?: boolean;
}

export const installed = signal<Installed[]>([]);
export const pluginCssSuspended = signal(false);
/** A skin being tried on from its detail page; cleared when the page closes. */
export const trialSkin = signal<string | null>(null);
export function setTrialSkin(id: string | null) {
  trialSkin.value = id;
  applySkin();
}
export const catalogPlugins = signal<ApiDemoManifest[]>(OFFICIAL);

export const findPlugin = (id: string) => catalogPlugins.value.find((p) => p.id === id);
export const isInstalled = (id: string) => installed.value.some((p) => p.id === id);
export const isEnabled = (id: string) => installed.value.some((p) => p.id === id && p.enabled);
export const isOptionOn = (id: string, key: string) => !installed.value.find((p) => p.id === id)?.off?.includes(key);

const active = computed(() => installed.value.filter((p) => p.enabled).map((p) => findPlugin(p.id)).filter((p): p is ApiDemoManifest => !!p));

export const layoutHidden = computed(() => {
  const out = new Set<string>();
  if (!prefs.value.advanced) return out; // basic mode stays exactly chat-demo
  for (const p of active.value) for (const k of p.layout?.hide ?? []) if (HIDEABLE.has(k) && isOptionOn(p.id, `hide:${k}`)) out.add(k);
  return out;
});

export function slotItems(slot: SlotName): { key: string; title: string; icon: IconName; run: () => void }[] {
  if (!prefs.value.advanced) return [];
  const out: { key: string; title: string; icon: IconName; run: () => void }[] = [];
  for (const p of active.value)
    for (const s of p.slots ?? [])
      if (s.slot === slot && isOptionOn(p.id, `slot:${s.slot}#${s.id}`))
        out.push({
          key: `${p.id}#${s.id}`,
          title: s.title.slice(0, 12),
          icon: s.icon ?? 'FxPlugin',
          run: () => runSlotAction(p, s.action),
        });
  return out;
}

export function runSlotAction(p: ApiDemoManifest, a: SlotAction) {
  if ('insert' in a) {
    draft.value = (draft.value ? draft.value + '\n' : '') + a.insert.slice(0, 2000);
    document.getElementById('input')?.focus();
  } else if ('panel' in a) {
    if (p.panels?.[a.panel]) openOverlay({ kind: 'panel', pluginId: p.id, panel: a.panel });
  } else if ('open' in a) {
    if (PROTECTED_WORDS.test(a.open)) return showToast('插件不能打开这个页面');
    openPage(a.open);
  }
}

// ------------------------------------------------------------------ install state

export async function loadInstalled() {
  try {
    const raw = await native.storageGet('plugins');
    const list = raw ? (JSON.parse(raw) as Installed[]) : [];
    const all = list.filter((x) => x && typeof x.id === 'string');
    const retired = all.filter((x) => RETIRED.has(x.id) && !findPlugin(x.id));
    installed.value = all.filter((x) => !retired.includes(x));
    if (retired.length) {
      for (const x of retired) await clearPluginData(x.id).catch(() => {});
      await save();
    }
  } catch {
    installed.value = [];
  }
  applySkin();
}
async function save() {
  await native.storageSet('plugins', JSON.stringify(installed.value));
  applySkin();
}

/** What an install left to do: an engine plugin that loads only after the engine restarts. */
export interface InstallOutcome {
  restart: boolean;
}

/** DSH's answer to `pluginManager/installBundle` (ChangeResult): failures arrive as an ok RPC. */
function bundleOutcome(r: Record<string, unknown>): { restart: boolean } {
  const application = typeof r.application === 'string' ? r.application : 'applied';
  if (application === 'failed' || application === 'cancelled') {
    const err = (r.error && typeof r.error === 'object' ? (r.error as Record<string, unknown>) : {}) as Record<string, unknown>;
    const kind = (r.packageResult as Record<string, unknown> | undefined)?.kind;
    const why: Record<string, string> = {
      network: '网络不通，下载不了插件',
      'not-found': '找不到这个插件包',
      'no-matching-version': '找不到这个版本',
      'disk-full': '手机空间不够',
      timeout: '下载超时',
      'build-blocked': '插件需要运行安装脚本，已拦下',
    };
    throw new Error(application === 'cancelled' ? '安装已取消' : why[String(kind)] ?? (typeof err.message === 'string' ? err.message : '引擎没能装上这个插件'));
  }
  return { restart: application === 'restart-required' };
}

/** Sends a plugin's `engine.setup` once; true when the package answered it. */
async function runEngineSetup(p: ApiDemoManifest): Promise<boolean> {
  const setup = p.engine?.setup;
  if (!setup) return true;
  try {
    const res = await fetch(setup.path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(setup.body),
    });
    if (!res.ok) return false;
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return j.ok !== false;
  } catch {
    return false;
  }
}

/** Owed `engine.setup` calls (the engine was off, or needed a restart first): tried at start and when it comes back. */
export async function settleEngineSetups() {
  let changed = false;
  for (const x of installed.value) {
    if (x.setupDone !== false) continue;
    const p = findPlugin(x.id);
    if (!p || !(await runEngineSetup(p))) continue;
    x.setupDone = true;
    changed = true;
  }
  if (changed) {
    installed.value = [...installed.value];
    await save();
  }
}

// ------------------------------------------------------------------ install / update queue

export type PluginJob = { kind: 'install' | 'update'; running: boolean };
/**
 * Installs and updates waiting or under way, by plugin id. They run one at a time (the host
 * installs one bundle at a time, and each one rewrites the installed list) and outlive the page
 * that started them: leave the market and come back, and the button still says 等待中 / 安装中.
 */
export const pluginJobs = signal<Record<string, PluginJob>>({});
const jobRuns = new Map<string, Promise<InstallOutcome>>();
let jobChain: Promise<unknown> = Promise.resolve();
const setJob = (id: string, job: PluginJob | null) => {
  const next = { ...pluginJobs.value };
  if (job) next[id] = job;
  else delete next[id];
  pluginJobs.value = next;
};
function enqueue(id: string, kind: PluginJob['kind'], run: () => Promise<InstallOutcome>): Promise<InstallOutcome> {
  // a second tap on the same plugin joins the first instead of queueing it again
  const same = jobRuns.get(id);
  if (same) return same;
  setJob(id, { kind, running: false });
  const p = jobChain
    .then(() => {
      setJob(id, { kind, running: true });
      return run();
    })
    .finally(() => {
      jobRuns.delete(id);
      setJob(id, null);
    });
  jobChain = p.catch(() => {});
  jobRuns.set(id, p);
  return p;
}
export const pluginBusy = (id: string) => pluginJobs.value[id];

export const installPlugin = (id: string): Promise<InstallOutcome> => enqueue(id, 'install', () => installNow(id));
export const updatePlugin = (id: string): Promise<InstallOutcome> => enqueue(id, 'update', () => updateNow(id));

/** Removes the engine packages [p] replaces that this host still has; throws when one stays. */
async function dropReplaced(p: ApiDemoManifest): Promise<boolean> {
  const old = p.engine?.replaces ?? [];
  if (!old.length) return false;
  const have = new Set((await getClient().listBundles()).map((b) => String(b.name)));
  let restart = false;
  for (const name of old) {
    if (!have.has(name)) continue;
    try {
      restart = (await removeEngineBundle(name)).restart || restart;
    } catch (e) {
      throw new Error(`旧的引擎插件 ${name} 没能卸掉：${(e as Error).message}`);
    }
  }
  return restart;
}

async function installNow(id: string): Promise<InstallOutcome> {
  const p = findPlugin(id);
  if (!p) throw new Error('找不到这个插件');
  validateManifest(p);
  let restart = false;
  let setupDone: boolean | undefined;
  if (p.engine) {
    restart = await dropReplaced(p);
    // Engine half → the current host. Official-only market (Q8): the bundle comes from the pinned version.
    restart = bundleOutcome(await getClient().installBundle(`${p.engine.package}@${p.engine.version}`)).restart || restart;
    void loadContributions();
    if (p.engine.setup) setupDone = !restart && (await runEngineSetup(p));
  }
  const made: NonNullable<Installed['made']> = {};
  if (p.skills?.length) {
    if (!skillsInstallable()) throw new Error('技能只能装到这台手机上的引擎，先切回本机');
    await native.installSkills(p.skills);
    made.skills = p.skills.map((s) => s.name);
  }
  if (p.schedules?.length) {
    try {
      made.schedules = await createSchedules(p.schedules);
    } catch (e) {
      if (made.skills) await native.removeSkills(made.skills).catch(() => {});
      throw e;
    }
  }
  installed.value = [...installed.value.filter((x) => x.id !== id), { id, enabled: true, version: p.version, made, ...(setupDone === undefined ? {} : { setupDone }) }];
  // A skin replaces any other active skin.
  if (p.kinds.includes('skin'))
    installed.value = installed.value.map((x) => (x.id !== id && findPlugin(x.id)?.kinds.includes('skin') ? { ...x, enabled: false } : x));
  await save();
  return { restart };
}

// ------------------------------------------------------------------ updates

/** a is a later version than b (numeric dot parts: 1.0.10 > 1.0.9; a pre-release tag is ignored). */
export function newerVersion(a: string, b: string): boolean {
  const parts = (v: string) => String(v ?? '').split(/[-+]/)[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** Installed plugins the market has a later version of (the page's market comes with the hot-updated page). */
export const pluginUpdates = computed(() =>
  installed.value.filter((x) => {
    const p = findPlugin(x.id);
    return !!p && newerVersion(p.version, x.version);
  }).map((x) => x.id),
);
export const hasUpdate = (id: string) => pluginUpdates.value.includes(id);

/**
 * Brings an installed plugin to the market's version: the engine half to its newly pinned version
 * (its data on the host stays), the skills it brings rewritten. Options, on/off, schedules and
 * the one-time engine setup stay as they are.
 */
async function updateNow(id: string): Promise<InstallOutcome> {
  const p = findPlugin(id);
  const x = installed.value.find((i) => i.id === id);
  if (!p || !x) throw new Error('找不到这个插件');
  validateManifest(p);
  let restart = false;
  if (p.engine) {
    const dropped = await dropReplaced(p);
    // DSH refuses installBundle over an installed package (`already-installed`): updateBundle
    // removes the old version and installs the new one; the plugin's data on the host stays.
    const u = (await getClient().updateBundle(p.engine.package, p.engine.version)) as Record<string, unknown>;
    const from = typeof u.from === 'string' ? u.from : '';
    if (!from) {
      // not on this host (another host, or removed there): install it
      restart = bundleOutcome(await getClient().installBundle(`${p.engine.package}@${p.engine.version}`)).restart;
    } else if (u.step === 'check' && !newerVersion(p.engine.version, from)) {
      // already this version or newer there
    } else {
      restart = bundleOutcome((u.result ?? {}) as Record<string, unknown>).restart;
    }
    restart ||= dropped;
    void loadContributions();
  }
  let skills = x.made?.skills;
  if (p.skills?.length && skillsInstallable()) {
    await native.installSkills(p.skills);
    const now = p.skills.map((k) => k.name);
    const gone = (skills ?? []).filter((n) => !now.includes(n));
    if (gone.length) await native.removeSkills(gone).catch(() => {});
    skills = now;
  }
  installed.value = installed.value.map((i) => (i.id === id ? { ...i, version: p.version, made: { ...(i.made ?? {}), ...(skills ? { skills } : {}) } } : i));
  await save();
  return { restart };
}

/** Official plugins update themselves; one try per version while the engine stays up (it may be off at start). */
const autoTried = new Set<string>();
let autoRun: Promise<{ updated: string[]; restart: boolean }> | null = null;

/** Updates every installed official plugin that has an update; returns the titles updated. */
export function autoUpdatePlugins(): Promise<{ updated: string[]; restart: boolean }> {
  if (autoRun) return autoRun;
  autoRun = (async () => {
    await null; // let autoRun be set first: with nothing to do, `finally` would otherwise run before it
    const out = { updated: [] as string[], restart: false };
    try {
      for (const id of [...pluginUpdates.value]) {
        const p = findPlugin(id);
        if (!p?.official) continue;
        const key = `${id}@${p.version}`;
        if (autoTried.has(key)) continue;
        autoTried.add(key);
        try {
          const r = await updatePlugin(id);
          out.updated.push(p.title);
          out.restart ||= r.restart;
        } catch {
          // stays 「有更新」; the button tries again, and so does the next engine start
        }
      }
    } finally {
      autoRun = null;
    }
    return out;
  })();
  return autoRun;
}

/** The engine came back (or the page started): failed tries get another go. */
export function retryAutoUpdates() {
  autoTried.clear();
  return autoUpdatePlugins();
}

/**
 * DSH's answer to `pluginManager/removeBundle` (ChangeResult): failures arrive as an ok RPC with
 * `application: 'failed'` and `error.code` (ManagementFailure). Throws with a reason the person can
 * act on; an unreachable engine throws from the call itself.
 */
async function removeEngineBundle(pkg: string): Promise<{ restart: boolean }> {
  const r = await getClient().removeBundle(pkg);
  const application = typeof r.application === 'string' ? r.application : 'applied';
  if (application === 'failed' || application === 'cancelled') {
    const err = (r.error && typeof r.error === 'object' ? r.error : {}) as Record<string, unknown>;
    const code = String(err.code ?? '');
    // not-removable is also the answer for a package the engine doesn't have: then it's gone already
    if (code === 'not-removable' && !(await getClient().listBundles()).some((b) => b.name === pkg)) return { restart: false };
    const why: Record<string, string> = {
      'not-removable': '引擎不让卸载这个插件包',
      'stop-profile': '插件正在引擎里运行，这次没能停下：重启引擎后再卸载',
      'bundle-in-use': '插件正在被使用：等这一轮对话结束，或重启引擎后再卸载',
    };
    const diag = typeof err.diagnostic === 'string' ? err.diagnostic.trim().slice(0, 300) : '';
    throw new Error(application === 'cancelled' ? '卸载被取消了' : (why[code] ?? (diag || `引擎没能卸载（${code || '原因不明'}）`)));
  }
  return { restart: application === 'restart-required' };
}

/**
 * Uninstall. The engine half goes first: when the engine can't remove it, nothing here changes and
 * the reason is thrown, unless [force] (the person chose to remove it from DSMO anyway; the engine
 * keeps running it). `restart`: the engine removed it but keeps it loaded until it restarts.
 * What the engine half stored under the engine's data folder stays (DSH removes only the package).
 */
export async function removePlugin(id: string, { force = false } = {}): Promise<{ restart: boolean }> {
  const p = findPlugin(id);
  let restart = false;
  if (p?.engine) {
    try {
      restart = (await removeEngineBundle(p.engine.package)).restart;
    } catch (e) {
      if (!force) throw e;
    }
    // the package this one replaced, if the host still has it (it would keep running)
    try {
      restart = (await dropReplaced(p)) || restart;
    } catch (e) {
      if (!force) throw e;
    }
    void loadContributions();
  }
  const made = installed.value.find((x) => x.id === id)?.made;
  if (made?.schedules) await deleteSchedules(Object.values(made.schedules)).catch(() => {});
  if (made?.skills) await native.removeSkills(made.skills).catch(() => {});
  installed.value = installed.value.filter((x) => x.id !== id);
  if (trialSkin.value === id) setTrialSkin(null);
  await clearPluginData(id);
  await save();
  return { restart };
}

export async function setPluginOption(id: string, key: string, on: boolean) {
  installed.value = installed.value.map((x) => {
    if (x.id !== id) return x;
    const off = new Set(x.off ?? []);
    on ? off.delete(key) : off.add(key);
    return { ...x, off: [...off] };
  });
  await save();
}

// ------------------------------------------------------------------ plugin data (panels' apiDemo.storage)

const dataKey = (id: string, key: string) => `plugin:${id}:${key}`;
const indexKey = (id: string) => `plugin-keys:${id}`;

async function dataKeys(id: string): Promise<string[]> {
  try {
    const raw = await native.storageGet(indexKey(id));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export async function pluginDataGet(id: string, key: string) {
  return native.storageGet(dataKey(id, key));
}

export async function pluginDataSet(id: string, key: string, value: string | null) {
  await native.storageSet(dataKey(id, key), value);
  const keys = new Set(await dataKeys(id));
  const had = keys.has(key);
  value === null ? keys.delete(key) : keys.add(key);
  if (had !== keys.has(key)) await native.storageSet(indexKey(id), keys.size ? JSON.stringify([...keys]) : null);
  dataChanged(id);
}
/** Tells whoever shows a plugin's data (the chat background) that it changed. */
const dataChanged = (id: string) => window.dispatchEvent(new CustomEvent('api-demo:plugin-data', { detail: id }));

/** Bytes this plugin keeps on the device (UTF-16 length of the stored strings). */
export async function pluginDataSize(id: string): Promise<{ items: number; bytes: number }> {
  let bytes = 0;
  const keys = await dataKeys(id);
  for (const k of keys) bytes += ((await native.storageGet(dataKey(id, k))) ?? '').length * 2;
  return { items: keys.length, bytes };
}

export async function clearPluginData(id: string) {
  for (const k of await dataKeys(id)) await native.storageSet(dataKey(id, k), null);
  await native.storageSet(indexKey(id), null);
  dataChanged(id);
}

export const madeBy = (id: string) => installed.value.find((x) => x.id === id)?.made;

export async function setPluginEnabled(id: string, enabled: boolean) {
  installed.value = installed.value.map((x) => (x.id === id ? { ...x, enabled } : findPlugin(id)?.kinds.includes('skin') && enabled && findPlugin(x.id)?.kinds.includes('skin') ? { ...x, enabled: false } : x));
  if (enabled) pluginCssSuspended.value = false;
  await save();
}

// ------------------------------------------------------------------ validation

/** Throws on anything that would break the hard rules; the market check script runs the same rules. */
export function validateManifest(p: ApiDemoManifest) {
  if (p.v !== 1) throw new Error('不支持的插件格式');
  for (const k of p.layout?.hide ?? []) if (!HIDEABLE.has(k)) throw new Error(`插件想隐藏「${k}」，这是不允许的`);
  for (const mode of ['light', 'dark'] as const) for (const [k, v] of Object.entries(p.skin?.[mode] ?? {})) checkToken(k, v);
  for (const s of p.slots ?? []) if ('open' in s.action && PROTECTED_WORDS.test(s.action.open)) throw new Error('插件入口不能指向受保护的页面');
  const t = p.guide?.try?.action;
  if (t && 'open' in t && PROTECTED_WORDS.test(t.open)) throw new Error('插件入口不能指向受保护的页面');
  checkEngineSetup(p);
}

/** `engine.setup` may only reach the package's own routes, with a small JSON body. */
export function checkEngineSetup(p: Pick<ApiDemoManifest, 'engine'>) {
  const r = p.engine?.replaces;
  if (r !== undefined && (!Array.isArray(r) || r.length > 4 || r.some((n) => typeof n !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(n) || n === p.engine!.package)))
    throw new Error('engine.replaces 要是别的引擎包名（最多 4 个）');
  const setup = p.engine?.setup;
  if (!setup) return;
  const own = `/api/${p.engine!.package}/`;
  if (typeof setup.path !== 'string' || !setup.path.startsWith(own) || /\.\.|[?#\\]/.test(setup.path)) throw new Error(`engine.setup 只能调用 ${own} 下的接口`);
  if (!setup.body || typeof setup.body !== 'object' || Array.isArray(setup.body) || JSON.stringify(setup.body).length > 2048) throw new Error('engine.setup 的 body 要是 2 KB 以内的 JSON 对象');
}

export function checkToken(name: string, value: string) {
  if (!/^--(dsw|ds|m)-[a-z0-9-]+$/.test(name)) throw new Error(`皮肤只能改设计变量，「${name}」不是`);
  if (value.length > 200 || /[;{}<>]|url\(|expression|@import|\\/i.test(value)) throw new Error(`「${name}」的值不合规`);
}

// ------------------------------------------------------------------ skin

let skinStyle: HTMLStyleElement | null = null;
let cssStyle: HTMLStyleElement | null = null;

/** Applies the enabled skin: tokens always; custom CSS only while the guard allows it. */
export function applySkin() {
  const trial = trialSkin.value ? findPlugin(trialSkin.value) : undefined;
  const skin = (trial ?? active.value.find((p) => p.kinds.includes('skin')))?.skin;
  skinStyle ??= document.head.appendChild(Object.assign(document.createElement('style'), { id: 'plugin-skin' }));
  cssStyle ??= document.head.appendChild(Object.assign(document.createElement('style'), { id: 'plugin-css' }));
  const decl = (m?: Record<string, string>) =>
    Object.entries(m ?? {})
      .filter(([k, v]) => {
        try {
          checkToken(k, v);
          return true;
        } catch {
          return false;
        }
      })
      .map(([k, v]) => `${k}: ${v};`)
      .join(' ');
  skinStyle.textContent = skin
    ? `body:not([data-ds-dark-theme]) { ${decl(skin.light)} } body[data-ds-dark-theme] { ${decl(skin.dark)} }\n` +
      `body.is-m:not([data-ds-dark-theme]) { ${decl(phoneTokens(skin.light))} } body.is-m[data-ds-dark-theme] { ${decl(phoneTokens(skin.dark))} }`
    : '';
  cssStyle.textContent = skin?.css && !pluginCssSuspended.value ? skin.css : '';
}

/**
 * The phone layout has its own tokens (--m-*). A skin written for the web tokens
 * still reaches the phone: the common ones are mapped over unless the skin sets --m-* itself.
 */
export const PHONE_MAP: Record<string, string> = {
  '--dsw-alias-bg-base': '--m-bg',
  '--dsw-specific-sidebar-fill': '--m-page',
  '--dsw-specific-bubble': '--m-bubble',
  '--dsw-specific-input-major': '--m-card2',
  '--dsw-alias-brand-primary': '--m-accent',
};
export function phoneTokens(m?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    if (k.startsWith('--m-')) out[k] = v;
    else if (PHONE_MAP[k] && !(PHONE_MAP[k] in (m ?? {}))) out[PHONE_MAP[k]] = v;
  }
  if (out['--m-accent'] && !out['--m-accent-soft']) out['--m-accent-soft'] = `color-mix(in srgb, ${out['--m-accent']} 16%, transparent)`;
  if (out['--m-bg'] && !out['--m-card']) out['--m-card'] = `color-mix(in srgb, ${out['--m-bg']} 92%, currentColor)`;
  return out;
}

export function suspendPluginCss(reason: string) {
  if (pluginCssSuspended.value) return;
  pluginCssSuspended.value = true;
  applySkin();
  showToast(reason);
}

export const hasPluginCss = () => !!cssStyle?.textContent;
