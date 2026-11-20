// Plugins that write to the same place. Some places hold one thing at a time: two persona
// plugins both tell the AI who it is, two memory plugins both add what they remember. And
// some places are also used by DSMO's own features: DS Bot gives every Bot its own role,
// instructions and memory, and a persona or memory plugin goes into every conversation,
// Bot conversations included.
//
// A listing says where it writes with `affects`; the community packages DSMO lists (and the
// same packages installed by hand through 引擎插件) are known here by package name.
//
// The persona library has a per-conversation mode, which gives one clash a fix: switch the
// persona off in Bot conversations (`set-mode session` + `set-session-persona none` for each
// Bot's sessions, kept up as Bots come and go). The memory package can't exclude a
// conversation from outside, so that clash is only explained.

import { effect, signal } from '@preact/signals';
import { native } from '../bridge/native';
import { dsBot } from '../bots/store';
import { getClient } from '../state/store';
import { catalogPlugins, findPlugin, installed, type ApiDemoManifest } from './frontend';

export type Position = 'prompt.persona' | 'prompt.memory';

export const POSITIONS: Record<Position, { title: string; what: string }> = {
  'prompt.persona': { title: '每一轮的人设', what: '给 AI 定下身份、性格和说话方式，加进每一轮对话' },
  'prompt.memory': { title: '长期记忆', what: '把记住的事加进每一轮对话' },
};

/** Engine packages that write to these places, whether listed in the market or installed by hand. */
const KNOWN_ENGINE: Record<string, { title: string; affects: Position[] }> = {
  'dsh-persona-dafeiyu': { title: '人设库', affects: ['prompt.persona'] },
  '@7gzgn/dsh-emotion': { title: 'dsh-emotion', affects: ['prompt.persona'] },
  'dsh-plugin-memory-share': { title: '长期记忆', affects: ['prompt.memory'] },
  'dsh-agentmemory': { title: 'dsh-agentmemory', affects: ['prompt.memory'] },
};

export const affectsOf = (p: Pick<ApiDemoManifest, 'affects' | 'engine'>): Position[] => p.affects ?? (p.engine ? KNOWN_ENGINE[p.engine.package]?.affects : undefined) ?? [];

/** Engine packages installed and on, on this host (null until read). */
export const hostBundles = signal<string[] | null>(null);
export async function loadHostBundles() {
  try {
    hostBundles.value = (await getClient().listBundles()).filter((b) => b.installed !== false && b.enabled !== false).map((b) => String(b.name ?? ''));
  } catch {
    // no plugin manager here (a relay, plain dsh web): only what DSMO itself installed counts
  }
}

export interface Clash {
  position: Position;
  /** What it clashes with: another plugin, an engine package, or a DSMO feature. */
  with: string;
  kind: 'plugin' | 'engine' | 'native';
  text: string;
  /** A fix this app can apply. */
  fix?: 'persona-skip-bots';
}

/** In Bot conversations, no persona (persona library); the person's choice, kept on the device. */
export const personaSkipBots = signal(false);

const hasBots = () => dsBot.value.availability === 'ready' && (dsBot.value.team?.bots.length ?? 0) > 0;

/**
 * Where [p] writes and what else does: other plugins that are on, engine packages on this host,
 * DS Bot. For a plugin not yet installed, what installing it would run into.
 */
