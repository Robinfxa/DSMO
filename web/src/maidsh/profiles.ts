// 陪伴跟着人设走（maidsh/CONTRACT.md §13.4）：每个人设各有一份陪伴（记忆、心情、关系、表达、主动），
// 没开人设时用「无人设」那一份。人设库的人设是全局的（选一个，所有对话都用它），所以这里切的是
// 总控「默认」那一层的档案；对话、工作区那两层没有界面，不动。
//
// 档案按人设的名字关联（总控只存名字，24 字以内）。没开人设记成 NO_PERSONA。人设库编辑正文时会先换个
// 临时名字再改回来，所以只在一次操作做完以后才对一次（followPersona），改名时 relinkPersona 跟着改。
//
// 第一次：还没有档案关联过人设时，原来的那份（default，数据就在原来的目录里）整份归当前这个人设，
// 什么都不丢；之后别的人设第一次用时新建一份，从头开始。最多 20 个档案，满了就先共用「无人设」那份。

import { signal } from '@preact/signals';
import { installed } from '../plugins/frontend';
import { errText } from '../state/store';
import { get, hasModule, post, shownProfile } from './api';

export interface Profile {
  id: string;
  name: string;
  persona: string;
  createdAt: number;
  usedAt: number;
}
interface View {
  /** 默认那一层：档案 id 或 'off'。 */
  default: string;
  profiles: Profile[];
}

const PROFILES = '/api/maidsh/profiles';
const SCOPE = '/api/maidsh/scope';
const PERSONA_STATUS = '/api/dsh-persona-dafeiyu/status';
export const DEFAULT_PROFILE = 'default';
/** 没开人设时那一份关联的「名字」。 */
export const NO_PERSONA = '（无人设）';
const NO_PERSONA_NAME = '无人设';
/** 和总控的 cleanName 一样（maidsh/core/lib/scope.mjs）。 */
const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 24);
const keyOf = (persona: string | null) => (persona ? clean(persona) || NO_PERSONA : NO_PERSONA);

/** 总控里的档案和默认那一层（陪伴页的档案列表用）。 */
export const profileView = signal<View | null>(null);
/** 陪伴页在看别的档案（null = 当前人设用的那份）。 */
export const pickedProfile = signal<string | null>(null);

const personaOn = () => installed.value.some((x) => x.id === '@api-demo/persona-library' && x.enabled);

function showing() {
  const v = profileView.value;
  const active = v && v.default !== 'off' && v.profiles.some((p) => p.id === v.default) ? v.default : DEFAULT_PROFILE;
  const picked = pickedProfile.value;
  shownProfile.value = picked && v?.profiles.some((p) => p.id === picked) ? picked : active;
}

export async function readProfiles(): Promise<View> {
  const v = await get<View>(PROFILES);
  profileView.value = { default: v.default, profiles: Array.isArray(v.profiles) ? v.profiles : [] };
  showing();
  return profileView.value;
}

/** 陪伴页：看某一份（null 回到当前人设的那份）。 */
export function showProfile(id: string | null) {
  pickedProfile.value = id;
  showing();
}

const uniqueName = (v: View, want: string) => {
  const base = clean(want) || NO_PERSONA_NAME;
  let n = base;
  for (let i = 2; v.profiles.some((p) => p.name === n); i++) n = `${base.slice(0, 20)} ${i}`;
  return n;
};

/**
 * 让「默认」那一层用 [persona]（null = 没开人设）的那份；需要时先关联或新建。
 * 返回要告诉你的一句话（没变化就是空的）。没装总控或人设库时什么都不做。
 */
