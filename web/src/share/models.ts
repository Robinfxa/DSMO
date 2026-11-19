// What a share code carries (dsh-Go app/lib/share_code/share_models.dart): one
// plugin, or a profile exported from an engine. Strict about what may be
// installed from a link, lenient about display text.

import { ShareFormatError, SHARE_FORMAT_VERSION } from './codec';
import { isShareableNamespace } from './sanitize';

export type PluginSource = 'npm' | 'github' | 'git' | 'official';

export interface SharedPlugin {
  name: string;
  source: PluginSource;
  /** What `pluginManager/installBundle` gets; none for official bundles. */
  spec?: string;
  version?: string;
  integrity?: string;
  title?: string;
  author?: string;
  summary?: string;
}
export interface SharedPreset {
  id: string;
  name?: string;
  bundle?: string;
}
export interface SharedSkill {
  name: string;
  /** Relative path → text; SKILL.md always. */
  files: Record<string, string>;
}
export interface PluginShare {
  v: number;
  kind: 'plugin';
  plugin: SharedPlugin;
}
export interface ProfileShare {
  v: number;
  kind: 'profile';
  name?: string;
  created?: string;
  settings?: Record<string, Record<string, unknown>>;
  plugins?: SharedPlugin[];
  presets?: SharedPreset[];
  skills?: SharedSkill[];
  agentsMd?: string;
}
export type SharePayload = PluginShare | ProfileShare;

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const GITHUB = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([A-Za-z0-9_./-]+)(&path:\/[A-Za-z0-9_./@+-]+)?$/;
const GIT_HTTPS = /^git\+https:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9_./-]+?)(?:\.git)?#([A-Za-z0-9_./-]+)(&path:\/[A-Za-z0-9_./@+-]+)?$/;
const INTEGRITY = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const NUM = '0|[1-9]\\d*';
const PRE = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}(?:\\.${PRE})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`);

export const isPackageName = (n: string) => n.length <= 214 && PACKAGE.test(n);
export const isExactSemver = (v: string) => SEMVER.test(v);

const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
/** Display text: one line, trimmed, at most [max] characters. */
export function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export const pluginTitle = (p: SharedPlugin) => p.title?.trim() || p.name;
export function repository(p: SharedPlugin): string | undefined {
  if (!p.spec) return undefined;
  const g = GITHUB.exec(p.spec);
  if (g) return `${g[1]}/${g[2]}`;
  const h = GIT_HTTPS.exec(p.spec);
  if (h) return h[1] === 'github.com' ? h[2].split('/').slice(0, 2).join('/') : h[1];
  return undefined;
}
export const gitRef = (p: SharedPlugin) => (p.spec ? (GITHUB.exec(p.spec) ?? GIT_HTTPS.exec(p.spec))?.[3] : undefined);

export function readPlugin(json: unknown): SharedPlugin {
  if (!json || typeof json !== 'object') throw new ShareFormatError('plugin is not an object');
  const j = json as Record<string, unknown>;
  const name = s(j.name);
  if (!name || !isPackageName(name)) throw new ShareFormatError('bad plugin name');
  const source = s(j.source) as PluginSource | undefined;
  if (!source || !['npm', 'github', 'git', 'official'].includes(source)) throw new ShareFormatError('unknown plugin source');
  const spec = s(j.spec);
  const version = s(j.version);
  const integrity = s(j.integrity);
  switch (source) {
    case 'npm':
      if (!version || !isExactSemver(version)) throw new ShareFormatError('npm needs an exact version');
      if (spec !== `${name}@${version}`) throw new ShareFormatError('npm spec must be name@version');
      if (integrity && !INTEGRITY.test(integrity)) throw new ShareFormatError('bad integrity');
      break;
    case 'github':
      if (!spec || !(GITHUB.test(spec) || GIT_HTTPS.exec(spec)?.[1] === 'github.com')) throw new ShareFormatError('not a GitHub spec');
      break;
    case 'git':
      if (!spec || !GIT_HTTPS.test(spec)) throw new ShareFormatError('not an https git spec');
      break;
    case 'official':
      if (spec) throw new ShareFormatError('official bundles carry no spec');
  }
  return clean({
    name,
    source,
    spec,
    version: version && isExactSemver(version) ? version : undefined,
    integrity: source === 'npm' ? integrity : undefined,
    title: text(j.title, 80),
    author: text(j.author, 80),
    summary: text(j.summary, 200),
  });
}

/** From an installed bundle's `pnpm add` spec; null for what a link can't carry. */
export function pluginFromInstalled(b: { name: string; source?: string; version?: string; title?: string; summary?: string }): SharedPlugin | null {
  const src = b.source?.trim();
  if (!src) return null;
  let source: PluginSource | undefined;
  let spec: string | undefined;
  if (GITHUB.test(src)) [source, spec] = ['github', src];
  else if (GIT_HTTPS.test(src)) [source, spec] = [GIT_HTTPS.exec(src)![1] === 'github.com' ? 'github' : 'git', src];
  else if (b.version && isExactSemver(b.version) && isRegistrySpec(src, b.name)) [source, spec] = ['npm', `${b.name}@${b.version}`];
  if (!source) return null;
  return clean({ name: b.name, source, spec, version: b.version && isExactSemver(b.version) ? b.version : undefined, title: text(b.title, 80), summary: text(b.summary, 200) });
}
function isRegistrySpec(spec: string, name: string) {
  const t = spec.startsWith('npm:') ? spec.slice(4) : spec;
  if (t === name) return true;
  if (!t.startsWith(`${name}@`)) return false;
  return /^[\w.^~<>=|* -]+$/.test(t.slice(name.length + 1));
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SKILL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,3}$/;
export const SKILL_MAX_FILES = 12;
export const SKILL_MAX_FILE_CHARS = 64 * 1024;
export const isSafeSkillPath = (p: string) => SKILL_PATH.test(p) && !p.split('/').some((x) => x === '..' || x === '.' || x.startsWith('.'));

export function readSkill(json: unknown): SharedSkill {
  if (!json || typeof json !== 'object') throw new ShareFormatError('skill is not an object');
  const j = json as Record<string, unknown>;
  const name = s(j.name);
  if (!name || !SKILL_NAME.test(name)) throw new ShareFormatError('bad skill name');
  const files = j.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new ShareFormatError('bad skill files');
  const entries = Object.entries(files as Record<string, unknown>);
  if (!entries.length || entries.length > SKILL_MAX_FILES) throw new ShareFormatError('bad skill files');
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!isSafeSkillPath(k) || typeof v !== 'string') throw new ShareFormatError('bad skill file');
    if (v.length > SKILL_MAX_FILE_CHARS) throw new ShareFormatError('skill file too large');
    out[k] = v;
  }
  if (!('SKILL.md' in out)) throw new ShareFormatError('skill without SKILL.md');
  return { name, files: out };
}

function readPreset(json: unknown): SharedPreset {
  const j = (json ?? {}) as Record<string, unknown>;
  const id = s(j.id);
  if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new ShareFormatError('bad preset');
  return clean({ id, name: text(j.name, 60), bundle: s(j.bundle) });
}

const NS = /^[A-Za-z0-9._:@/-]{1,80}$/;
export const MAX_AGENTS_MD = 64 * 1024;

/** Validates a decoded body (anything but a conversation). */
export function readPayload(json: Record<string, unknown>): SharePayload {
  const v = json.v;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ShareFormatError('no format version');
  if (v > SHARE_FORMAT_VERSION) throw new ShareFormatError('newer format');
  if (json.kind === 'plugin') return { v, kind: 'plugin', plugin: readPlugin(json.plugin) };
  if (json.kind !== 'profile') throw new ShareFormatError(json.kind === 'conversation' ? 'conversation' : 'unknown kind');
  const settings: Record<string, Record<string, unknown>> = {};
  if (json.settings != null) {
    if (typeof json.settings !== 'object' || Array.isArray(json.settings)) throw new ShareFormatError('settings is not an object');
    for (const [ns, val] of Object.entries(json.settings as Record<string, unknown>)) {
      if (!NS.test(ns) || !val || typeof val !== 'object' || Array.isArray(val)) throw new ShareFormatError('bad settings');
      if (isShareableNamespace(ns)) settings[ns] = { ...(val as Record<string, unknown>) };
    }
  }
  const list = <T,>(raw: unknown, read: (x: unknown) => T, max: number): T[] => {
    if (raw == null) return [];
    if (!Array.isArray(raw) || raw.length > max) throw new ShareFormatError('bad list');
    return raw.map(read);
  };
  const agentsMd = json.agentsMd;
  if (agentsMd != null && (typeof agentsMd !== 'string' || agentsMd.length > MAX_AGENTS_MD)) throw new ShareFormatError('bad AGENTS.md');
  const created = s(json.created);
  return clean({
    v,
    kind: 'profile' as const,
    name: text(json.name, 40),
    created: created && !Number.isNaN(Date.parse(created)) ? created : undefined,
    settings,
    plugins: list(json.plugins, readPlugin, 64),
    presets: list(json.presets, readPreset, 64),
    skills: list(json.skills, readSkill, 32),
    agentsMd: typeof agentsMd === 'string' && agentsMd.trim() ? agentsMd : undefined,
  });
}

/** The body as dsh-Go writes it (empty sections left out). */
export function profileJson(p: Omit<ProfileShare, 'v' | 'kind'>): ProfileShare {
  return clean({
    v: SHARE_FORMAT_VERSION,
    kind: 'profile' as const,
    name: p.name,
    created: p.created,
    settings: p.settings && Object.keys(p.settings).length ? p.settings : undefined,
    plugins: p.plugins?.length ? p.plugins : undefined,
    presets: p.presets?.length ? p.presets : undefined,
    skills: p.skills?.length ? p.skills : undefined,
    agentsMd: p.agentsMd,
  });
}
export const pluginJson = (plugin: SharedPlugin): PluginShare => ({ v: SHARE_FORMAT_VERSION, kind: 'plugin', plugin });

export const isEmptyProfile = (p: ProfileShare) => !Object.keys(p.settings ?? {}).length && !p.plugins?.length && !p.presets?.length && !p.skills?.length && !p.agentsMd;

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
