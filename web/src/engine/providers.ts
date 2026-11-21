// 模型提供方: adding a hand-declared route to dsh-Go's pi-ai adapter, the way dsh-Go's own provider
// form does it (dsh-go app/lib/state/providers_state.dart, packages/dsh_client providers_api.dart):
// the settings namespace is `llm-pi-ai`; a route id is `custom-<slug>`; the profile names its key by
// a credential reference (`apiKeyEnv`) and the key itself goes to `credentials/set`; models are
// `{ id, name?, contextWindow?, maxTokens?, input? }` objects, at least one.

import { getClient } from '../state/store';

/** Settings namespace (Loader entry id) of the pi-ai adapter. */
export const PI_AI_NS = 'llm-pi-ai';
/** Older prototypes and fixtures called it this. */
export const isPiAiNs = (ns: unknown) => ns === PI_AI_NS || ns === 'pi-ai';

export type ProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: string[];
}

/** A route id dsh-Go accepts (settings key and credential stem). */
export const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Lower-case ASCII letters and digits of [text], runs joined by `-`: `My GW (测试) 2` → `my-gw-2`; all-Chinese → ``. */
export function providerSlug(text: string, max = 24): string {
  let slug = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-');
  if (slug.length > max) slug = slug.slice(0, max).replace(/-+$/, '');
  // a route starts with a letter
  return slug.replace(/^[0-9-]+/, '');
}

/** `custom-<slug>`: from the name, else the host (`api.xinyuntoken.com` → `xinyuntoken`), else random; never one in [taken]. */
export function newProviderId(name: string, baseUrl: string, taken: Set<string>, random = Math.random): string {
  let slug = providerSlug(name);
  if (!slug) {
    let host = '';
    try {
      host = new URL(baseUrl.trim()).hostname;
    } catch {
      /* no host */
    }
    const labels = host.split('.').filter(Boolean);
    if (labels.length > 1 && !/^\d+$/.test(labels[labels.length - 1])) labels.pop();
    if (labels.length > 1 && (labels[0] === 'api' || labels[0] === 'www')) labels.shift();
    slug = providerSlug(labels.join('-'));
  }
  if (!slug) {
    const letters = 'abcdefghijkmnpqrstuvwxyz23456789';
    slug = Array.from({ length: 4 }, () => letters[Math.floor(random() * letters.length)]).join('');
  }
  const base = `custom-${slug}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The credential reference for a route: `custom-my-gw` → `CUSTOM_MY_GW_API_KEY`. */
export const deriveKeyRef = (route: string) => `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

/** A pasted endpoint without its request path: `…/v1/chat/completions` → `…/v1`; no trailing slash. */
export function normalizeBaseUrl(raw: string, api: ProviderApi): string {
  const url = raw.trim().replace(/\/+$/, '');
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return url;
  }
  const pattern = api === 'openai-completions' ? /\/chat\/completions$/i : api === 'openai-responses' ? /\/responses$/i : /\/(?:v1\/)?messages$/i;
  const m = pattern.exec(path);
  if (m && url.toLowerCase().endsWith(m[0].toLowerCase())) return url.slice(0, url.length - m[0].length);
  if (api === 'anthropic-messages' && path.endsWith('/v1') && url.endsWith('/v1')) return url.slice(0, -3);
  return url;
}

/** What's wrong with an address, or null. */
export function baseUrlError(raw: string): string | null {
  const url = raw.trim();
  if (!url) return '先填接口地址';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '接口地址要以 https:// 或 http:// 开头';
  }
  if (/\s/.test(url) || !/^https?:$/.test(u.protocol) || !u.hostname) return '接口地址要以 https:// 或 http:// 开头';
  if (u.search || u.hash) return '接口地址后面不要带 ? 或 # 的部分';
  return null;
}

/** Whitespace a paste may have picked up; keys never contain any. */
export const normalizeKey = (raw: string) => raw.replace(/\s/g, '');

/** What's wrong with a key, or null (the official page's checks). */
export function keyError(key: string, required: boolean): string | null {
  if (!key) return required ? '先填密钥' : null;
  if (/^[A-Z][A-Z0-9_]*=[^=]/.test(key)) return '只填密钥本身，不要带「名字=」';
  const q = key[0];
  if ((q === '"' || q === "'" || q === '`') && key.length > 1 && key.endsWith(q)) return '密钥两边不要带引号';
  if (!/^[\x21-\x7E]+$/.test(key)) return '密钥里有不认识的字符';
  return null;
}

