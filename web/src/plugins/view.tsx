// Renderer for dsh-Go plugin JSON views (v1 components plus the common v2
// ones). Plugins never run code here: a view is data, taps become invokes.
// Spec: dsh-Go docs/plugins/components.md. Unknown or broken nodes degrade to
// a grey placeholder, like the native renderer.

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

type Node = Record<string, any>;
export type Tap = (action: string, value: unknown) => Promise<void> | void;

const MAX_NODES = 120;
const MAX_DEPTH = 8;

function bind(v: any, data: any): any {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$ === 'string') {
    let cur = { data };
    for (const part of v.$.replace(/\[(\d+)\]/g, '.$1').split('.')) {
      if (cur == null) return undefined;
      cur = (cur as any)[part];
    }
    return cur;
  }
  return v;
}
const txt = (v: any, data: any) => {
  const b = bind(v, data);
  if (b === undefined || b === null) return '—';
  if (typeof b === 'number') return Math.abs(b) >= 10000 ? b.toLocaleString() : String(b);
  return typeof b === 'string' ? b.slice(0, 2000) : String(b);
};
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p))}
    </>
  );
}
const TONE: Record<string, string> = { success: 'good', warning: 'warn', danger: 'bad', error: 'bad', note: 'info', secondary: 'muted' };
const tone = (t?: string) => (t ? TONE[t] ?? t : '');
const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
const actionOf = (a: any): { id: string; args?: unknown } | null => (typeof a === 'string' ? { id: a } : a && typeof a.id === 'string' ? a : null);

