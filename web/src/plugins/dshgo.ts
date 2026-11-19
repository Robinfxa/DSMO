// dsh-Go native plugins, rendered by this frontend: the same `dshGo` manifests
// and `/dsh-go/v1/*` bridge routes the dsh-Go app uses, so plugins from the
// dsh-Go market keep working here (decision: our market stays compatible with
// the dsh-Go backend). Protocol: dsh-Go docs/design/native-plugins-protocol.md.
//
//   GET  /dsh-go/v1/contributions   every enabled plugin's contributions
//   GET  /dsh-go/v1/views/<pkg>/<id> one panel's view + data
//   POST /dsh-go/v1/invoke           a tap → the plugin's effects (whitelisted here)

import { computed, signal } from '@preact/signals';
import { native } from '../bridge/native';
import { obj, list, str, isObj } from '../engine/json';
import { copyText, currentId, draft, getClient, openOverlay, prefs, showToast, confirm } from '../state/store';
import { openFeature } from '../ui/pages/registry';

export const PROTOCOL = 1;
export const APP_VERSION = '0.1.0';
export const SURFACES = ['composer.actions', 'message.actions', 'composer.strip', 'panels'];
export const COMPONENTS = ['stack', 'row', 'text', 'callout', 'steps', 'compare', 'metric', 'chart', 'progress', 'list', 'keyValue', 'table', 'actions', 'image', 'options', 'confirm', 'emptyState', 'gallery'];

export interface DshGoTransport {
  get(path: string, query?: Record<string, string>): Promise<{ status: number; json: unknown }>;
  post(path: string, body: unknown): Promise<{ status: number; json: unknown }>;
}

export const httpTransport: DshGoTransport = {
  async get(path, query) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const r = await fetch(path + qs, { credentials: 'same-origin' });
    return { status: r.status, json: await r.json().catch(() => null) };
  },
  async post(path, body) {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  },
};

let transport: DshGoTransport = httpTransport;
export const setDshGoTransport = (t: DshGoTransport) => (transport = t);
/** The current `/dsh-go/v1/*` transport (the mock bridge in the prototype). */
export const dshGoTransport = () => transport;

type Effect = Record<string, unknown>;
interface Action {
  id: string;
  label: string;
  icon?: string;
  effects: Effect[];
}
interface Plugin {
  pkg: string;
  title: string;
  wants: string[];
  composerActions: Action[];
  messageActions: Action[];
  strips: { id: string; text?: string; panel?: string }[];
  panels: { id: string; title: string; placement: string[] }[];
}

const pick = (v: unknown, lang: string): string => {
  if (typeof v === 'string') return v;
  const m = obj(v);
  return str(m[lang]) ?? str(m.en) ?? str(m.zh) ?? (Object.values(m).find((x) => typeof x === 'string') as string | undefined) ?? '';
};
const effectsOf = (v: unknown): Effect[] => (Array.isArray(v) ? v.filter(isObj) : isObj(v) ? [v] : []).slice(0, 4) as Effect[];

export const contributions = signal<Plugin[]>([]);
let rev: string | undefined;

export async function loadContributions() {
  try {
    const query = { v: String(PROTOCOL), app: APP_VERSION, locale: prefs.value.lang, surfaces: SURFACES.join(','), components: COMPONENTS.join(',') };
    const r = await transport.get('/dsh-go/v1/contributions', query);
    if (r.status !== 200) return; // no bridge on this host (relay, plain dsh web): nothing to show
    const body = obj(r.json);
    if (str(body.rev) === rev) return;
    rev = str(body.rev);
    const lang = prefs.value.lang;
    contributions.value = list(body.plugins)
      .map(obj)
      .filter((p) => str(p.pkg) && (str(p.state) ?? 'ok') === 'ok')
      .map((p) => {
        const c = obj(p.contributes);
        const actions = (k: string): Action[] =>
          list(c[k])
            .map(obj)
            .filter((a) => str(a.id) && a.ready !== false)
            .slice(0, 2)
            .map((a) => ({ id: str(a.id)!, label: pick(a.label, lang).slice(0, 12), icon: str(a.icon), effects: effectsOf(a.effect) }));
        return {
          pkg: str(p.pkg)!,
          title: pick(p.title, lang) || str(p.pkg)!,
          wants: list(p.wants).filter((x): x is string => typeof x === 'string'),
          composerActions: actions('composer.actions'),
          messageActions: actions('message.actions'),
          strips: list(c['composer.strip'])
            .map(obj)
            .filter((s) => str(s.id) && s.ready !== false)
            .slice(0, 1)
            .map((s) => ({ id: str(s.id)!, text: pick(s.text, lang).slice(0, 24) || undefined, panel: str(s.panel) })),
          panels: list(c.panels)
            .map(obj)
            .filter((s) => str(s.id) && s.ready !== false)
            .slice(0, 4)
            .map((s) => ({ id: str(s.id)!, title: pick(s.title, lang).slice(0, 16) || str(s.id)!, placement: list(s.placement).filter((x): x is string => typeof x === 'string') })),
        };
      });
  } catch {
    /* bridge unreachable: native-plugin UI simply doesn't appear */
  }
}

// ------------------------------------------------------------------ derived UI items

