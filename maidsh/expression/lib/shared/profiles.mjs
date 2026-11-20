// 档案（CONTRACT.md §13）：每个面按档案各存一份数据。各面共用的小工具。
// 默认档案的数据就在面原来的目录里（不搬文件）；其他档案在 `<目录>/profiles/<id>/`。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROFILE = 'default';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 规整档案 id：不合法或没给就是默认档案（也挡住路径穿越）。 */
export const profileId = (p) => (typeof p === 'string' && ID.test(p) ? p : DEFAULT_PROFILE);
export const validProfileId = (p) => typeof p === 'string' && ID.test(p);

/** 这个档案的数据目录。 */
export const profileDir = (base, profile) => {
  const id = profileId(profile);
  return id === DEFAULT_PROFILE ? base : path.join(base, 'profiles', id);
};

/** 删掉一个档案的数据目录（默认档案不能删）。 */
export function removeProfileDir(base, profile) {
  const id = profileId(profile);
  if (id === DEFAULT_PROFILE || id !== profile) return false;
  fs.rmSync(path.join(base, 'profiles', id), { recursive: true, force: true });
  return true;
}

/** 磁盘上已经有数据的档案（含默认）。 */
export function profilesOnDisk(base) {
  try {
    return [DEFAULT_PROFILE, ...fs.readdirSync(path.join(base, 'profiles')).filter(validProfileId)];
  } catch {
    return [DEFAULT_PROFILE];
  }
}

/** 按档案懒加载的一组实例：of(profile) 第一次用时 make(id) 建出来。 */
export function perProfile(make) {
  const all = new Map();
  return {
    of(profile) {
      const id = profileId(profile);
      let x = all.get(id);
      if (!x) {
        x = make(id);
        all.set(id, x);
      }
      return x;
    },
    /** 已经加载过的档案。 */
    loaded: () => [...all.keys()],
    forget: (profile) => all.delete(profileId(profile)),
  };
}

/**
 * 把一个「只有一份数据」的面登记包成按档案分的（约定 v2）：
 * 每次调用按 turn.profile / job.profile / state(profile) 找到那个档案的实例，用它的面登记。
 * [of]：(profile) => 那个档案的面登记。[drop]：(profile) => void，删档案时清数据。
 */
export function profiledAspect(of, drop) {
  const t = of(DEFAULT_PROFILE);
  const pick = (p) => of(profileId(p));
  const a = { id: t.id, title: t.title, version: 2 };
  if (t.analysis) a.analysis = t.analysis;
  if (t.onAnalysis) a.onAnalysis = (r, turn) => pick(turn?.profile).onAnalysis(r, turn);
  if (t.prompt) a.prompt = { order: t.prompt.order, maxChars: t.prompt.maxChars, text: (turn) => pick(turn?.profile).prompt.text(turn) };
  if (t.state) a.state = (profile) => pick(profile).state(profile);
  if (t.batch) {
    const b = t.batch;
    a.batch = {
      schema: b.schema,
      instructions: b.instructions,
      apply: (r, chunk) => pick(chunk?.profile).batch.apply(r, chunk),
      finish: b.finish ? (job) => pick(job?.profile).batch.finish(job) : undefined,
      undo: b.undo ? (jobId, profile) => pick(profile).batch.undo(jobId, profile) : undefined,
    };
  }
  if (drop) a.dropProfile = (profile) => drop(profileId(profile));
  return a;
}

/**
 * 接口上的档案（`?profile=`，或 body.profile）：没给就是默认档案；给了要是总控里存在的档案，
 * 没装总控时只有默认档案。认不出返回 null（外壳回 404），免得随手建出目录。
 */
export function requestedProfile(ctx, req, body) {
  let raw = '';
  try {
    raw = new URL(req?.url ?? '/', 'http://x').searchParams.get('profile') ?? '';
  } catch {
    raw = '';
  }
  if (!raw && typeof body?.profile === 'string') raw = body.profile;
  if (!raw || raw === DEFAULT_PROFILE) return DEFAULT_PROFILE;
  if (!validProfileId(raw)) return null;
  try {
    return ctx.get('companion')?.profiles?.()?.some?.((p) => p.id === raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 登记给总控：老版总控（约定 v1，0.4 及以前）不收 v2 的面，就按 v1 登记（那时只有默认档案）。 */
export function registerAspect(companion, aspect) {
  const v = Number(companion?.version) || 1;
  return companion.register(v >= 2 ? aspect : { ...aspect, version: 1 });
}