export function clashesOf(p: ApiDemoManifest): Clash[] {
  const mine = affectsOf(p);
  if (!mine.length) return [];
  const out: Clash[] = [];
  const others = installed.value
    .filter((x) => x.enabled && x.id !== p.id)
    .map((x) => findPlugin(x.id))
    .filter((x): x is ApiDemoManifest => !!x);
  const ownPackages = new Set([p.engine?.package, ...catalogPlugins.value.map((x) => x.engine?.package)].filter(Boolean));
  for (const pos of mine) {
    for (const o of others)
      if (affectsOf(o).includes(pos))
        out.push({ position: pos, with: o.title, kind: 'plugin', text: `「${o.title}」也在${POSITIONS[pos].what}，两个一起开，AI 会收到两份，可能互相打架。建议只留一个。` });
    for (const pkg of hostBundles.value ?? [])
      if (!ownPackages.has(pkg) && KNOWN_ENGINE[pkg]?.affects.includes(pos))
        out.push({ position: pos, with: pkg, kind: 'engine', text: `主机上装着引擎插件 ${pkg}，它也在${POSITIONS[pos].what}。建议在「引擎插件」里停用其中一个。` });
    if (hasBots()) {
      if (pos === 'prompt.persona' && !personaSkipBots.value)
        out.push({ position: pos, with: 'DS Bot', kind: 'native', fix: 'persona-skip-bots', text: '每个 Bot 有自己的角色和说明。人设会加进所有对话，包括 Bot 的对话，可能盖过 Bot 自己的设定。' });
      if (pos === 'prompt.memory')
        out.push({ position: pos, with: 'DS Bot', kind: 'native', text: 'Bot 有自己的记忆。长期记忆也会加进 Bot 的对话，Bot 记下的事也可能存进你的长期记忆里。这个插件不能只对某些对话关掉。' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- persona: off in Bot conversations
//
// The switch flips at once and is saved; the package is brought to it in the background, one
// run at a time, always towards the latest choice (a run checks between requests and stops if
// the choice changed). On: remember the package's mode, switch it to `session`, then `none` for
// each Bot conversation. Off: put the mode back first — in `global` the package ignores
// per-conversation choices, so the persona is back in Bot conversations with one request — then
// clear what was set. Re-runs only when the set of Bot conversations changes.

const PERSONA = '/api/dsh-persona-dafeiyu';
const personaOn = () => installed.value.some((x) => x.id === '@api-demo/persona-library' && x.enabled);

async function personaCall(body: Record<string, unknown>) {
  const res = await fetch(`${PERSONA}/mutate`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; value?: Record<string, unknown> };
  if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
  return j.value ?? {};
}

async function personaMode(): Promise<string> {
  const res = await fetch(`${PERSONA}/status`, { credentials: 'same-origin' });
  const j = (await res.json().catch(() => ({}))) as { value?: { mode?: unknown } };
  return typeof j.value?.mode === 'string' ? j.value.mode : 'global';
}

/** The Bots' conversations (not the Bot and room ids, which aren't conversations). */
function botSessions(): string[] {
  const team = dsBot.value.team;
  if (!team) return [];
  return [...new Set([...team.bots.flatMap((b) => [b.sessionId, ...b.parts]), ...team.rooms.flatMap((r) => r.parts)])].filter(Boolean);
}

/** Bringing the package to the switch, in the background. */
export const personaSkipSyncing = signal(false);
/** Set to `none` by this app (this launch); cleared again when the switch goes off. */
const done = new Set<string>();
let running: Promise<void> | null = null;
let again = false;
let lastKey = '';

async function step() {
  if (!personaOn()) return;
  const want = personaSkipBots.value;
  if (want) {
    if ((await native.storageGet('persona-skip-bots-mode').catch(() => null)) == null) {
      const mode = await personaMode();
      await native.storageSet('persona-skip-bots-mode', mode === 'session' ? 'session' : mode);
    }
    await personaCall({ action: 'set-mode', mode: 'session' });
    for (const sessionId of botSessions()) {
      if (personaSkipBots.value !== want) return;
      if (done.has(sessionId)) continue;
      await personaCall({ action: 'set-session-persona', sessionId, none: true });
      done.add(sessionId);
    }
  } else {
    const saved = await native.storageGet('persona-skip-bots-mode').catch(() => null);
    // never turned on (or already undone): nothing to put back
    if (saved == null && !done.size) return;
    const before = saved ?? 'global';
    if (before !== 'session') await personaCall({ action: 'set-mode', mode: before });
    for (const sessionId of new Set([...done, ...botSessions()])) {
      if (personaSkipBots.value !== want) return;
      await personaCall({ action: 'set-session-persona', sessionId, personaId: null });
      done.delete(sessionId);
    }
    await native.storageSet('persona-skip-bots-mode', null);
  }
}

/** Runs [step] until the package matches the latest choice; one run at a time. */
function sync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  personaSkipSyncing.value = true;
  running = (async () => {
    try {
      do {
        again = false;
        await step();
      } while (again);
    } finally {
      running = null;
      personaSkipSyncing.value = false;
    }
  })();
  return running;
}

/** Brings the package to the switch again (after a failure, when 人设 opens). */
export const syncPersonaSkipBots = () => (personaOn() ? sync() : Promise.resolve());

/** Turns 「Bot 的对话里不用人设」 on or off: at once on screen and saved; the package follows. */
export async function setPersonaSkipBots(on: boolean) {
  personaSkipBots.value = on;
  await native.storageSet('persona-skip-bots', on ? '1' : null);
  await sync();
}

/** At start: read the choice, and keep Bot conversations without a persona as Bots are added. */
export async function watchConflicts() {
  personaSkipBots.value = (await native.storageGet('persona-skip-bots').catch(() => null)) === '1';
  effect(() => {
    const key = botSessions().sort().join('\n');
    if (!personaSkipBots.value || !personaOn() || key === lastKey) return;
    lastKey = key;
    void sync().catch(() => {});
  });
}
