// Plugin updates: an installed plugin whose market version is newer shows 「更新」, updates its
// engine half to the newly pinned version, and official ones update themselves at start.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiDemoManifest } from '../src/plugins/frontend';

const bundles: string[] = [];
const onHost = new Map<string, string>(); // package -> version on the (fake) host
let fail = false;
vi.mock('../src/state/store', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getClient: () => ({
      installBundle: async (spec: string) => {
        bundles.push(spec);
        if (fail) return { application: 'failed', packageResult: { kind: 'network' } };
        const [name, version] = spec.split('@');
        if (onHost.has(name)) return { application: 'failed', error: { code: 'already-installed' } };
        onHost.set(name, version);
        return { application: 'restart-required' };
      },
      // DSH: remove + install of an exact newer version; '' from when not installed; not newer → refused at check
      updateBundle: async (name: string, version: string) => {
        bundles.push(`update ${name}@${version}`);
        const from = onHost.get(name) ?? '';
        if (!from) return { from, to: version, step: 'check', result: { application: 'failed', error: { code: 'invalid-spec' } } };
        if (from === version) return { from, to: version, step: 'check', result: { application: 'failed', error: { code: 'invalid-spec' } } };
        if (fail) return { from, to: version, step: 'install', result: { application: 'failed', packageResult: { kind: 'network' } } };
        onHost.set(name, version);
        return { from, to: version, step: 'install', result: { application: 'applied' } };
      },
      removeBundle: async (name: string) => {
        onHost.delete(name);
        return {};
      },
    }),
  };
});
vi.mock('../src/plugins/dshgo', async (orig) => ({ ...((await orig()) as Record<string, unknown>), loadContributions: async () => {} }));

const fe = await import('../src/plugins/frontend');

const engine = (version: string, pkg = 'maidsh-core', official = true): ApiDemoManifest => ({
  v: 1,
  id: '@api-demo/maidsh-core',
  title: 'MaiDSH 总控',
  summary: 's',
  version,
  kinds: ['engine'],
  permissions: [],
  official,
  engine: { package: pkg, version: version === '1.0.0' ? '0.1.0' : '0.4.0' },
});
const market = (p: ApiDemoManifest) => (fe.catalogPlugins.value = [...fe.catalogPlugins.value.filter((x) => x.id !== p.id), p]);

describe('plugin updates', () => {
  beforeEach(async () => {
    bundles.length = 0;
    fail = false;
    if (fe.isInstalled('@api-demo/maidsh-core')) await fe.removePlugin('@api-demo/maidsh-core');
  });

  it('compares versions by number, not by text', () => {
    expect(fe.newerVersion('1.0.10', '1.0.9')).toBe(true);
    expect(fe.newerVersion('1.0.9', '1.0.10')).toBe(false);
    expect(fe.newerVersion('1.1.0', '1.1.0')).toBe(false);
    expect(fe.newerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(fe.newerVersion('1.0.1', '1.0.0-beta.1')).toBe(true);
  });

  it('an installed plugin with a newer market version has an update; updating pins the new engine version and keeps settings', async () => {
    market(engine('1.0.0'));
    await fe.installPlugin('@api-demo/maidsh-core');
    expect(bundles).toEqual(['maidsh-core@0.1.0']);
    await fe.setPluginOption('@api-demo/maidsh-core', 'slot:x#y', false);
    expect(fe.hasUpdate('@api-demo/maidsh-core')).toBe(false);
    market(engine('1.0.5')); // the hot-updated page brings the newer listing
    expect(fe.pluginUpdates.value).toEqual(['@api-demo/maidsh-core']);
    const r = await fe.updatePlugin('@api-demo/maidsh-core');
    expect(r.restart, 'DSH swapped it in place').toBe(false);
    expect(bundles.at(-1)).toBe('update maidsh-core@0.4.0');
    expect(onHost.get('maidsh-core')).toBe('0.4.0');
    expect(fe.hasUpdate('@api-demo/maidsh-core')).toBe(false);
    expect(fe.isOptionOn('@api-demo/maidsh-core', 'slot:x#y')).toBe(false);
    expect(fe.isEnabled('@api-demo/maidsh-core')).toBe(true);
  });

  it('official plugins update themselves once per version; a failure is retried when the engine comes back', async () => {
    market(engine('1.0.0'));
    await fe.installPlugin('@api-demo/maidsh-core');
    market(engine('1.0.5'));
    fail = true;
    expect((await fe.autoUpdatePlugins()).updated).toEqual([]);
    expect(fe.hasUpdate('@api-demo/maidsh-core')).toBe(true);
    const tries = bundles.length;
    await fe.autoUpdatePlugins();
    expect(bundles.length, 'not hammered while the engine is still away').toBe(tries);
    fail = false;
    const r = await fe.retryAutoUpdates();
    expect(r).toEqual({ updated: ['MaiDSH 总控'], restart: false });
    expect(fe.hasUpdate('@api-demo/maidsh-core')).toBe(false);
  });

  it('community plugins are only offered, never updated behind the user’s back', async () => {
    market(engine('1.0.0', 'maidsh-core', false));
    await fe.installPlugin('@api-demo/maidsh-core');
    market(engine('1.0.5', 'maidsh-core', false));
    expect((await fe.retryAutoUpdates()).updated).toEqual([]);
    expect(fe.hasUpdate('@api-demo/maidsh-core')).toBe(true);
  });

  it('a host without the engine half gets it installed; a host already on that version is left alone', async () => {
    market(engine('1.0.0'));
    await fe.installPlugin('@api-demo/maidsh-core');
    market(engine('1.0.5'));
    onHost.delete('maidsh-core'); // switched to a host that never had it
    await fe.updatePlugin('@api-demo/maidsh-core');
    expect(bundles.slice(-2)).toEqual(['update maidsh-core@0.4.0', 'maidsh-core@0.4.0']);
    // the page's record is older, but the host already has 0.4.0
    fe.installed.value = fe.installed.value.map((x) => (x.id === '@api-demo/maidsh-core' ? { ...x, version: '1.0.0' } : x));
    const r = await fe.updatePlugin('@api-demo/maidsh-core');
    expect(r.restart).toBe(false);
    expect(fe.hasUpdate('@api-demo/maidsh-core')).toBe(false);
  });
});
