// 模型提供方: adding a hand-declared route to dsh-Go's pi-ai adapter, the way dsh-Go's own provider
// form does it (dsh-go app/lib/state/providers_state.dart, packages/dsh_client providers_api.dart):
// the settings namespace is `llm-pi-ai`; a route id is `custom-<slug>`; the profile names its key by
// a credential reference (`apiKeyEnv`) and the key itself goes to `credentials/set`; models are
// `{ id, name?, contextWindow?, maxTokens?, input? }` objects, at least one.

import { archived, catalog, credential, currentSelection, getClient, pickModel, quietSessions, refreshCatalog } from '../state/store';
import { accountView } from '../account/account';
import { parseLogEvent } from './events';

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
  void refreshCatalog();
  return id;
}

export async function removeProvider(route: string) {
  const { revision } = await readSection();
  await getClient().mutateSettings(PI_AI_NS, [{ op: 'unset', path: ['providers', route] }], revision);
  void refreshCatalog();
}

// ------------------------------------------------------------------ 账号管理 › 模型提供方

export interface ProviderStatus {
  id: string;
  name: string;
  /** A route added under 模型提供方 (it has a detail page). */
  own: boolean;
  ok: boolean;
  /** 「账号已登录」「密钥已设置 · 3 个模型」「没有密钥」, or the Host's complaint. */
  status: string;
}

/** The provider and model in use now: this conversation's, or new chats' default. */
export function inUse(): { provider: string; name: string; model: string; modelId: string } | null {
  const sel = currentSelection();
  if (!sel) return null;
  const g = catalog.value?.groups.find((x) => x.id === sel.provider);
  const m = g?.models.find((x) => x.id === sel.model);
  return { provider: sel.provider, name: g?.name ?? sel.provider, model: m?.name ?? sel.model, modelId: sel.model };
}

const DEEPSEEK = 'deepseek-official';

/** dsh-Go's 新对话默认模型 (dsh-go app/lib/state/model_defaults_state.dart). */
const DEFAULT_MODEL_NS = 'agent-default-model';

/** The models a provider serves (from the model catalog). */
export const modelsOf = (provider: string) => catalog.value?.groups.find((g) => g.id === provider)?.models ?? [];

/**
 * 账号管理's switch: [provider] / [model] for this conversation (or the next new one) and as new
 * chats' default on the engine, at the model's own default thinking level.
 */
export async function switchTo(provider: string, model: string) {
  const m = modelsOf(provider).find((x) => x.id === model);
  const effort = m?.defaultEffort;
  const c = getClient();
  const d = await c.describeSettings().catch(() => null);
  const ns = (Array.isArray(d?.namespaces) ? d!.namespaces : []).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})).find((x) => x.ns === DEFAULT_MODEL_NS);
  // an engine that doesn't keep a default (older ones): this conversation / the next one only
  if (ns)
    await c.mutateSettings(
      DEFAULT_MODEL_NS,
      [
        { op: 'set', path: ['provider'], value: provider },
        { op: 'set', path: ['model'], value: model },
        effort ? { op: 'set', path: ['reasoningEffort'], value: effort } : { op: 'unset', path: ['reasoningEffort'] },
      ],
      Number(ns.revision ?? 0),
    );
  await pickModel(provider, model, effort);
  await refreshCatalog();
}

