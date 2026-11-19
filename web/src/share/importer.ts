// Opening a share code: what would change on the active engine (a diff with
// per-item switches) and applying the ticked changes in order — restore point,
// plugins, settings, skills, AGENTS.md (dsh-Go share_import.dart).

import { getClient } from '../state/store';
import { gitRef, pluginTitle, type SharePayload, type SharedPlugin, type SharedSkill } from './models';
import { effective, field, isCredentialRef, isSecretFieldName, isSecretNode, NAMESPACE_LABELS, nsLabel, type SettingsView } from './sanitize';
import type { SchemaNode } from '../ui/pages/host/schema';
import { bundles, isLocalHost, isOnDemand, opResult, presets as listPresets, settingsViews } from './engine';
import { npmFacts, type NpmFacts } from './net';
import { pinRestorePoint, readImportedAgentsMd, readSkill, writeAgentsMd, writeSkill } from './files';

export type ImportSection = 'plugins' | 'presets' | 'settings' | 'skills' | 'agentsMd';
export type ChangeKind = 'add' | 'change' | 'install' | 'upgrade' | 'enable' | 'unchanged' | 'unavailable';
export type Integrity = 'verified' | 'unverifiable' | 'mismatch';

export interface ImportChange {
  id: string;
  section: ImportSection;
  title: string;
  kind: ChangeKind;
  detail?: string;
  defaultOn: boolean;
  /** Changes where requests go or what tools may do: shown in full. */
  sensitive?: boolean;
  blocked?: string;
  mono?: boolean;
  /** A preset is applied with its plugin. */
  follows?: string;
  plugin?: SharedPlugin;
  integrity?: Integrity;
  facts?: NpmFacts | null;
  installSpec?: string;
  ops?: { op: 'set'; path: string[]; value: unknown }[];
  skill?: SharedSkill;
  text?: string;
}
export const toggleable = (c: ImportChange) => !c.blocked && !c.follows && c.kind !== 'unchanged' && c.kind !== 'unavailable';
export const actionable = (c: ImportChange) => !c.blocked && c.kind !== 'unchanged' && c.kind !== 'unavailable';

export interface ImportPlan {
  payload: SharePayload;
  isLocal: boolean;
  changes: ImportChange[];
}
export const defaultSelection = (p: ImportPlan) => new Set(p.changes.filter((c) => toggleable(c) && c.defaultOn).map((c) => c.id));
export const selectedSteps = (p: ImportPlan, sel: Set<string>) => p.changes.filter((c) => actionable(c) && (c.follows ? sel.has(c.follows) : sel.has(c.id)));

const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ENDPOINT = /(url|uri|endpoint|host|proxy|registry)$/i;

function short(v: unknown): string {
  const t =
    v == null ? '未设置' : typeof v === 'string' ? v || '空' : typeof v === 'boolean' ? (v ? '开' : '关') : typeof v === 'number' ? String(v) : Array.isArray(v) ? `${v.length} 项` : typeof v === 'object' ? '…' : String(v);
  return t.length <= 18 ? t : `${t.slice(0, 17)}…`;
}

const secretAt = (view: SettingsView | undefined, path: string[], node: SchemaNode | undefined) =>
  isSecretNode(node) || (!isCredentialRef(node) && isSecretFieldName(path[path.length - 1])) || !!view?.secrets.some((p) => jsonEq(p, path));

function hasSecret(view: SettingsView | undefined, path: string[], node: SchemaNode | undefined, value: unknown): boolean {
  if (secretAt(view, path, node)) return true;
  if (Array.isArray(value)) return value.some((item, i) => hasSecret(view, [...path, String(i)], effective(node?.inner), item));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => hasSecret(view, [...path, k], field(node, k), v));
  return false;
}
const mentionsEndpoint = (v: unknown): boolean =>
  Array.isArray(v) ? v.some(mentionsEndpoint) : v && typeof v === 'object' ? Object.keys(v).some((k) => ENDPOINT.test(k)) || Object.values(v).some(mentionsEndpoint) : false;