export const composerPills = computed(() =>
  contributions.value.flatMap((p) => p.composerActions.map((a) => ({ key: `${p.pkg}#${a.id}`, label: a.label, run: () => tap(p, a, 'composer.actions') }))),
);
export const pluginMessageActions = computed(() =>
  prefs.value.advanced ? contributions.value.flatMap((p) => p.messageActions.map((a) => ({ key: `${p.pkg}#${a.id}`, label: a.label, run: (message: string) => tap(p, a, 'message.actions', message) }))) : [],
);
export const composerStrip = computed(() => {
  for (const p of contributions.value)
    for (const s of p.strips)
      if (s.text) return { key: `${p.pkg}#${s.id}`, text: s.text, run: () => (s.panel ? openPanel(p.pkg, s.panel) : void invoke(p, s.id, 'composer.strip')) };
  return null;
});
export const dshGoPanels = computed(() =>
  contributions.value.flatMap((p) => p.panels.map((x) => ({ key: `${p.pkg}#${x.id}`, title: x.title, pluginTitle: p.title, open: () => openPanel(p.pkg, x.id) }))),
);

export function openPanel(pkg: string, id: string) {
  openOverlay({ kind: 'dshgo', pkg, id });
}

// ------------------------------------------------------------------ taps & effects

const asked = new Set<string>();
async function tap(p: Plugin, a: Action, surface: string, message?: string) {
  if (a.effects.length) return runEffects(p.pkg, a.effects.filter((e) => ['insert', 'command', 'open', 'link', 'toast', 'copy'].includes(String(e.type))), Date.now());
  // `wants`: ask once per plugin before sending draft / clipboard / message to it.
  const wants = p.wants.filter((w) => (w === 'message' ? surface === 'message.actions' : surface === 'composer.actions' && (w === 'draft' || w === 'clipboard')));
  if (wants.length && !asked.has(p.pkg)) {
    const names = wants.map((w) => ({ draft: '输入框文字', clipboard: '剪贴板', message: '这条回复' })[w] ?? w).join('、');
    return confirm(`让「${p.title}」读取${names}？`, '点按时会把这些内容交给插件处理。只问这一次。', '允许', () => {
      asked.add(p.pkg);
      void tap(p, a, surface, message);
    }, false);
  }
  const context: Record<string, string> = {};
  if (wants.includes('draft')) context.draft = draft.value;
  if (wants.includes('clipboard')) context.clipboard = await navigator.clipboard?.readText().catch(() => '') ?? '';
  if (wants.includes('message') && message) context.message = message;
  return invoke(p, a.id, surface, undefined, undefined, context);
}

export async function invoke(p: Pick<Plugin, 'pkg'>, id: string, surface: string, action?: string, value?: unknown, context?: Record<string, string>, onPanel?: (e: Effect) => void) {
  const t0 = Date.now();
  try {
    const r = await transport.post('/dsh-go/v1/invoke', {
      v: PROTOCOL,
      pkg: p.pkg,
      id,
      surface,
      action,
      value,
      scope: currentId.value ? { sessionId: currentId.value } : {},
      context: context && Object.keys(context).length ? context : undefined,
      locale: prefs.value.lang,
      userGesture: true,
    });
    if (r.status !== 200) throw new Error(str(obj(r.json).message) ?? `插件没有响应（${r.status}）`);
    await runEffects(p.pkg, effectsOf(obj(r.json).effects), t0, onPanel);
  } catch (e) {
    showToast((e as Error).message || '插件出错了');
  }
}

/** The effect whitelist; effects arriving more than 3 s after the tap are dropped. */
export async function runEffects(pkg: string, effects: Effect[], tapAt: number, onPanel?: (e: Effect) => void) {
  if (Date.now() - tapAt > 3000) return;
  for (const e of effects.slice(0, 4)) {
    switch (e.type) {
      case 'insert': {
        const text = String(e.text ?? '').slice(0, 2000);
        if (text) draft.value = draft.value ? `${draft.value}\n${text}` : text;
        document.getElementById('input')?.focus();
        break;
      }
      case 'command': {
        const sid = currentId.value;
        if (!sid) break;
        const line = `/${String(e.name ?? '')}${e.args ? ' ' + String(e.args).slice(0, 500) : ''}`;
        if (/^\/permission\b/.test(line)) break; // plugins can never change permissions
        await getClient().executeCommand(sid, line).catch((err) => showToast(err.message));
        break;
      }
      case 'open': {
        const page = String(e.page ?? '');
        if (page.startsWith('panel:')) openPanel(pkg, page.slice(6));
        else if (!/permission|login|settings/.test(page)) openFeature(page);
        break;
      }
      case 'link': {
        const url = String(e.url ?? '');
        if (!/^https:\/\//.test(url) || url.length > 2048) break;
        const host = new URL(url).host;
        confirm('打开链接？', host, '打开', () => void native.openExternal(url), false);
        break;
      }
      case 'toast':
        showToast(String(e.text ?? '').slice(0, 40));
        break;
      case 'copy':
        await copyText(String(e.text ?? '').slice(0, 8000));
        break;
      case 'refresh':
      case 'patch':
        onPanel?.(e);
        break;
    }
  }
}

export async function readView(pkg: string, id: string) {
  const path = `/dsh-go/v1/views/${pkg.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(id)}`;
  const r = await transport.get(path, { v: String(PROTOCOL), app: APP_VERSION, locale: prefs.value.lang, components: COMPONENTS.join(','), ...(currentId.value ? { sessionId: currentId.value } : {}) });
  if (r.status !== 200) throw new Error(str(obj(r.json).message) ?? `读不到面板（${r.status}）`);
  const m = obj(r.json);
  return { title: str(m.title), view: m.view, data: m.data ?? {} };
}
