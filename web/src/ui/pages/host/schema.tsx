// A form from a schemastery schema, as `settings/describe` serves it (the
// `{uid, refs}` envelope or inline nodes). Covers what DSH's settings use:
// object, string (secret / textarea / url roles), number (slider when bounded),
// boolean, enum-like unions, arrays of strings and numbers, and dicts. Anything
// else is shown read-only, the way dsh-Go's generated pages fall back.
// Each change is written right away as one `settings/mutate` op.

import { useState } from 'preact/hooks';
import { Switch } from '../../common';
import { MIc } from '../../mobile/MIc';

export interface SchemaNode {
  type: string;
  meta: Record<string, unknown>;
  value?: unknown;
  dict: Record<string, SchemaNode>;
  list: SchemaNode[];
  inner?: SchemaNode;
}

const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function parseSchema(json: unknown): SchemaNode {
  const m = o(json);
  const refs = o(m.refs);
  if (Object.keys(refs).length) {
    const nodes: Record<string, SchemaNode> = {};
    for (const [k, raw] of Object.entries(refs)) nodes[k] = { type: String(o(raw).type ?? 'unknown'), meta: o(o(raw).meta), value: o(raw).value, dict: {}, list: [] };
    for (const [k, raw] of Object.entries(refs)) {
      const r = o(raw);
      const n = nodes[k];
      for (const [name, uid] of Object.entries(o(r.dict))) n.dict[name] = nodes[String(uid)] ?? unknown();
      for (const uid of Array.isArray(r.list) ? r.list : []) n.list.push(nodes[String(uid)] ?? unknown());
      if (r.inner != null) n.inner = nodes[String(r.inner)];
    }
    return nodes[String(m.uid)] ?? unknown();
  }
  const inline = (raw: unknown): SchemaNode => {
    const r = o(raw);
    return {
      type: String(r.type ?? 'unknown'),
      meta: o(r.meta),
      value: r.value,
      dict: Object.fromEntries(Object.entries(o(r.dict)).map(([k, v]) => [k, inline(v)])),
      list: (Array.isArray(r.list) ? r.list : []).map(inline),
      inner: r.inner ? inline(r.inner) : undefined,
    };
  };
  return inline(json);
}
const unknown = (): SchemaNode => ({ type: 'unknown', meta: {}, dict: {}, list: [] });

/** transform / lazy / intersect-of-one wrap what they hold. */
function resolve(n: SchemaNode): SchemaNode {
  if ((n.type === 'transform' || n.type === 'lazy') && n.inner) return { ...resolve(n.inner), meta: { ...resolve(n.inner).meta, ...n.meta } };
  return n;
}

export function text(v: unknown): string {
  if (typeof v === 'string') return v;
  const m = o(v);
  return String(m['zh-CN'] ?? m.zh ?? m.en ?? m[''] ?? Object.values(m).find((x) => typeof x === 'string') ?? '');
}

function enumOf(n: SchemaNode): { value: unknown; label: string }[] | null {
  if (n.type !== 'union') return null;
  const members = n.list.filter((x) => !(x.type === 'const' && x.value === null));
  if (!members.length || members.some((x) => x.type !== 'const')) return null;
  return members.map((x) => ({ value: x.value, label: text(x.meta.description) || String(x.value) }));
}

export interface FieldProps {
  name: string;
  node: SchemaNode;
  value: unknown;
  path: string[];
  disabled?: boolean;
  onSet: (path: string[], value: unknown) => void;
  onUnset: (path: string[]) => void;
}

export function SchemaFields({ node, value, path, disabled, onSet, onUnset }: Omit<FieldProps, 'name'>) {
  const n = resolve(node);
  const props = n.type === 'intersect' ? Object.assign({}, ...n.list.map((x) => resolve(x).dict)) : n.dict;
  const v = o(value);
  return (
    <div class="plg-group sf">
      {Object.entries(props as Record<string, SchemaNode>)
        .filter(([, c]) => !resolve(c).meta.hidden)
        .map(([k, c]) => (
          <Field key={k} name={k} node={c} value={v[k]} path={[...path, k]} disabled={disabled} onSet={onSet} onUnset={onUnset} />
        ))}
    </div>
  );
}

function Label({ name, n }: { name: string; n: SchemaNode }) {
  const title = text(n.meta.title);
  const desc = text(n.meta.description);
  return (
    <div class="plg-row-m">
      <div class="plg-row-t">{title || desc || name}</div>
      {(title ? desc : '') && <div class="plg-row-s wrap">{desc}</div>}
      {!title && desc && <div class="plg-row-s mono">{name}</div>}
    </div>
  );
}