interface SettingChange {
  path: string[];
  from: unknown;
  to: unknown;
  sensitive: boolean;
}

/** Leaf by leaf, credentials left out; lists are written whole. */
function settingChanges(ns: string, values: Record<string, unknown>, view: SettingsView | undefined): SettingChange[] {
  const out: SettingChange[] = [];
  const visit = (path: string[], from: unknown, to: unknown, node: SchemaNode | undefined, sensitive: boolean) => {
    if (secretAt(view, path, node)) return;
    sensitive = sensitive || ENDPOINT.test(path[path.length - 1]) || isCredentialRef(node);
    if (to && typeof to === 'object' && !Array.isArray(to)) {
      for (const [k, v] of Object.entries(to)) visit([...path, k], from && typeof from === 'object' ? (from as Record<string, unknown>)[k] : undefined, v, field(node, k), sensitive);
    } else if (!hasSecret(view, path, node, to) && !jsonEq(from ?? null, to ?? null)) {
      out.push({ path, from, to, sensitive: sensitive || mentionsEndpoint(to) });
    }
  };
  const always = ns.startsWith('llm-') || ['permission', 'bash-sandbox', 'pwsh-sandbox'].includes(ns);
  for (const [k, v] of Object.entries(values)) visit([k], view?.value[k], v, effective(effective(view?.schema)?.dict[k]), always);
  return out;
}

function settingsDetail(changes: SettingChange[]): string {
  const val = (v: unknown, full: boolean) => (full && typeof v === 'string' ? v : short(v));
  const ordinary = changes.filter((c) => !c.sensitive);
  const shown = [...changes.filter((c) => c.sensitive), ...ordinary.slice(0, 2)].map((c) => `${c.path.join('.')} ${val(c.from, c.sensitive)} → ${val(c.to, c.sensitive)}`);
  return ordinary.length > 2 ? `${shown.join('、')} 等 ${changes.length} 项` : shown.join('、');
}

const sameFiles = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k]?.trim() === v.trim());

