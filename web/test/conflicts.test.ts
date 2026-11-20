// Plugins that write to the same place (plugins/conflicts.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { dsBot } from '../src/bots/store';
import { catalogPlugins, installed, type ApiDemoManifest } from '../src/plugins/frontend';
import { affectsOf, clashesOf, hostBundles, personaSkipBots } from '../src/plugins/conflicts';

const m = (id: string, title: string, extra: Partial<ApiDemoManifest>): ApiDemoManifest =>
  ({ v: 1, id, title, summary: '', version: '1.0.0', kinds: ['engine'], permissions: [], ...extra }) as ApiDemoManifest;
const persona = m('@api-demo/persona-library', '人设库', { affects: ['prompt.persona'], engine: { package: 'dsh-persona-dafeiyu', version: '0.8.0' } });
const memory = m('@api-demo/memory-share', '长期记忆', { affects: ['prompt.memory'], engine: { package: 'dsh-plugin-memory-share', version: '0.6.0' } });
const companionMemory = m('@api-demo/maidsh-memory', 'MaiDSH 记忆', { affects: ['prompt.memory'], engine: { package: 'maidsh-memory', version: '0.1.0' } });
const mood = m('@api-demo/maidsh-mood', 'MaiDSH 心情', { affects: ['prompt.mood'], engine: { package: 'maidsh-mood', version: '0.1.0' } });
const otherPersona = m('@x/roleplay', '角色扮演', { affects: ['prompt.persona'] });
const usage = m('@api-demo/usage-today', '今日用量', { engine: { package: 'dsh-go-example-usage', version: '0.1.0' } });
const bots = (n: number) => ({
  availability: 'ready' as const,
  live: { activity: {}, bots: {}, rooms: {}, approvals: [] },
  feed: true,
  team: { bots: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, sessionId: `s${i}` })), rooms: [] } as never,
});

beforeEach(() => {
  catalogPlugins.value = [persona, memory, companionMemory, mood, otherPersona, usage];
  installed.value = [];
  hostBundles.value = [];
  personaSkipBots.value = false;
  dsBot.value = { availability: 'connecting', live: { activity: {}, bots: {}, rooms: {}, approvals: [] }, feed: false };
});

describe('conflicts', () => {
  it('a listing declares its tags; an engine package is known by its listing’s tags', () => {
    expect(affectsOf(persona)).toEqual(['prompt.persona']);
    expect(affectsOf({ engine: { package: 'dsh-plugin-memory-share', version: '9' } })).toEqual(['prompt.memory']);
    expect(affectsOf({ engine: { package: '@7gzgn/dsh-emotion', version: '1' } })).toEqual(['prompt.mood']); // market/tags.json engines
    expect(affectsOf(memory)).toEqual(['prompt.memory']);
    expect(affectsOf(otherPersona)).toEqual(['prompt.persona']);
    expect(affectsOf(usage)).toEqual([]);
  });

  it('two plugins giving the AI a persona clash; persona and memory do not', () => {
    installed.value = [
      { id: otherPersona.id, enabled: true, version: '1.0.0' },
      { id: memory.id, enabled: true, version: '1.0.0' },
    ] as never;
    expect(clashesOf(persona).map((c) => [c.kind, c.with])).toEqual([['plugin', '角色扮演']]);
    installed.value = [{ id: otherPersona.id, enabled: false, version: '1.0.0' }] as never;
    expect(clashesOf(persona)).toEqual([]); // switched off: no clash
  });

  it('an engine package installed by hand that does the same counts too (not the plugin’s own)', () => {
    hostBundles.value = ['dsh-agentmemory', 'dsh-plugin-memory-share', 'dsh-subagent'];
    expect(clashesOf(memory).map((c) => [c.kind, c.with])).toEqual([['engine', 'dsh-agentmemory']]);
  });

  it('same tag, any two plugins: no pair written anywhere', () => {
    installed.value = [{ id: memory.id, enabled: true, version: '1.0.0' }] as never;
    expect(clashesOf(companionMemory).map((c) => [c.kind, c.with, c.position])).toEqual([['plugin', '长期记忆', 'prompt.memory']]);
    expect(clashesOf(mood)).toEqual([]);
    hostBundles.value = ['@7gzgn/dsh-emotion'];
    expect(clashesOf(mood).map((c) => [c.kind, c.with, c.position])).toEqual([['engine', '@7gzgn/dsh-emotion', 'prompt.mood']]);
  });

  it('a listed package installed by hand, its plugin not installed here, counts as an engine package', () => {
    hostBundles.value = ['dsh-plugin-memory-share'];
    expect(clashesOf(companionMemory).map((c) => [c.kind, c.with])).toEqual([['engine', 'dsh-plugin-memory-share']]);
    installed.value = [{ id: memory.id, enabled: true, version: '1.0.0' }] as never;
    expect(clashesOf(companionMemory).map((c) => [c.kind, c.with])).toEqual([['plugin', '长期记忆']]); // once, as the plugin
  });

  it('DS Bot: a persona reaches the Bots’ conversations, with a fix; memory only explained', () => {
    dsBot.value = bots(2);
    const p = clashesOf(persona);
    expect(p.map((c) => [c.kind, c.with, c.fix])).toEqual([['native', 'DS Bot', 'persona-skip-bots']]);
    expect(clashesOf(memory).map((c) => [c.kind, c.with, c.fix])).toEqual([['native', 'DS Bot', undefined]]);
    personaSkipBots.value = true;
    expect(clashesOf(persona)).toEqual([]);
    dsBot.value = bots(0);
    expect(clashesOf(memory)).toEqual([]); // no Bots: nothing to clash with
  });
});
