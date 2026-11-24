// The on-device engine as the page needs it to decide what to show (bridge
// `engine.status`), and first run (`setup.*`, drawn here while dsh-Go's
// RootGate decides the steps — api_demo_setup.dart, patch 0006).

import { computed, signal } from '@preact/signals';
import { inApp, local, onNative } from '../bridge/native';
import { nativeInfo } from '../state/store';

export interface Action {
  id: string;
  label: string;
}
export interface FailureCard {
  kind: string;
  title: string;
  body: string;
  detail?: string | null;
  culprits: string[];
  tone: string;
  primary: Action;
  secondary: Action[];
}
export interface EngineStatus {
  available: boolean;
  phase: 'notInstalled' | 'installing' | 'installed' | 'starting' | 'running' | 'stopping' | 'error';
  busy: boolean;
  mode: 'normal' | 'safe';
  error?: string | null;
  progress?: { step: string; done: number; total: number };
  startupFailure?: boolean;
  failure?: FailureCard | null;
  safe?: { on: boolean; probation: boolean; reason?: string | null; auto: boolean };
  loopback?: string | null;
  installedVersion?: string | null;
}
export interface SetupSpec {
  step: 'welcome' | 'runtime' | 'appearance' | 'access' | 'apiKey' | 'finishing';
  chooseRuntime: boolean;
  beside: boolean;
  actions: string[];
}
export interface SetupState {
  spec: SetupSpec | null;
  runtime: { setup: 'absent' | 'unpacking' | 'ready' | 'failed'; phase: string; error?: string | null; progress?: { step: string; done: number; total: number }; etaSeconds?: number; upgrade: boolean };
  local: { available: boolean; detail: string; warn: boolean; suggestRemote: boolean };
  /** available: the build reports statistics at all (DSMO: only with its own endpoint). */
  usage: { enabled: boolean; available?: boolean };
  connected: boolean;
  hasApiKey: boolean;
  /** Why the phone's copy is missing: 'ok', 'empty' or 'error:<code>' (App 1.3.3+). */
  keyRead?: string;
  theme: string;
}

export const engine = signal<EngineStatus | null>(null);
export const setup = signal<SetupState | null>(null);

/** The page talks to this phone's own engine (not an SSH host). */
export const onLocalHost = computed(() => (nativeInfo.value?.hosts.find((h) => h.current)?.id ?? 'local') === 'local');
const enabled = () => inApp() || __PROTOTYPE__;

/** Something stands between the person and the chat: first run, or an engine that isn't up. */
export const gate = computed<'setup' | 'engine' | null>(() => {
  if (!onLocalHost.value) return null;
  if (setup.value?.spec) return 'setup';
  const e = engine.value;
  if (e && e.phase !== 'running') return 'engine';
  return null;
});

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export async function refreshEngine() {
  if (!enabled() || !onLocalHost.value) return;
  try {
    engine.value = await local<EngineStatus>('engine.status');
  } catch {
    /* the bridge isn't there (yet) */
  }
}
export async function refreshSetup() {
  if (!enabled()) return;
  try {
    setup.value = await local<SetupState>('setup.get');
  } catch {
    setup.value = null;
  }
}

/** Polls while something is moving; slower when all is quiet. */
export function startEngineWatch() {
  if (started || !enabled()) return;
  started = true;
  const tick = async () => {
    await Promise.all([refreshEngine(), refreshSetup()]);
    const busy = !!setup.value?.spec || (engine.value && engine.value.phase !== 'running') || engine.value?.safe?.probation;
    timer = setTimeout(tick, busy ? 800 : 4000);
  };
  void tick();
  const again = () => {
    clearTimeout(timer);
    void tick();
  };
  onNative('setup.changed', again);
  onNative('engine.changed', again);
  onNative('resumed', again);
}

export const doStep = async (action: string) => {
  await local('setup.do', { action });
  await refreshSetup();
};
export const recover = (action: string, extra: Record<string, unknown> = {}) => local('engine.recover', { action, ...extra }).finally(() => void refreshEngine());

export function etaText(s?: number) {
  if (s == null) return '';
  return s >= 90 ? `约 ${Math.round(s / 60)} 分钟` : `约 ${Math.max(5, Math.round(s / 5) * 5)} 秒`;
}
export const percent = (p?: { done: number; total: number }) => (p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0);