export async function planImport(payload: SharePayload): Promise<ImportPlan> {
  const isLocal = isLocalHost();
  const changes: ImportChange[] = [];
  const plugins = payload.kind === 'plugin' ? [payload.plugin] : payload.plugins ?? [];
  let have: Awaited<ReturnType<typeof bundles>> = [];
  try {
    have = await bundles();
  } catch {
    /* unknown: everything shows as an install */
  }
  const facts = new Map<string, NpmFacts | null>();
  await Promise.all(
    plugins
      .filter((p) => p.source === 'npm' && p.version)
      .map(async (p) => facts.set(p.name, await Promise.race([npmFacts(p.name, p.version!).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 8000))]))),
  );
  const installing = new Set<string>();
  for (const p of plugins) {
    const b = have.find((x) => x.name === p.name);
    const id = `plugin:${p.name}`;
    const title = pluginTitle(p);
    if (p.source === 'official') {
      if (!b) changes.push({ id, section: 'plugins', title, kind: 'unavailable', plugin: p, blocked: '这台主机没有这个官方插件', defaultOn: true });
      else if (isOnDemand(b)) {
        changes.push({ id, section: 'plugins', title, kind: 'install', plugin: p, installSpec: b.installTargetSpec, defaultOn: true });
        installing.add(p.name);
      } else if (b.enabled) changes.push({ id, section: 'plugins', title, kind: 'unchanged', plugin: p, detail: '已启用', defaultOn: true });
      else {
        changes.push({ id, section: 'plugins', title, kind: 'enable', plugin: p, defaultOn: true });
        installing.add(p.name);
      }
      continue;
    }
    const f = facts.get(p.name);
    const integrity: Integrity = p.integrity && f?.integrity ? (p.integrity === f.integrity ? 'verified' : 'mismatch') : 'unverifiable';
    const installed = !!b?.installed;
    const same = installed && !!p.version && b?.version === p.version;
    const kind: ChangeKind = same ? 'unchanged' : installed ? 'upgrade' : 'install';
    const blocked = kind !== 'unchanged' && integrity === 'mismatch' ? '与分享时的版本不一致' : undefined;
    if (kind !== 'unchanged' && !blocked) installing.add(p.name);
    changes.push({
      id,
      section: 'plugins',
      title,
      kind,
      plugin: p,
      integrity,
      facts: f,
      installSpec: p.spec,
      detail: kind === 'unchanged' ? '已安装' : kind === 'upgrade' ? `${b?.version ?? '当前版本'} → ${p.version ?? gitRef(p) ?? '新版本'}` : p.version ?? gitRef(p),
      blocked,
      defaultOn: true,
    });
  }

  if (payload.kind === 'profile') {
    const existing = await listPresets();
    for (const preset of payload.presets ?? []) {
      if (existing.some((e) => e.id === preset.id)) continue;
      const owner = preset.bundle ? `plugin:${preset.bundle}` : undefined;
      const oc = changes.find((c) => c.id === owner);
      if (!oc || !actionable(oc)) continue;
      changes.push({ id: `preset:${preset.id}`, section: 'presets', title: preset.name ?? preset.id, kind: 'add', detail: `随「${oc.title}」添加`, follows: owner, defaultOn: true });
    }

    let views = new Map<string, SettingsView>();
    let writable = true;
    let unread = false;
    try {
      ({ views, writable } = await settingsViews());
    } catch {
      writable = false;
      unread = true;
    }
    for (const [ns, values] of Object.entries(payload.settings ?? {})) {
      const view = views.get(ns);
      const diffs = settingChanges(ns, values, view);
      if (!diffs.length) continue;
      const sensitive = diffs.some((d) => d.sensitive);
      const base = { id: `settings:${ns}`, section: 'settings' as const, title: nsLabel(ns, view?.title), mono: !NAMESPACE_LABELS[ns] && !view?.title, sensitive, defaultOn: !sensitive, ops: diffs.map((d) => ({ op: 'set' as const, path: d.path, value: d.to })) };
      if (!view) {
        const later = installing.size > 0;
        changes.push({ ...base, kind: later ? 'add' : 'unavailable', detail: later ? `装好插件后应用 · ${settingsDetail(diffs)}` : undefined, blocked: unread ? '没能读取这台主机的设置' : later ? undefined : '这台主机没有这项设置' });
        continue;
      }
      changes.push({ ...base, kind: diffs.every((d) => d.from == null) ? 'add' : 'change', detail: settingsDetail(diffs), blocked: writable && view.writable ? undefined : '这台主机的设置是只读的' });
    }

    for (const skill of payload.skills ?? []) {
      const id = `skill:${skill.name}`;
      if (!isLocal) {
        changes.push({ id, section: 'skills', title: skill.name, kind: 'unavailable', blocked: '只能导入到本机', skill, defaultOn: false, mono: true });
        continue;
      }
      let current: Record<string, string> | null;
      try {
        current = await readSkill(skill.name);
      } catch {
        changes.push({ id, section: 'skills', title: skill.name, kind: 'unavailable', blocked: '没能读取文件', skill, defaultOn: false, mono: true });
        continue;
      }
      if (current && sameFiles(current, skill.files)) continue;
      changes.push({ id, section: 'skills', title: skill.name, kind: current ? 'change' : 'add', detail: current ? '替换同名技能' : undefined, skill, defaultOn: false, mono: true });
    }
    if (payload.agentsMd) {
      const text = payload.agentsMd;
      if (!isLocal) changes.push({ id: 'agents-md', section: 'agentsMd', title: 'AGENTS.md', kind: 'unavailable', blocked: '只能导入到本机', text, defaultOn: false });
      else {
        const current = await readImportedAgentsMd().catch(() => null);
        if (current?.trim() !== text.trim())
          changes.push({ id: 'agents-md', section: 'agentsMd', title: 'AGENTS.md', kind: current == null ? 'add' : 'change', detail: current == null ? `${text.split('\n').length} 行` : '替换现有内容', text, defaultOn: false });
      }
    }
  }
  return { payload, isLocal, changes };
}

