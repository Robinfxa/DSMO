// What of a settings namespace's user layer may leave the device in a profile
// share (dsh-Go app/lib/share_code/settings_sanitizer.dart). Credentials never
// do; credential references stay; absolute local paths are dropped.

import type { SchemaNode } from '../ui/pages/host/schema';
import { containsSecret } from './secrets';

const DENIED = /(account|credential|telemetry|analytics|anonymous|remote-access|remotes|webserver|gateway|otel|login|auth)/i;
const SECRET_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'passphrase', 'cookie', 'authorization', 'apikey']);
const KEY_QUALIFIERS = new Set(['api', 'private', 'secret', 'access', 'client', 'session', 'signing', 'license']);
export const ABSOLUTE_PATH = /^(\/|~\/|~$|[A-Za-z]:[\\/]|\\\\|file:)/;
const LONG_OPAQUE = /^[A-Za-z0-9+/_=.-]{40,}$/;
const SECRET_QUERY = /^(token|key|secret|sig|signature|password|access_token|auth|api_key|apikey)$/i;

export const isShareableNamespace = (ns: string) => !DENIED.test(ns);

/** `accessToken`, `client_secret`, `X-Api-Key` — not `maxTokens`, `apiKeyEnv`, `keyId`. */
export function isSecretFieldName(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length) return false;
  const last = words[words.length - 1];
  if (SECRET_WORDS.has(last)) return true;
  if (last === 'key') return words.length === 1 || KEY_QUALIFIERS.has(words[words.length - 2]);
  return false;
}

export function isUnshareableString(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (ABSOLUTE_PATH.test(v)) return true;
  if (containsSecret(v)) return true;
  if (/^bearer\s/i.test(v)) return true;
  if (LONG_OPAQUE.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !v.includes('.')) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(v)) {
    try {
      const u = new URL(v);
      if (u.username || u.password) return true;
      for (const k of u.searchParams.keys()) if (SECRET_QUERY.test(k)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** transform / lazy hold the node that counts. */
export function effective(n: SchemaNode | undefined): SchemaNode | undefined {
  let node = n;
  for (let i = 0; i < 8 && node && (node.type === 'transform' || node.type === 'lazy') && node.inner; i++) node = node.inner;
  return node;
}
export const isSecretNode = (n?: SchemaNode) => n?.meta.role === 'secret';
export const isCredentialRef = (n?: SchemaNode) => n?.meta.role === 'credential-ref';
export function field(n: SchemaNode | undefined, key: string): SchemaNode | undefined {
  const e = effective(n);
  return effective(e?.dict[key] ?? (e?.type === 'dict' ? e.inner : undefined));
}

export interface SettingsView {
  ns: string;
  title?: string;
  schema: SchemaNode;
  value: Record<string, unknown>;
  user?: Record<string, unknown>;
  revision: number;
  secrets: string[][];
  writable: boolean;
}

const DROP = Symbol('drop');

/** The cleaned user layer, and how many fields were left out; null when never shared. */
export function sanitizeNamespace(view: SettingsView): { values: Record<string, unknown>; dropped: number } | null {
  if (!isShareableNamespace(view.ns)) return null;
  const user = view.user;
  if (!user || !Object.keys(user).length) return { values: {}, dropped: 0 };
  const secretPaths = new Set(view.secrets.map((p) => p.join('\u0000')));
  let dropped = 0;
  const clean = (value: unknown, schema: SchemaNode | undefined, path: string[], key: string | null): unknown => {
    const node = effective(schema);
    if (isSecretNode(node)) return DROP;
    if (secretPaths.has(path.join('\u0000'))) return DROP;
    const ref = isCredentialRef(node);
    if (key !== null && !ref && isSecretFieldName(key)) return DROP;
    if (typeof value === 'string') return ref ? (ABSOLUTE_PATH.test(value.trim()) ? DROP : value) : isUnshareableString(value) ? DROP : value;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      value.forEach((item, i) => {
        const c = clean(item, node?.inner, [...path, String(i)], null);
        if (c === DROP) dropped++;
        else out.push(c);
      });
      return !out.length && value.length ? DROP : out;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      let removed = 0;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const c = clean(v, node?.dict[k] ?? (node?.type === 'dict' ? node.inner : undefined), [...path, k], k);
        if (c === DROP) {
          removed++;
          dropped++;
        } else out[k] = c;
      }
      return !Object.keys(out).length && removed ? DROP : out;
    }
    return value;
  };
  const values: Record<string, unknown> = {};
  const root = effective(view.schema);
  for (const [k, v] of Object.entries(user)) {
    const c = clean(v, root?.dict[k], [k], k);
    if (c === DROP) dropped++;
    else values[k] = c;
  }
  return { values, dropped };
}

export const NAMESPACE_LABELS: Record<string, string> = {
  'agent-default-model': '默认模型',
  'agent-preset-registry': '默认预设',
  'agent-loop': '智能体',
  subagent: '子代理',
  'subagent-model-selection-settings': '子代理模型',
  'llm-deepseek': 'DeepSeek 模型',
  'llm-deepseek-account': 'DeepSeek 账号模型',
  'llm-pi-ai': '自定义模型服务',
  web: '联网',
  'web-search-deepseek': '联网搜索',
  'web-deepseek-api': '联网搜索接口',
  'bash-sandbox': '命令执行',
  permission: '权限',
  'session-log-deepseek': '对话日志',
  'cot-translation': '思考翻译',
  translator: '翻译',
  locale: '语言',
  'ui-theme': '网页版外观',
  'ui-chat': '网页版对话',
  'ui-conversation': '网页版输入',
  'ui-settings': '网页版设置',
  'ui-settings-general': '网页版通用',
  'auto-review': '自动审查',
  'agent-team': '智能体团队',
  'speech-to-text': '语音输入',
};
export const nsLabel = (ns: string, title?: string) => NAMESPACE_LABELS[ns] ?? title ?? ns;