export function PluginView({ view, data, onTap, interactive = true }: { view: unknown; data: unknown; onTap: Tap; interactive?: boolean }) {
  let count = 0;
  const bad = !view || typeof view !== 'object' || JSON.stringify(view).length > 32 * 1024;
  if (bad) return <div class="pv-broken">插件界面有误</div>;
  const render = (n: Node, depth: number): JSX.Element => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) return <div class="pv-trunc">内容过多，已截断</div>;
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return <Placeholder />;
    const kids = (arr: any) => (Array.isArray(arr) ? arr.slice(0, 32).map((c, i) => <div key={i}>{render(c, depth + 1)}</div>) : null);
    switch (n.type) {
      case 'stack':
        return <div class="pv-stack">{kids(n.children)}</div>;
      case 'row':
      case 'grid':
        return <div class="pv-row">{kids(n.children)}</div>;
      case 'text':
        return (
          <p class={`pv-text ${n.tone === 'muted' ? 'muted' : ''}`}>
            <Rich text={txt(n.text, data)} />
          </p>
        );
      case 'callout':
        return (
          <div class={`pv-callout ${tone(n.tone)}`}>
            <Rich text={txt(n.text, data)} />
          </div>
        );
      case 'steps': {
        const items = bind(n.items, data);
        if (!Array.isArray(items) || !items.length) return <Empty />;
        return (
          <ol class="pv-steps">
            {items.slice(0, 12).map((s: any, i: number) => {
              const it = typeof s === 'string' ? { label: s, status: 'todo' } : s;
              return (
                <li class={it.status} key={i}>
                  <span class="pv-dot" />
                  <span>
                    {txt(it.label, data)}
                    {it.detail && <small>{txt(it.detail, data)}</small>}
                  </span>
                </li>
              );
            })}
          </ol>
        );
      }
      case 'compare':
        return (
          <div class="pv-row">
            {arr(bind(n.items, data)).slice(0, 4).map((c: any, i: number) => (
              <div class="pv-card" key={i}>
                <div class="pv-card-t">
                  {txt(c.title, data)}
                  {c.badge && <span class="badge">{txt(c.badge, data)}</span>}
                </div>
                {(Array.isArray(c.rows) ? c.rows : Object.entries(c.rows ?? {})).slice(0, 8).map((r: any, j: number) => (
                  <div class="pv-kv" key={j}>
                    <span>{txt(r[0], data)}</span>
                    <span>{txt(r[1], data)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      case 'metric':
        return (
          <div class={`pv-metric ${tone(n.tone)}`}>
            <span class="pv-metric-l">{txt(n.label, data)}</span>
            <span class="pv-metric-v">{txt(n.value, data)}</span>
            {n.caption && <small>{txt(n.caption, data)}</small>}
          </div>
        );
      case 'progress': {
        const v = Number(bind(n.value, data)) || 0;
        const max = Number(bind(n.max, data)) || 100;
        const pct = Math.max(0, Math.min(100, (v / max) * 100));
        return (
          <div class={`pv-progress ${tone(n.tone)}`}>
            {n.label && <span class="pv-metric-l">{txt(n.label, data)}</span>}
            <div class="bar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <small>{n.caption ? txt(n.caption, data) : `${Math.round(pct)}%`}</small>
          </div>
        );
      }
      case 'chart': {
        const cats: any[] = arr(bind(n.categories, data));
        const series: any[] = arr(bind(n.series, data));
        const raw0 = bind(series[0]?.values, data);
        const vals: number[] = (Array.isArray(raw0) ? raw0 : []).map((x: any) => Number(x) || 0);
        const max = Math.max(1, ...vals);
        return (
          <div class="pv-chart">
            {cats.slice(0, 60).map((c, i) => (
              <div class="pv-bar" key={i} title={`${c}: ${vals[i] ?? '—'}${n.unit ?? ''}`}>
                <i style={{ height: `${((vals[i] ?? 0) / max) * 100}%` }} />
                <span>{String(c)}</span>
              </div>
            ))}
            {n.caption && <small>{txt(n.caption, data)}</small>}
          </div>
        );
      }
      case 'list': {
        const items = bind(n.items, data);
        if (!Array.isArray(items) || !items.length) return <Empty />;
        return (
          <div class="pv-list">
            {items.slice(0, 50).map((r: any, i: number) => {
              const act = actionOf(r.action);
              const inner = (
                <>
                  <span class="lrow-title">{txt(r.title, data)}</span>
                  {r.subtitle && <span class="lrow-sub">{txt(r.subtitle, data)}</span>}
                </>
              );
              return (
                <div class="lrow" key={i}>
                  {act && interactive ? (
                    <TapButton class="lrow-main" onTap={() => onTap(act.id, act.args ?? {})}>
                      {inner}
                    </TapButton>
                  ) : (
                    <div class="lrow-main">{inner}</div>
                  )}
                  {r.trailing !== undefined && <span class={`lrow-end ${tone(r.tone)}`}>{txt(r.trailing, data)}</span>}
                </div>
              );
            })}
          </div>
        );
      }
      case 'keyValue': {
        const raw = bind(n.items, data);
        const rows: any[][] = Array.isArray(raw) ? raw.map((x: any) => (Array.isArray(x) ? x : [x.label, x.value, x.tone])) : Object.entries(raw ?? {});
        if (!rows.length) return <Empty />;
        return (
          <div class="kv">
            {rows.slice(0, 24).map(([k, v, t], i) => (
              <div key={i}>
                <span class="k">{txt(k, data)}</span>
                <span class={`v ${tone(t)}`}>{txt(v, data)}</span>
              </div>
            ))}
          </div>
        );
      }
      case 'table': {
        const cols: any[] = arr(bind(n.columns, data)).slice(0, 8);
        const rows: any[][] = arr(bind(n.rows, data)).filter(Array.isArray).slice(0, 50);
        if (!rows.length) return <Empty />;
        return (
          <div class="md-table">
            <table class="sheet">
              <thead>
                <tr>
                  {cols.map((c, i) => (
                    <th key={i}>{typeof c === 'string' ? c : txt(c.label, data)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {r.slice(0, 8).map((c, j) => (
                      <td key={j}>{txt(c, data)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case 'actions':
        if (!interactive) return <></>;
        return (
          <div class="pv-actions">
            {arr(n.items).slice(0, 4).map((b: any, i: number) => {
              const act = actionOf(b.action);
              return (
                <TapButton key={i} class={`btn ${b.style === 'primary' ? 'primary' : ''}`} onTap={() => act && onTap(act.id, act.args ?? {})}>
                  {txt(b.label, data)}
                </TapButton>
              );
            })}
          </div>
        );
      case 'options': {
        const sel = bind(n.selected, data);
        const selected = new Set(Array.isArray(sel) ? sel : sel !== undefined ? [sel] : []);
        return (
          <div class="chips">
            {arr(n.options).slice(0, 8).map((o: any, i: number) => {
              const it = typeof o === 'string' ? { label: o, value: o } : o;
              const value = it.value ?? it.label;
              return (
                <TapButton
                  key={i}
                  class="toggle"
                  pressed={selected.has(value)}
                  disabled={!interactive}
                  onTap={() => onTap(n.id, n.multi ? { values: selected.has(value) ? [...selected].filter((x) => x !== value) : [...selected, value] } : { value })}
                >
                  {txt(it.label, data)}
                </TapButton>
              );
            })}
          </div>
        );
      }
      case 'confirm':
        if (!interactive) return <></>;
        return (
          <div class="pv-actions">
            <TapButton class="btn" onTap={() => onTap(n.id, { confirmed: false })}>
              {n.cancelLabel ?? '取消'}
            </TapButton>
            <TapButton class="btn primary" onTap={() => onTap(n.id, { confirmed: true })}>
              {n.confirmLabel ?? '确定'}
            </TapButton>
          </div>
        );
      case 'image': {
        const src = String(bind(n.src, data) ?? '');
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(src) || src.length > 90_000) return <div class="pv-img-bad">图片无法显示</div>;
        return (
          <figure class="pv-img">
            <img src={src} alt={n.alt ?? ''} style={n.aspect ? { aspectRatio: String(n.aspect) } : undefined} />
            {n.caption && <figcaption>{txt(n.caption, data)}</figcaption>}
          </figure>
        );
      }
      case 'emptyState': {
        const act = actionOf(n.action?.action);
        return (
          <div class="empty-state small">
            <div class="empty-t">{txt(n.title, data)}</div>
            {n.message && <div class="empty-d">{txt(n.message, data)}</div>}
            {act && interactive && (
              <TapButton class="btn" onTap={() => onTap(act.id, act.args ?? {})}>
                {txt(n.action.label, data)}
              </TapButton>
            )}
          </div>
        );
      }
      case 'gallery':
        return (
          <div class="pv-gallery">
            {arr(bind(n.items, data)).slice(0, 24).map((g: any, i: number) => {
              const src = String(bind(g.src, data) ?? '');
              return /^data:image\//.test(src) ? <img key={i} src={src} alt={g.alt ?? ''} /> : <div class="pv-img-bad" key={i} />;
            })}
          </div>
        );
      default:
        return <Placeholder />;
    }
  };
  return <div class="pv">{render(view as Node, 0)}</div>;
}

function Placeholder() {
  return <div class="pv-ph">这部分无法显示</div>;
}
function Empty() {
  return <div class="pv-empty">暂无数据</div>;
}

function TapButton({ class: cls, onTap, children, pressed, disabled }: { class: string; onTap: () => unknown; children: any; pressed?: boolean; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      class={cls}
      type="button"
      aria-pressed={pressed}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onTap();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {busy && <span class="spin sm" />}
    </button>
  );
}