// ---------------------------------------------------------------- applying

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface StepStatus {
  state: StepState;
  message?: string;
}

export interface ImportResult {
  statuses: Record<string, StepStatus>;
  needsRestart: boolean;
  restorePoint: boolean;
}

let seq = 0;

export async function applyImport(plan: ImportPlan, selected: Set<string>, onStep: (id: string, s: StepStatus) => void, cancelled: () => boolean = () => false): Promise<ImportResult> {
  const steps = selectedSteps(plan, selected);
  const statuses: Record<string, StepStatus> = Object.fromEntries(steps.map((s) => [s.id, { state: 'pending' as StepState }]));
  const set = (id: string, s: StepStatus) => {
    statuses[id] = s;
    onStep(id, s);
  };
  const client = getClient();
  let restorePoint = false;
  if (plan.payload.kind === 'profile' && plan.isLocal) restorePoint = await pinRestorePoint().catch(() => false);
  let needsRestart = false;
  const pluginOk = new Map<string, boolean>();

  for (const step of steps.filter((s) => s.section === 'plugins')) {
    if (cancelled()) break;
    set(step.id, { state: 'running' });
    const p = step.plugin!;
    let r: { ok: boolean; restart: boolean; error?: string };
    try {
      if (step.kind === 'enable') r = opResult((await client.setBundleEnabled(p.name, true)) as Record<string, unknown>);
      else {
        if (step.kind === 'upgrade') {
          const removed = opResult(await client.removeBundle(p.name));
          if (!removed.ok) throw new Error(removed.error ?? '没能卸下旧版本');
        }
        r = opResult(await client.installBundle(step.installSpec ?? p.spec!, { enabled: true, saveExact: true, requestId: `api-demo-share-${Date.now()}-${seq++}` }));
      }
    } catch (e) {
      r = { ok: false, restart: false, error: e instanceof Error ? e.message : '安装失败' };
    }
    pluginOk.set(step.id, r.ok);
    needsRestart ||= r.restart;
    set(step.id, r.ok ? { state: 'done', message: r.restart ? '重启后生效' : undefined } : { state: 'failed', message: r.error });
  }
  for (const step of steps.filter((s) => s.section === 'presets')) set(step.id, pluginOk.get(step.follows!) ? { state: 'done' } : { state: 'skipped' });

  const settingsSteps = steps.filter((s) => s.section === 'settings');
  if (settingsSteps.length && !cancelled()) {
    let views = new Map<string, SettingsView>();
    try {
      ({ views } = await settingsViews());
    } catch {
      /* each write reports its own failure */
    }
    for (const step of settingsSteps) {
      if (cancelled()) break;
      const ns = step.id.slice('settings:'.length);
      set(step.id, { state: 'running' });
      const view = views.get(ns);
      if (!view) {
        set(step.id, { state: 'skipped', message: '这台主机没有这项设置' });
        continue;
      }
      try {
        await client.mutateSettings(ns, step.ops!, view.revision);
        set(step.id, { state: 'done' });
      } catch (e) {
        const code = (e as { code?: string }).code;
        set(step.id, { state: 'failed', message: code === 'settings/conflict' ? '设置刚被改过' : code ? '没能写入' : '没能连上主机' });
      }
    }
  }

  for (const step of steps.filter((s) => s.section === 'skills' || s.section === 'agentsMd')) {
    if (cancelled()) break;
    if (!plan.isLocal) {
      set(step.id, { state: 'skipped' });
      continue;
    }
    set(step.id, { state: 'running' });
    try {
      if (step.section === 'skills') await writeSkill(step.skill!);
      else await writeAgentsMd(step.text!);
      set(step.id, { state: 'done' });
    } catch {
      set(step.id, { state: 'failed', message: '没能写入文件' });
    }
  }
  for (const s of steps) if (statuses[s.id].state === 'pending') set(s.id, { state: 'skipped' });
  return { statuses, needsRestart, restorePoint };
}