function Field(p: FieldProps) {
  const n = resolve(p.node);
  const dis = p.disabled || n.meta.disabled === true;
  const def = n.meta.default;
  const cur = p.value === undefined ? def : p.value;
  const choices = enumOf(n);
  const [open, setOpen] = useState(n.meta.collapse !== true);

  if (choices)
    return (
      <div class="plg-row static">
        <Label name={p.name} n={n} />
        <select class="sf-select" disabled={dis} value={String(cur ?? '')} onChange={(e) => p.onSet(p.path, choices.find((c) => String(c.value) === (e.target as HTMLSelectElement).value)?.value)}>
          {choices.map((c) => (
            <option key={String(c.value)} value={String(c.value)}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
    );

  switch (n.type) {
    case 'boolean':
      return (
        <div class="plg-row static">
          <Label name={p.name} n={n} />
          <Switch on={cur === true} label={p.name} disabled={dis} onChange={(v) => p.onSet(p.path, v)} />
        </div>
      );
    case 'number': {
      const min = typeof n.meta.min === 'number' ? n.meta.min : undefined;
      const max = typeof n.meta.max === 'number' ? n.meta.max : undefined;
      const step = typeof n.meta.step === 'number' ? n.meta.step : undefined;
      const slider = n.meta.role === 'slider' && min !== undefined && max !== undefined;
      return (
        <div class="plg-row static">
          <Label name={p.name} n={n} />
          {slider && <input class="sf-range" type="range" min={min} max={max} step={step ?? 1} value={Number(cur ?? min)} disabled={dis} onChange={(e) => p.onSet(p.path, Number((e.target as HTMLInputElement).value))} />}
          <input
            class="sf-num"
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            disabled={dis}
            value={cur === undefined || cur === null ? '' : String(cur)}
            onChange={(e) => {
              const raw = (e.target as HTMLInputElement).value;
              raw === '' ? p.onUnset(p.path) : p.onSet(p.path, Number(raw));
            }}
          />
        </div>
      );
    }
    case 'string': {
      const secret = n.meta.role === 'secret';
      const area = n.meta.role === 'textarea';
      return (
        <div class={`plg-row static ${area ? 'col' : ''}`}>
          <Label name={p.name} n={n} />
          <TextInput secret={secret} area={area} disabled={dis} value={typeof cur === 'string' ? cur : ''} placeholder={secret ? (p.value ? '已设置，输入新值替换' : '未设置') : typeof def === 'string' ? def : ''} onCommit={(v) => (v === '' ? p.onUnset(p.path) : p.onSet(p.path, v))} />
        </div>
      );
    }
    case 'array': {
      const inner = n.inner ? resolve(n.inner) : unknown();
      if (inner.type !== 'string' && inner.type !== 'number') return <ReadOnly {...p} n={n} />;
      const items = Array.isArray(cur) ? (cur as unknown[]) : [];
      return (
        <div class="plg-row static col">
          <Label name={p.name} n={n} />
          <TextInput
            area
            disabled={dis}
            value={items.join('\n')}
            placeholder="每行一项"
            onCommit={(v) => {
              const lines = v.split('\n').map((x) => x.trim()).filter(Boolean);
              p.onSet(p.path, inner.type === 'number' ? lines.map(Number).filter((x) => !Number.isNaN(x)) : lines);
            }}
          />
        </div>
      );
    }
    case 'dict': {
      const inner = n.inner ? resolve(n.inner) : unknown();
      const entries = Object.entries(o(cur));
      if (inner.type === 'string')
        return (
          <div class="plg-row static col">
            <Label name={p.name} n={n} />
            <TextInput
              area
              disabled={dis}
              value={entries.map(([k, v]) => `${k}=${v}`).join('\n')}
              placeholder="每行一项：名字=值"
              onCommit={(v) => p.onSet(p.path, Object.fromEntries(v.split('\n').map((l) => l.split('=')).filter((x) => x[0]?.trim()).map(([k, ...r]) => [k.trim(), r.join('=').trim()])))}
            />
          </div>
        );
      if (inner.type === 'object')
        return (
          <div class="sf-nest">
            <button class="plg-link" type="button" onClick={() => setOpen(!open)}>
              <span>
                {text(n.meta.title) || text(n.meta.description) || p.name}
                <span class="sf-count">{entries.length}</span>
              </span>
              <MIc n={open ? 'chevronDown' : 'chevron'} />
            </button>
            {open &&
              entries.map(([k, v]) => (
                <div class="sf-entry" key={k}>
                  <div class="sf-entry-h">
                    <span class="mono">{k}</span>
                    {!dis && (
                      <button class="plg-text-btn danger" type="button" onClick={() => p.onUnset([...p.path, k])}>
                        删除
                      </button>
                    )}
                  </div>
                  <SchemaFields node={inner} value={v} path={[...p.path, k]} disabled={dis} onSet={p.onSet} onUnset={p.onUnset} />
                </div>
              ))}
            {open && !entries.length && <div class="plg-empty-line">还没有。</div>}
          </div>
        );
      return <ReadOnly {...p} n={n} />;
    }
    case 'object':
    case 'intersect':
      return (
        <div class="sf-nest">
          <button class="plg-link" type="button" onClick={() => setOpen(!open)}>
            <span>{text(n.meta.title) || text(n.meta.description) || p.name}</span>
            <MIc n={open ? 'chevronDown' : 'chevron'} />
          </button>
          {open && <SchemaFields node={n} value={cur} path={p.path} disabled={dis} onSet={p.onSet} onUnset={p.onUnset} />}
        </div>
      );
    default:
      return <ReadOnly {...p} n={n} />;
  }
}

function ReadOnly(p: FieldProps & { n: SchemaNode }) {
  return (
    <div class="plg-row static col">
      <Label name={p.name} n={p.n} />
      <pre class="sf-json">{JSON.stringify(p.value ?? p.n.meta.default ?? null, null, 2)}</pre>
    </div>
  );
}

function TextInput({ value, onCommit, secret, area, disabled, placeholder }: { value: string; onCommit: (v: string) => void; secret?: boolean; area?: boolean; disabled?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (secret ? '' : value);
  const commit = () => {
    if (draft !== null && draft !== (secret ? '' : value)) onCommit(draft);
    setDraft(null);
  };
  return area ? (
    <textarea class="sf-input area" rows={3} disabled={disabled} value={shown} placeholder={placeholder} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} onBlur={commit} />
  ) : (
    <input
      class="sf-input"
      type={secret ? 'password' : 'text'}
      autoComplete="off"
      disabled={disabled}
      value={shown}
      placeholder={placeholder}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
