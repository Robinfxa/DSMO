import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { I, type IconName } from './icons';

/** Inline SVG icon; the wrapper is `display: contents` so CSS sees the svg directly. */
export function Ic({ n }: { n: IconName }) {
  return <i class="ic" aria-hidden="true" dangerouslySetInnerHTML={{ __html: I[n] }} />;
}

export function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button class={document.body.classList.contains('is-m') ? 'm-switch' : 'switch'} type="button" role="switch" aria-label={label} aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

export function Select({ label, value, options, placeholder, onChange }: { label: string; value: string; options: [string, string][]; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <span class="select-wrap">
      <select aria-label={label} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(([v, t]) => (
          <option value={v} key={v}>
            {t}
          </option>
        ))}
      </select>
      <Ic n="IconChevronDownOutline14" />
    </span>
  );
}

export function Lrow({
  title,
  sub,
  end,
  onClick,
  icon,
  class: cls,
}: {
  title: ComponentChildren;
  sub?: ComponentChildren;
  end?: ComponentChildren;
  onClick?: () => void;
  icon?: IconName;
  class?: string;
}) {
  const inner = (
    <>
      {icon && (
        <span class="f-ico">
          <Ic n={icon} />
        </span>
      )}
      {icon ? (
        <span>
          <span class="lrow-title">{title}</span>
          {sub && <span class="lrow-sub">{sub}</span>}
        </span>
      ) : (
        <>
          <span class="lrow-title">{title}</span>
          {sub && <span class="lrow-sub">{sub}</span>}
        </>
      )}
    </>
  );
  return (
    <div class={`lrow ${cls ?? ''}`}>
      {onClick ? (
        <button class={`lrow-main ${icon ? 'row-ico-l' : ''}`} type="button" onClick={onClick}>
          {inner}
        </button>
      ) : (
        <div class={`lrow-main ${icon ? 'row-ico-l' : ''}`}>{inner}</div>
      )}
      {end !== undefined && (typeof end === 'string' ? <span class="lrow-end">{end}</span> : end)}
    </div>
  );
}

export function Empty({ title, desc, small, children }: { title: string; desc?: string; small?: boolean; children?: ComponentChildren }) {
  return (
    <div class={`empty-state ${small ? 'small' : ''}`}>
      <div class="empty-t">{title}</div>
      {desc && <div class="empty-d">{desc}</div>}
      {children}
    </div>
  );
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return <span class="spin" role="img" aria-label={label} />;
}

/** Runs an async loader; re-runs when deps change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: Error | null; loading: boolean; reload: () => void } {
  const [state, set] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [n, setN] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => live && alive.current && set({ data, error: null, loading: false }),
      (error) => live && alive.current && set({ data: undefined, error, loading: false }),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export function Chip({ on, children, onClick }: { on: boolean; children: ComponentChildren; onClick: () => void }) {
  return (
    <button class="toggle" type="button" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

export const stop = (e: JSX.TargetedEvent) => e.stopPropagation();

export function fmtTime(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `今天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function fmtSize(n?: number) {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
