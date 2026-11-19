import { useEffect, useState } from 'preact/hooks';
import { contributions, invoke, readView } from './dshgo';
import { PluginView } from './view';

/** A dsh-Go plugin panel: view + data from the bridge, taps → invoke, refresh / patch effects applied here. */
export function DshGoPanel({ pkg, id }: { pkg: string; id: string }) {
  const [state, setState] = useState<{ view?: unknown; data?: any; error?: string }>({});
  const load = () =>
    readView(pkg, id).then(
      (v) => setState({ view: v.view, data: v.data }),
      (e) => setState({ error: e.message }),
    );
  useEffect(() => void load(), [pkg, id]);
  const plugin = contributions.value.find((p) => p.pkg === pkg);
  if (state.error) return <div class="p-body">{state.error}</div>;
  if (!state.view) return <div class="p-body">正在加载…</div>;
  return (
    <div class="p-scroll">
      <PluginView
        view={state.view}
        data={state.data}
        onTap={(action, value) =>
          invoke({ pkg }, id, 'panels', action, value, undefined, (e) => {
            if (e.type === 'refresh') void load();
            if (e.type === 'patch' && e.data && typeof e.data === 'object') setState((s) => ({ ...s, data: mergePatch(s.data, e.data) }));
          })
        }
      />
      {plugin && <div class="note">来自引擎插件「{plugin.title}」</div>}
    </div>
  );
}

/** RFC 7396 JSON Merge Patch. */
export function mergePatch(target: any, patch: any): any {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