const asModel = (m: Record<string, unknown>): DiscoveredModel | null => {
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  if (!id) return null;
  return {
    id,
    ...(typeof m.name === 'string' && m.name !== id ? { name: m.name } : {}),
    ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
    ...(typeof m.maxTokens === 'number' ? { maxTokens: m.maxTokens } : {}),
    ...(Array.isArray(m.inputModalities) ? { inputModalities: m.inputModalities.filter((x): x is string => typeof x === 'string') } : {}),
  };
};

/**
 * The models an endpoint lists (`llm/discoverModels`, nothing stored). A bare address that answers
 * 404 is tried again with `/v1` (what most OpenAI-style gateways want); [baseUrl] in the result is
 * the address that worked.
 */
export async function discoverModels(api: ProviderApi, raw: string, apiKey: string): Promise<{ models: DiscoveredModel[]; baseUrl: string }> {
  const baseUrl = normalizeBaseUrl(raw, api);
  const ask = async (url: string) =>
    (await getClient().discoverModels({ baseURL: url, api, ...(apiKey ? { apiKey } : {}) }, PI_AI_NS)).map(asModel).filter((m): m is DiscoveredModel => !!m);
  try {
    return { models: await ask(baseUrl), baseUrl };
  } catch (e) {
    let bare = false;
    try {
      const p = new URL(baseUrl).pathname;
      bare = p === '' || p === '/';
    } catch {
      /* not a URL */
    }
    if (api === 'anthropic-messages' || !bare || !/answered 404/.test(String((e as Error)?.message ?? e))) throw e;
    const withV1 = `${baseUrl}/v1`;
    try {
      return { models: await ask(withV1), baseUrl: withV1 };
    } catch {
      throw e;
    }
  }
}

/** The profile's `models` entry for a picked model. */
export const modelSpec = (m: DiscoveredModel) => ({
  id: m.id,
  ...(m.name ? { name: m.name } : {}),
  ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
  ...(m.inputModalities?.length ? { input: m.inputModalities } : {}),
});

/** The pi-ai section's revision and the routes already there. */
async function readSection(): Promise<{ revision: number; routes: Set<string> }> {
  const d = await getClient().describeSettings();
  const n = (Array.isArray(d.namespaces) ? d.namespaces : []).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})).find((x) => isPiAiNs(x.ns));
  const value = (n?.value && typeof n.value === 'object' ? n.value : {}) as Record<string, unknown>;
  const providers = value.providers && typeof value.providers === 'object' ? Object.keys(value.providers) : [];
  return { revision: Number(n?.revision ?? 0), routes: new Set(providers) };
}

/**
 * Creates a route: the profile first, then its key (as dsh-Go's page does). Returns the route id.
 * When only the key fails, the error says so: the route is there, its key isn't.
 */
export async function createProvider(d: { name: string; api: ProviderApi; baseUrl: string; apiKey: string; models: DiscoveredModel[] }): Promise<string> {
  const { revision, routes } = await readSection();
  const id = newProviderId(d.name, d.baseUrl, routes);
  const ref = deriveKeyRef(id);
  const profile = {
    ...(d.name.trim() ? { displayName: d.name.trim() } : {}),
    api: d.api,
    baseURL: normalizeBaseUrl(d.baseUrl, d.api),
    ...(d.apiKey ? { apiKeyEnv: ref } : {}),
    models: d.models.map(modelSpec),
  };
  await getClient().mutateSettings(PI_AI_NS, [{ op: 'set', path: ['providers', id], value: profile }], revision);
  if (d.apiKey) {
    try {
      await getClient().setProviderKey(d.apiKey, ref);
    } catch (e) {
      throw new Error(`提供方已添加，但密钥没存上：${(e as Error)?.message ?? e}。到它的详情页重新填一次密钥。`);
    }
  }
  return id;
}

export async function removeProvider(route: string) {
  const { revision } = await readSection();
  await getClient().mutateSettings(PI_AI_NS, [{ op: 'unset', path: ['providers', route] }], revision);
}
