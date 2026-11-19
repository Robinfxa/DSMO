// 「分享配置」: what the active engine can put in a profile share, as a
// checklist with sizes (dsh-Go profile_export.dart).

import { pluginFromInstalled, profileJson, repository, gitRef, type ProfileShare, type SharedPlugin, type SharedPreset, type SharedSkill } from './models';
import { nsLabel, sanitizeNamespace } from './sanitize';
import { containsSecret } from './secrets';
import { bundles, isLocalHost, jsonBytes, presets as listPresets, PRESET_MODULE, settingsViews } from './engine';
import { readLocalFiles } from './files';
import { npmFacts } from './net';

export type ExportSection = 'settings' | 'plugins' | 'skills' | 'agentsMd';
export interface ExportItem {
  id: string;
  section: ExportSection;
  title: string;
  subtitle?: string;
  bytes: number;
  unavailable?: string;
  defaultOn: boolean;
  mono?: boolean;
}
export interface ExportSource {
  isLocal: boolean;
  items: ExportItem[];
  settings: Record<string, Record<string, unknown>>;
  plugins: Record<string, SharedPlugin>;
  presets: Record<string, SharedPreset[]>;
  skills: Record<string, SharedSkill>;
  agentsMd?: string;
}

const pluginSubtitle = (p: SharedPlugin) =>
  p.source === 'npm' ? `npm · ${p.version}` : p.source === 'github' ? `GitHub · ${repository(p) ?? p.name}` : p.source === 'git' ? `${repository(p) ?? 'Git'} · ${gitRef(p) ?? ''}` : '官方插件';

export async function loadExport(): Promise<ExportSource> {
  const isLocal = isLocalHost();
  const out: ExportSource = { isLocal, items: [], settings: {}, plugins: {}, presets: {}, skills: {} };
  try {
    const { views } = await settingsViews();
    for (const view of views.values()) {
      const c = sanitizeNamespace(view);
      if (!c || !Object.keys(c.values).length) continue;
      out.settings[view.ns] = c.values;
      out.items.push({ id: `settings:${view.ns}`, section: 'settings', title: nsLabel(view.ns, view.title), subtitle: `${Object.keys(c.values).length} 项`, bytes: jsonBytes({ [view.ns]: c.values }), defaultOn: true });
    }
  } catch {
    /* no settings over this carrier */
  }
  const presetInfo = await listPresets();
  try {
    for (const b of await bundles()) {
      let shared: SharedPlugin | null = null;
      let unavailable: string | undefined;
      if (b.official) {
        if (!(b.installed || (b.optional && b.enabled))) continue;
        shared = { name: b.name, source: 'official', title: b.title, summary: b.summary };
      } else if (b.installed) {
        shared = pluginFromInstalled({ name: b.name, source: b.source, version: b.version, title: b.title, summary: b.summary });
        if (!shared) unavailable = '本地安装，无法分享';
      } else continue;
      const declared = b.rows.filter((r) => r.moduleName === PRESET_MODULE && r.rowId.startsWith('preset-')).map((r) => r.rowId.slice('preset-'.length));
      const ps: SharedPreset[] = declared.map((id) => ({ id, ...(presetInfo.find((p) => p.id === id)?.name ? { name: presetInfo.find((p) => p.id === id)!.name } : {}), bundle: b.name }));
      const sub = [shared ? pluginSubtitle(shared) : null, ps.length ? `含预设「${ps.map((p) => p.name ?? p.id).join('、')}」` : null].filter(Boolean).join(' · ');
      if (shared) {
        out.plugins[b.name] = shared;
        if (ps.length) out.presets[b.name] = ps;
      }
      out.items.push({ id: `plugin:${b.name}`, section: 'plugins', title: b.title, subtitle: unavailable ?? (sub || undefined), bytes: shared ? jsonBytes(shared) + jsonBytes(ps) : 0, unavailable, defaultOn: true });
    }
  } catch {
    /* no plugin list over this carrier */
  }
  if (isLocal) {
    try {
      const files = await readLocalFiles();
      for (const sk of files.skills) {
        const unavailable = Object.values(sk.files).some(containsSecret) ? '含有密钥，无法分享' : undefined;
        if (!unavailable) out.skills[sk.name] = { name: sk.name, files: sk.files };
        out.items.push({ id: `skill:${sk.name}`, section: 'skills', title: sk.name, subtitle: unavailable ?? sk.description, bytes: jsonBytes({ name: sk.name, files: sk.files }), unavailable, defaultOn: true, mono: true });
      }
      if (files.agentsMd) {
        const unavailable = containsSecret(files.agentsMd) ? '含有密钥，无法分享' : undefined;
        out.items.push({ id: 'agents-md', section: 'agentsMd', title: 'AGENTS.md', subtitle: unavailable ?? `${files.agentsMd.split('\n').length} 行`, bytes: jsonBytes(files.agentsMd), unavailable, defaultOn: false });
        if (!unavailable) out.agentsMd = files.agentsMd;
      }
    } catch {
      /* the app can't read them */
    }
  }
  return out;
}

export const defaultSelection = (src: ExportSource) => new Set(src.items.filter((i) => !i.unavailable && i.defaultOn).map((i) => i.id));

export function buildProfile(src: ExportSource, selected: Set<string>, name?: string): ProfileShare {
  const chosen = Object.entries(src.plugins).filter(([k]) => selected.has(`plugin:${k}`)).map(([, v]) => v);
  return profileJson({
    name: name?.trim() || undefined,
    created: new Date().toISOString(),
    settings: Object.fromEntries(Object.entries(src.settings).filter(([k]) => selected.has(`settings:${k}`))),
    plugins: chosen,
    presets: chosen.flatMap((p) => src.presets[p.name] ?? []),
    skills: Object.entries(src.skills).filter(([k]) => selected.has(`skill:${k}`)).map(([, v]) => v),
    agentsMd: selected.has('agents-md') ? src.agentsMd : undefined,
  });
}

/** npm integrity at share time, so the other side can check it. */
export async function withNpmFacts<T extends SharedPlugin>(p: T): Promise<T> {
  if (p.source !== 'npm' || !p.version) return p;
  const f = await Promise.race([npmFacts(p.name, p.version), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  return { ...p, ...(f?.integrity ? { integrity: f.integrity } : {}), ...(f?.publisher && !p.author ? { author: f.publisher } : {}) };
}
