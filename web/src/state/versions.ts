// Versions of one conversation. DSH's log is append-only: editing a message or
// regenerating a reply can only be done as `session/fork` before the prompt
// (dsh-Go does the same and opens the fork as a new conversation). Here those
// forks stay one conversation, the way ChatGPT and Claude show it:
//  - only the version you are on is listed in the sidebar;
//  - the edited message (or the regenerated reply) gets 「‹ 2 / 3 ›」 to switch.
// An explicit 「分叉」 is different: it makes a separate, listed conversation.
//
// The bookkeeping lives on the device (decision Q7 style): child id → where it
// branched off. Seqs survive a fork (the child's log is an exact prefix), so a
// cut identifies the same message in every version.

import { computed, signal } from '@preact/signals';
import { native } from '../bridge/native';

export interface VersionEntry {
  /** The first conversation of the family; its id names the family. */
  group: string;
  /** The version this one branched from (normalised so siblings share it). */
  parent: string;
  /** Last event kept from the parent (-1: started fresh). */
  cut: number;
  kind: 'edit' | 'regen';
  created: number;
}

interface Saved {
  entries: Record<string, VersionEntry>;
  active: Record<string, string>;
}

export const versionEntries = signal<Record<string, VersionEntry>>({});
/** family → the version shown in the sidebar. */
export const activeVersion = signal<Record<string, string>>({});

const KEY = 'versions';

export async function loadVersions() {
  try {
    const raw = await native.storageGet(KEY);
    const v = raw ? (JSON.parse(raw) as Saved) : null;
    versionEntries.value = v?.entries ?? {};
    activeVersion.value = v?.active ?? {};
  } catch {
    versionEntries.value = {};
    activeVersion.value = {};
  }
}
const save = () => native.storageSet(KEY, JSON.stringify({ entries: versionEntries.value, active: activeVersion.value } satisfies Saved)).catch(() => {});

export const familyOf = (id: string) => versionEntries.value[id]?.group ?? id;

/** All versions of [id]'s family, oldest first (ids may include deleted sessions). */
export function familyMembers(id: string): string[] {
  const g = familyOf(id);
  const kids = Object.entries(versionEntries.value)
    .filter(([, e]) => e.group === g)
    .sort((a, b) => a[1].created - b[1].created)
    .map(([k]) => k);
  return [g, ...kids];
}

export function addVersion(child: string, from: string, cut: number, kind: VersionEntry['kind']) {
  const all = versionEntries.value;
  // Editing the same message again in a version branches from that version's parent: one row of siblings.
  let parent = from;
  while (all[parent] && all[parent].cut === cut) parent = all[parent].parent;
  const group = familyOf(from);
  versionEntries.value = { ...all, [child]: { group, parent, cut, kind, created: Date.now() } };
  activeVersion.value = { ...activeVersion.value, [group]: child };
  void save();
}

export function setActiveVersion(id: string) {
  activeVersion.value = { ...activeVersion.value, [familyOf(id)]: id };
  void save();
}

/**
 * Sessions to keep out of the sidebar: every version but the active one.
 * [exists] filters out deleted sessions so a family never disappears entirely.
 */
export function hiddenVersions(exists: (id: string) => boolean): Set<string> {
  const out = new Set<string>();
  const groups = new Set(Object.values(versionEntries.value).map((e) => e.group));
  for (const g of groups) {
    const members = familyMembers(g).filter(exists);
    if (members.length < 2) continue;
    const want = activeVersion.value[g];
    const shown = want && members.includes(want) ? want : members[members.length - 1];
    for (const m of members) if (m !== shown) out.add(m);
  }
  return out;
}
export const versionsVersion = computed(() => [versionEntries.value, activeVersion.value]);

export interface Siblings {
  ids: string[];
  index: number;
  /** edit: the switcher sits under the message; regen: under the reply. */
  kind: 'edit' | 'regen';
}

/**
 * For session [sid] with user messages at [userSeqs] (ascending): which message
 * has other versions, keyed by that message's seq.
 */
export function siblingsFor(sid: string, userSeqs: number[], exists: (id: string) => boolean): Map<number, Siblings> {
  const all = versionEntries.value;
  const out = new Map<number, Siblings>();
  const firstUserAfter = (cut: number) => userSeqs.find((s) => s > cut);
  const sets: { parent: string; cut: number }[] = [];
  const me = all[sid];
  if (me) sets.push({ parent: me.parent, cut: me.cut });
  for (const e of Object.values(all)) if (e.parent === sid && !sets.some((x) => x.parent === sid && x.cut === e.cut)) sets.push({ parent: sid, cut: e.cut });
  for (const { parent, cut } of sets) {
    const kids = Object.entries(all)
      .filter(([, e]) => e.parent === parent && e.cut === cut)
      .sort((a, b) => a[1].created - b[1].created);
    const ids = [parent, ...kids.map(([k]) => k)].filter(exists);
    if (ids.length < 2 || !ids.includes(sid)) continue;
    const at = firstUserAfter(cut);
    if (at === undefined) continue;
    out.set(at, { ids, index: ids.indexOf(sid), kind: kids.some(([, e]) => e.kind === 'edit') ? 'edit' : 'regen' });
  }
  return out;
}

/** 「T」→「T (1)」,「T (1)」→「T (2)」: what dsh-Go and the official web client name a fork. */
export function bumpedForkTitle(title: string) {
  const m = /^(.*) \((\d+)\)$/.exec(title.trim());
  return m ? `${m[1]} (${Number(m[2]) + 1})` : `${title.trim()} (1)`;
}
