// The skill and automation halves of a market plugin.
//  - skills: text folders written into the local engine's skills root by the
//    App (DSH has no Remote that writes skills); available as /name.
//  - schedules: automation tasks made with `schedule/create` (DSH 0.2.2 target
//    protocol); each run starts a new conversation. Older hosts can't take them.

import { getClient, nativeInfo } from '../state/store';
import type { ManifestSchedule } from './frontend';

export const WEEKDAY = ['', '一', '二', '三', '四', '五', '六', '日'];

export function describeTiming(t: ManifestSchedule['timing']): string {
  switch (t.kind) {
    case 'daily':
      return `每天 ${t.time}`;
    case 'weekly':
      return `每周${t.weekdays.map((d) => WEEKDAY[d]).join('、')} ${t.time}`;
    case 'every': {
      const h = t.seconds / 3600;
      return h >= 1 && Number.isInteger(h) ? `每 ${h} 小时` : `每 ${Math.round(t.seconds / 60)} 分钟`;
    }
  }
}

const tz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const hms = (t: string) => (t.length === 5 ? `${t}:00` : t);

/** The wire timing (`{kind, <selector>}`), in the device's time zone. */
export function wireTiming(t: ManifestSchedule['timing']): Record<string, unknown> {
  switch (t.kind) {
    case 'daily':
      return { kind: 'daily', daily: { time: hms(t.time), time_zone: tz() } };
    case 'weekly':
      return { kind: 'weekly', weekly: { time: hms(t.time), time_zone: tz(), weekdays: t.weekdays } };
    case 'every':
      return { kind: 'every', every_seconds: t.seconds };
  }
}

/** Skills go to the engine on this phone; a remote host has no way to receive them. */
export const skillsInstallable = () => {
  const cur = nativeInfo.value?.hosts.find((h) => h.current);
  return !cur || cur.id === 'local';
};

export async function createSchedules(list: ManifestSchedule[]): Promise<Record<string, string>> {
  const made: Record<string, string> = {};
  try {
    for (const s of list) {
      const rec = await getClient().createSchedule({ title: s.title, prompt: s.prompt, timing: wireTiming(s.timing), target: { kind: 'new' } });
      made[s.id] = String(rec.id);
    }
  } catch (e) {
    await deleteSchedules(Object.values(made)).catch(() => {});
    const code = (e as { code?: string }).code ?? '';
    if (/unknown-endpoint|not-found|unknown/i.test(code)) throw new Error('这台主机的 DSH 版本不能从这里创建自动化任务（需要 0.2.2 以上）');
    throw e;
  }
  return made;
}

async function freshRecord(id: string) {
  return (await getClient().scheduleCatalog()).find((r) => r.id === id);
}

export async function deleteSchedules(ids: string[]) {
  for (const id of ids) {
    const rec = await freshRecord(id).catch(() => undefined);
    if (!rec) continue;
    await getClient().editSchedule(id, 'delete', String(rec.updatedAt ?? ''));
  }
}

/** Changes the time of a daily / weekly task (compare-and-set on its revision). */
export async function setScheduleTime(id: string, t: ManifestSchedule['timing'], time: string) {
  const rec = await freshRecord(id);
  if (!rec) throw new Error('这个自动化任务已经不在了');
  const next = t.kind === 'every' ? t : { ...t, time };
  await getClient().editSchedule(id, 'update', String(rec.updatedAt ?? ''), { timing: wireTiming(next) });
}

export async function scheduleState(id: string): Promise<{ time?: string; active: boolean } | null> {
  const rec = await freshRecord(id).catch(() => undefined);
  if (!rec) return null;
  return { time: typeof rec.time === 'string' ? rec.time.slice(0, 5) : undefined, active: rec.status !== 'inactive' };
}

export const runSchedule = (id: string) => getClient().runSchedule(id);
