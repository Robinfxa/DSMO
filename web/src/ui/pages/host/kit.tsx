// Shared pieces of the app-local pages (local.tsx, phone.tsx): reading the
// app-local bridge, reporting failures, and the rows they are built from.

import { useEffect, useState } from 'preact/hooks';
import { local } from '../../../bridge/native';
import { errText, showToast } from '../../../state/store';
import { Switch } from '../../common';

export const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function useLocal<T>(method: string, params: Record<string, unknown> = {}, pollMs = 0) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    local<T>(method, params).then(
      (d) => (setData(d), setError(null)),
      (e) => setError(errText(e)),
    );
  useEffect(() => {
    void load();
    if (!pollMs) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [method]);
  return { data, error, reload: load };
}
export const Loading = ({ error }: { error?: string | null }) => <div class="plg-empty-line">{error ? `没能读到：${error}` : '正在读取…'}</div>;
export const act = async (fn: () => Promise<unknown>, ok?: string) => {
  try {
    const r = await fn();
    if (ok) showToast(ok);
    return r;
  } catch (e) {
    showToast(errText(e));
    return undefined;
  }
};

export function SwitchRow({ title, sub, on, onChange, disabled }: { title: string; sub?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div class="plg-row static">
      <div class="plg-row-m">
        <div class="plg-row-t">{title}</div>
        {sub && <div class="plg-row-s wrap">{sub}</div>}
      </div>
      <Switch on={on} label={title} disabled={disabled} onChange={onChange} />
    </div>
  );
}
export function InfoRow({ title, value, mono }: { title: string; value?: string | null; mono?: boolean }) {
  return (
    <div class="plg-kv">
      <span>{title}</span>
      <span class={mono ? 'mono' : ''}>{value || '—'}</span>
    </div>
  );
}
