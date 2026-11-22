// What an engine plugin keeps on the host that DSMO can also delete when it is uninstalled.
// DSH's removeBundle only removes the package; the data stays (reinstalling picks it up again).
// For the plugins listed here, uninstalling asks whether to delete that too, through the
// plugin's own routes, so it has to run before the package goes.

import { getClient } from '../state/store';

export interface EngineData {
  /** 「它记住的 12 件事」 */
  describe(n: number): string;
  /** What keeping it is called: 「保留记忆」 */
  keep: string;
  count(): Promise<number>;
  wipe(): Promise<void>;
}

const ids = (v: unknown): string[] => {
  const entries = v && typeof v === 'object' ? (v as { entries?: unknown }).entries : undefined;
  return Array.isArray(entries) ? entries.map((e) => String((e as { id?: unknown })?.id ?? '')).filter(Boolean) : [];
};

export const ENGINE_DATA: Record<string, EngineData> = {
  // 长期记忆: memories.json under $DSH_HOME/memory-share (memoryShare/list, memoryShare/forget)
  '@api-demo/memory-share': {
    describe: (n) => `它记住的 ${n} 件事`,
    keep: '保留记忆',
    count: async () => ids(await getClient().call('memoryShare/list', {})).length,
    wipe: async () => {
      for (const id of ids(await getClient().call('memoryShare/list', {}))) await getClient().call('memoryShare/forget', { id });
    },
  },
};
