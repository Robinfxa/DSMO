import { describe, expect, it } from 'vitest';
import { DshClient } from '../src/engine/client';
import { MockEngine } from '../src/mock/engine';
import { describeTiming, wireTiming } from '../src/plugins/automation';
import { categoryOf } from '../src/plugins/meta';
// @ts-expect-error plain ESM module shared with the market scripts
import { checkManifest, tierOf } from '../../market/scripts/rules.mjs';

const base = { v: 1, id: '@x/p', title: 'P', summary: 's', version: '1.0.0', permissions: [] as string[] };

describe('skills and automations in the market', () => {
  it('puts them in their own categories and review tier', () => {
    const skill = { ...base, kinds: ['skill'], skills: [{ name: 'notes', files: { 'SKILL.md': '---\nname: notes\n---\nhi' } }] };
    const auto = { ...base, kinds: ['schedule'], schedules: [{ id: 'a', title: 'A', prompt: 'p', timing: { kind: 'daily', time: '08:30' } }] };
    expect(categoryOf(skill as any)).toBe('skills');
    expect(categoryOf(auto as any)).toBe('automation');
    expect(checkManifest(skill).errors).toEqual([]);
    expect(checkManifest(auto).errors).toEqual([]);
    expect(tierOf(skill)).toBe(2);
  });

  it('rejects unsafe skills and too-frequent automations', () => {
    const bad = (sk: object) => checkManifest({ ...base, kinds: ['skill'], skills: [sk] }).errors;
    expect(bad({ name: '../x', files: { 'SKILL.md': 'x' } }).length).toBeGreaterThan(0);
    expect(bad({ name: 'x', files: { 'README.md': 'x' } })).toContain('技能 x 缺少 SKILL.md');
    expect(bad({ name: 'x', files: { 'SKILL.md': 'x', '../evil': 'y' } }).length).toBeGreaterThan(0);
    expect(bad({ name: 'x', files: { 'SKILL.md': 'key sk-abcdefghijklmnopqrstuv' } }).join()).toContain('密钥');
    const sched = (t: object) => checkManifest({ ...base, kinds: ['schedule'], schedules: [{ id: 'a', title: 'A', prompt: 'p', timing: t }] }).errors;
    expect(sched({ kind: 'every', seconds: 60 }).length).toBe(1);
    expect(sched({ kind: 'daily', time: '25:00' }).length).toBe(1);
    expect(sched({ kind: 'weekly', time: '09:00', weekdays: [8] }).length).toBe(1);
  });

  it('speaks the schedule/create timing shape and describes it in words', () => {
    expect(wireTiming({ kind: 'every', seconds: 7200 })).toEqual({ kind: 'every', every_seconds: 7200 });
    const d = wireTiming({ kind: 'daily', time: '08:30' }) as any;
    expect(d.kind).toBe('daily');
    expect(d.daily.time).toBe('08:30:00');
    expect(typeof d.daily.time_zone).toBe('string');
    expect(describeTiming({ kind: 'weekly', time: '17:30', weekdays: [1, 5] })).toBe('每周一、五 17:30');
    expect(describeTiming({ kind: 'every', seconds: 7200 })).toBe('每 2 小时');
  });

  it('creates, edits, runs and deletes tasks against the (mock) host', async () => {
    const engine = new MockEngine(false);
    engine.speed = 0;
    const client = new DshClient(engine.rpc, engine.socketFactory);
    const rec = await client.createSchedule({ title: '每日计划', prompt: 'hi', timing: wireTiming({ kind: 'daily', time: '08:30' }), target: { kind: 'new' } });
    const id = String(rec.id);
    let cat = await client.scheduleCatalog();
    expect(cat.map((r) => r.id)).toContain(id);
    const stale = String(rec.updatedAt);
    await client.editSchedule(id, 'update', stale, { timing: wireTiming({ kind: 'daily', time: '09:15' }) });
    cat = await client.scheduleCatalog();
    expect(String(cat.find((r) => r.id === id)!.time)).toBe('09:15:00');
    await expect(client.editSchedule(id, 'update', stale, { title: 'x' })).rejects.toThrow('schedule_conflict');
    await client.runSchedule(id);
    await client.editSchedule(id, 'delete', String(cat.find((r) => r.id === id)!.updatedAt));
    expect(await client.scheduleCatalog()).toEqual([]);
    // deleting again is fine
    await client.editSchedule(id, 'delete', undefined);
  });

  it('lists installed skills like the engine would', async () => {
    const engine = new MockEngine(false);
    const client = new DshClient(engine.rpc, engine.socketFactory);
    engine.skillFs('install', [{ name: 'meeting-notes', files: { 'SKILL.md': '---\nname: meeting-notes\ndescription: 整理纪要\n---\n' } }]);
    const v = (await client.call('skills/list', { request: { sessionId: 'x' } })) as { skills: { name: string; description: string }[] };
    expect(v.skills.find((s) => s.name === 'meeting-notes')?.description).toBe('整理纪要');
    engine.skillFs('remove', ['meeting-notes']);
    const w = (await client.call('skills/list', { request: { sessionId: 'x' } })) as { skills: { name: string }[] };
    expect(w.skills.some((s) => s.name === 'meeting-notes')).toBe(false);
  });
});