export async function followPersona(persona: string | null): Promise<string> {
  if (!hasModule('core') || !personaOn()) return '';
  const key = keyOf(persona);
  const label = persona ? `「${persona}」` : '没开人设时';
  let v = await readProfiles();
  let target = v.profiles.find((p) => p.persona === key);
  let note = '';
  if (!target) {
    const first = !v.profiles.some((p) => p.persona);
    const def = v.profiles.find((p) => p.id === DEFAULT_PROFILE);
    if (first && def) {
      // 第一次：原来的那份归这个人设
      await post(PROFILES, { action: 'link-persona', id: DEFAULT_PROFILE, persona: key });
      if (def.name === '默认') await post(PROFILES, { action: 'rename', id: DEFAULT_PROFILE, name: uniqueName(v, persona ?? NO_PERSONA_NAME) }).catch(() => {});
      target = def;
      note = persona ? `原来的陪伴（记忆、心情、关系）归到了「${persona}」；换别的人设时，TA 们各有各的一份` : '';
    } else {
      try {
        target = await post<Profile>(PROFILES, { action: 'create', name: uniqueName(v, persona ?? NO_PERSONA_NAME), persona: key });
        note = `${label}的陪伴是新的一份：记忆、心情、关系从头开始`;
      } catch (e) {
        // 档案满了：先共用「无人设」那份（没有就默认那份）
        target = v.profiles.find((p) => p.persona === NO_PERSONA) ?? def ?? v.profiles[0];
        if (!target) throw e;
        note = `陪伴档案满了（${errText(e)}），${label}先共用「${target.name}」那份`;
      }
    }
  }
  if (v.default !== 'off' && v.default !== target.id) {
    await post(SCOPE, { action: 'set-default', profile: target.id });
    if (!note) note = `已切到「${target.name}」的陪伴`;
    pickedProfile.value = null; // 换了人设：回到它的那份（没换时，在看的那份不动）
  }
  v = await readProfiles();
  return note;
}

/** 人设改名：关联它的那份跟着改（名字没被手动改过的话，档案名也改）。 */
export async function relinkPersona(from: string, to: string) {
  if (!hasModule('core') || !personaOn() || clean(from) === clean(to)) return;
  const v = await readProfiles();
  const p = v.profiles.find((x) => x.persona === clean(from));
  if (!p) return;
  await post(PROFILES, { action: 'link-persona', id: p.id, persona: clean(to) });
  if (p.name === clean(from)) await post(PROFILES, { action: 'rename', id: p.id, name: uniqueName(v, to) }).catch(() => {});
  await readProfiles();
}

/** 档案列表里的「给当前人设用」：把这份关联到当前人设（原来关联的那份解开），并切过去。 */
export async function useForPersona(id: string, persona: string | null) {
  const key = keyOf(persona);
  const v = await readProfiles();
  for (const p of v.profiles) if (p.persona === key && p.id !== id) await post(PROFILES, { action: 'link-persona', id: p.id, persona: '' });
  await post(PROFILES, { action: 'link-persona', id, persona: key });
  if (v.default !== 'off') await post(SCOPE, { action: 'set-default', profile: id });
  pickedProfile.value = null;
  await readProfiles();
}

/** 人设库现在的人设（null = 关着）；读不到时 undefined。 */
export async function currentPersona(): Promise<string | null | undefined> {
  try {
    const res = await fetch(PERSONA_STATUS, { credentials: 'same-origin' });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { ok?: boolean; value?: { current?: unknown; currentName?: unknown; globalOff?: unknown } };
    const s = j.value;
    if (j.ok === false || !s) return undefined;
    if (s.globalOff === true || typeof s.current !== 'string') return null;
    return typeof s.currentName === 'string' && s.currentName ? s.currentName : s.current;
  } catch {
    return undefined;
  }
}

/** 开 App、打开陪伴页时对一次：人设可能在别处换过。返回要告诉你的一句话。 */
export async function syncPersonaProfile(): Promise<string> {
  if (!hasModule('core') || !personaOn()) return '';
  const p = await currentPersona();
  if (p === undefined) return '';
  return followPersona(p);
}

/** 这份关联的是什么（列表里那一行的小字）。 */
export const linkLabel = (p: Profile) => (p.persona === NO_PERSONA ? '没开人设时用' : p.persona ? `人设「${p.persona}」` : '没关联人设');
