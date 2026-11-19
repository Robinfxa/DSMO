// Reading the active engine the way the share pages need it: settings views
// (with the user layer and secret slots), bundles, presets.

import { getClient, nativeInfo } from '../state/store';
import { parseSchema, text as i18n } from '../ui/pages/host/schema';
import type { SettingsView } from './sanitize';

const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export async function settingsViews(): Promise<{ views: Map<string, SettingsView>; writable: boolean }> {
  const d = o(await getClient().describeSettings());
  const writable = d.writable !== false;
  const views = new Map<string, SettingsView>();
  for (const raw of Array.isArray(d.namespaces) ? d.namespaces : []) {
    const n = o(raw);
    const ns = s(n.ns);
    if (!ns) continue;
    views.set(ns, {
      ns,
      title: s(n.title),
      schema: parseSchema(n.schema),
      value: o(n.value),
      user: n.user && typeof n.user === 'object' ? o(n.user) : undefined,
      revision: Number(n.revision ?? 0),
      secrets: (Array.isArray(n.secrets) ? n.secrets : []).map((x) => (Array.isArray(o(x).path) ? (o(x).path as unknown[]).map(String) : [])),
      writable: writable && n.writable !== false,
    });
  }
  return { views, writable };
}

export interface Bundle {
  name: string;
  official: boolean;
  availability: string;
  installTargetSpec?: string;
  version?: string;
  title: string;
  summary?: string;
  enabled: boolean;
  installed: boolean;
  optional: boolean;
  source?: string;
  rows: { rowId: string; moduleName: string }[];
}
export const isOnDemand = (b: Bundle) => b.official && !b.installed && b.availability === 'missing' && !!b.installTargetSpec;

export async function bundles(): Promise<Bundle[]> {
  return (await getClient().listBundles()).map((b) => ({
    name: s(b.name) ?? '',
    official: b.official === true,
    availability: s(b.availability) ?? 'profile',
    installTargetSpec: s(o(b.installTarget).spec),
    version: s(b.version),
    title: i18n(o(b.meta).title) || s(b.name) || '',
    summary: i18n(o(b.meta).description) || s(b.description),
    enabled: b.enabled === true,
    installed: b.installed === true,
    optional: b.optional === true,
    source: s(b.source),
    rows: (Array.isArray(b.rows) ? b.rows : []).map((r) => ({ rowId: s(o(r).rowId) ?? '', moduleName: s(o(r).moduleName) ?? '' })),
  }));
}

export async function presets(): Promise<{ id: string; name?: string }[]> {
  try {
    return (await getClient().listAgentPresets()).map((p) => ({ id: String(p.id ?? ''), name: s(p.name) }));
  } catch {
    return [];
  }
}

export const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset';

/** The host the chat talks to is this phone's own engine. */
export const isLocalHost = () => (nativeInfo.value?.hosts.find((h) => h.current)?.id ?? 'local') === 'local';
export const hostLabel = () => nativeInfo.value?.hosts.find((h) => h.current)?.label ?? '本机';

export const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
export function formatBytes(n: number) {
  if (n < 1000) return `${n} B`;
  const kb = n / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

/** Whether an operation result took effect (applied / restart-required / overridden). */
export function opResult(r: Record<string, unknown>): { ok: boolean; restart: boolean; error?: string } {
  const a = r.application;
  if (a === undefined && !r.error) return { ok: true, restart: false };
  const ok = a === 'applied' || a === 'restart-required' || a === 'overridden';
  return { ok, restart: a === 'restart-required', error: ok ? undefined : s(o(r.error).message) ?? '安装失败' };
}