/** DeepSeek, the routes added here, and any other provider the catalog can route to, with how each stands. */
export async function readProviderStatus(): Promise<ProviderStatus[]> {
  const c = getClient();
  const [entries, d] = await Promise.all([c.listConfigurableProviders(), c.describeSettings().catch(() => ({ namespaces: [] as unknown[] }))]);
  const ns = (Array.isArray(d.namespaces) ? d.namespaces : []).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})).find((x) => isPiAiNs(x.ns));
  const routes = ((ns?.value as Record<string, unknown> | undefined)?.providers ?? {}) as Record<string, Record<string, unknown>>;
  const refs = Object.values(routes).map((r) => r?.apiKeyEnv).filter((x): x is string => typeof x === 'string');
  const creds = refs.length ? await c.describeCredentials(refs).catch(() => ({}) as Record<string, { configured: boolean }>) : {};
  const groups = catalog.value?.groups ?? [];
  const count = (id: string) => groups.find((g) => g.id === id)?.models.length ?? 0;
  const out: ProviderStatus[] = [];
  for (const e of entries) {
    const id = String(e.provider ?? '');
    if (!id) continue;
    const name = (typeof e.displayName === 'string' && e.displayName) || id;
    const err = typeof e.error === 'string' && e.error ? e.error : null;
    const own = isPiAiNs(e.settingsNs) && Array.isArray(e.settingsPath) && e.settingsPath.length > 0;
    if (id === DEEPSEEK) {
      const signed = !!accountView.value?.signedIn;
      const key = !!credential.value?.configured;
      out.unshift({ id, name, own: false, ok: signed || key, status: err ?? (signed ? '账号已登录' : key ? 'API Key 已设置' : '未登录') });
    } else if (own) {
      const r = routes[id] ?? {};
      const ref = typeof r.apiKeyEnv === 'string' ? r.apiKeyEnv : '';
      const hasKey = !!ref && !!(creds as Record<string, { configured: boolean }>)[ref]?.configured;
      const n = count(id) || (Array.isArray(r.models) ? r.models.length : 0);
      out.push({ id, name, own: true, ok: !err && hasKey, status: err ?? (hasKey ? `密钥已设置 · ${n} 个模型` : '没有密钥') });
    } else if (groups.some((g) => g.id === id) || err) {
      out.push({ id, name, own: false, ok: !err, status: err ?? `可用 · ${count(id)} 个模型` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ 测试连接

export interface NetProbe {
  ok: boolean;
  ms: number;
  /** How many models the endpoint listed. */
  models?: number;
  error?: string;
}
export interface ReplyProbe {
  ok: boolean;
  ms: number;
  reply?: string;
  usage?: { input?: number; output?: number; total?: number };
  error?: string;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 网络连通: asks a configured route for its model list (`llm/discoverModels` with the stored key and
 * headers — what dsh-Go's own 「测试连接」 does). Free: no model is called. Proves the address,
 * the network and the key.
 */
export async function probeNetwork(provider: string): Promise<NetProbe> {
  const t0 = now();
  try {
    const list = await getClient().discoverModels({ provider }, PI_AI_NS);
    return { ok: true, ms: Math.round(now() - t0), models: list.length };
  } catch (e) {
    return { ok: false, ms: Math.round(now() - t0), error: String((e as Error)?.message ?? e) };
  }
}

/** The lightest effort a model offers (off / minimal / low …), so the test spends no thinking tokens. */
function lightestEffort(provider: string, model: string): string | undefined {
  const m = catalog.value?.groups.find((g) => g.id === provider)?.models.find((x) => x.id === model);
  const ids = m?.efforts.map((e) => e.id) ?? [];
  return ['off', 'none', 'minimal', 'low'].find((x) => ids.includes(x)) ?? ids[0];
}

/**
 * 真实小额测试: one real request through the engine to [provider] / [model] — a throwaway
 * conversation asked to answer 「OK」 at the lightest thinking level, then deleted. It is billed
 * like any message: the engine's system prompt rides along, so the input is a few thousand tokens.
 */
export async function probeReply(provider: string, model: string, timeoutMs = 90_000): Promise<ReplyProbe> {
  const c = getClient();
  const t0 = now();
  let sid = '';
  try {
    sid = (await c.createSession()).sessionId;
    // out of the sidebar at once (as if deleted), and no 「回复好了」
    quietSessions.add(sid);
    archived.value = new Set([...archived.value, sid]);
    await c.selectModel(sid, provider, model, lightestEffort(provider, model));
    await c.prompt(sid, [{ type: 'text', text: '这是一次连通性测试。只回复两个字母 OK，不要调用任何工具，也不要说别的。' }]);
    while (now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 600));
      const events = (await c.latestRecords(sid, 60)).map(parseLogEvent);
      const end = events.find((e) => e.kind === 'turn-end');
      if (!end || end.kind !== 'turn-end') continue;
      const ms = Math.round(now() - t0);
      const said = events.filter((e) => e.kind === 'assistant');
      const reply = said
        .flatMap((e) => (e.kind === 'assistant' ? e.message.parts : []))
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .trim();
      const sum = (k: 'inputTokens' | 'outputTokens' | 'totalTokens') => said.reduce((a, e) => a + ((e.kind === 'assistant' && e.usage?.[k]) || 0), 0) || undefined;
      const usage = { input: sum('inputTokens'), output: sum('outputTokens'), total: sum('totalTokens') };
      if (end.reason.kind !== 'completed') return { ok: false, ms, reply: reply || undefined, usage, error: end.reason.message ?? `没有正常结束（${end.reason.kind}）` };
      if (!reply) return { ok: false, ms, usage, error: '接口有回应，但没有回复文字' };
      return { ok: true, ms, reply: reply.slice(0, 80), usage };
    }
    void c.cancel(sid).catch(() => {});
    return { ok: false, ms: Math.round(now() - t0), error: `${Math.round(timeoutMs / 1000)} 秒内没有回复` };
  } catch (e) {
    return { ok: false, ms: Math.round(now() - t0), error: String((e as Error)?.message ?? e) };
  } finally {
    if (sid) void c.archiveSession(sid).catch(() => {});
  }
}
