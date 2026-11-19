import { describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { renderMarkdown } from '../src/ui/md';
import { PluginView } from '../src/plugins/view';
import { mergePatch } from '../src/plugins/DshGoPanel';
import { checkToken, validateManifest, HIDEABLE, type ApiDemoManifest } from '../src/plugins/frontend';
import { PANEL_READ_ENDPOINTS, buildSrcdoc } from '../src/plugins/panel';
// @ts-expect-error plain ESM module shared with the market scripts
import { checkManifest, tierOf } from '../../market/scripts/rules.mjs';

const base: ApiDemoManifest = { v: 1, id: '@x/p', title: 'P', summary: 's', version: '1.0.0', kinds: ['layout'], permissions: [] };

describe('markdown', () => {
  it('escapes HTML and only emits its own tags', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> **b** `<i>` [x](javascript:alert(1)) [ok](https://a.example)');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<code>&lt;i&gt;</code>');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('href="https://a.example"');
  });
  it('renders tables, lists and code fences', () => {
    const out = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y\n\n```js\nlet a = "<b>";\n```');
    expect(out).toContain('<table');
    expect(out).toContain('<ul><li>x</li><li>y</li></ul>');
    expect(out).toContain('data-lang="js"');
    expect(out).toContain('&lt;b&gt;');
  });
});

describe('hard rules: manifests', () => {
  it('rejects hiding protected zones and unknown keys', () => {
    expect(() => validateManifest({ ...base, layout: { hide: ['approval'] } })).toThrow();
    expect(() => validateManifest({ ...base, layout: { hide: ['composer.voice'] } })).not.toThrow();
    for (const k of HIDEABLE) expect(/approval|permission|login/.test(k)).toBe(false);
  });
  it('skins may only set design tokens with plain values', () => {
    expect(() => checkToken('--dsw-alias-bg-base', '#fff')).not.toThrow();
    expect(() => checkToken('display', 'none')).toThrow();
    expect(() => checkToken('--dsw-x', 'red; } .approval { display:none')).toThrow();
    expect(() => checkToken('--dsw-x', 'url(https://evil)')).toThrow();
  });
  it('entries cannot open protected pages', () => {
    expect(() => validateManifest({ ...base, kinds: ['slot'], slots: [{ slot: 'sider.features', id: 'a', title: 'a', action: { open: 'permission' } }] })).toThrow();
  });
  it('market rules catch an evil plugin', () => {
    const evil = {
      ...base,
      kinds: ['skin', 'panel'],
      skin: { css: '[data-protected] { display: none }' },
      panels: { p: { title: 'p', html: '<script src="https://evil.example/x.js"></script><script>parent.document.body.remove(); fetch("https://x")</script>' } },
      permissions: [],
    };
    const { errors } = checkManifest(evil);
    expect(errors.join('\n')).toMatch(/授权卡/);
    expect(errors.join('\n')).toMatch(/外部脚本/);
    expect(errors.join('\n')).toMatch(/沙箱外/);
    expect(errors.join('\n')).toMatch(/network/);
    expect(tierOf(evil)).toBe(2);
    expect(tierOf({ ...base, engine: { package: 'x', version: '1.0.0' } })).toBe(3);
  });
});

describe('sandboxed panels', () => {
  it('never exposes keys, approvals or permission changes', () => {
    for (const e of PANEL_READ_ENDPOINTS) expect(/credential|\$events|permission|commands|prompt|cancel/.test(e)).toBe(false);
  });
  it('blocks the network unless declared', () => {
    expect(buildSrcdoc('<p>x</p>', [])).toContain("default-src 'none'");
    expect(buildSrcdoc('<p>x</p>', [])).not.toContain('connect-src https:');
    expect(buildSrcdoc('<p>x</p>', ['network'])).toContain('connect-src https:');
  });
});

describe('dsh-Go plugin views', () => {
  it('renders bound data and degrades unknown nodes', () => {
    const el = document.createElement('div');
    const view = {
      type: 'stack',
      children: [
        { type: 'metric', label: '今日', value: { $: 'data.today' } },
        { type: 'list', items: { $: 'data.rows' } },
        { type: 'nope' },
        { type: 'chart', categories: ['a', 'b'], series: [{ values: { $: 'data.v' } }] },
      ],
    };
    render(h(PluginView, { view, data: { today: '¥3.1', rows: [{ title: 'r1', trailing: '1' }], v: [1, 2] }, onTap: () => {} }), el);
    expect(el.textContent).toContain('¥3.1');
    expect(el.textContent).toContain('r1');
    expect(el.textContent).toContain('这部分无法显示');
    expect(el.querySelectorAll('.pv-bar').length).toBe(2);
  });
  it('merge patch follows RFC 7396', () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { a: null, b: { c: 4 }, e: [1] })).toEqual({ b: { c: 4, d: 3 }, e: [1] });
  });
});

describe('plugin store pages', async () => {
  const fe = await import('../src/plugins/frontend');
  const meta = await import('../src/plugins/meta');
  const pv = await import('../src/plugins/preview');
  const { prefs } = await import('../src/state/store');

  it('derives user-facing categories from what a plugin declares', () => {
    expect(meta.categoryOf({ ...base, kinds: ['skin'] })).toBe('appearance');
    expect(meta.categoryOf({ ...base, kinds: ['layout'] })).toBe('interface');
    expect(meta.categoryOf({ ...base, kinds: ['slot', 'panel'] })).toBe('tools');
    expect(meta.categoryOf({ ...base, kinds: ['slot'], engine: { package: 'x', version: '1.0.0' } })).toBe('engine');
    expect(meta.categoryOf({ ...base, kinds: ['slot'], category: 'appearance' })).toBe('appearance');
  });

  it('lets single entries and hidden items be switched off on the 管理 page', async () => {
    const p: ApiDemoManifest = {
      ...base,
      id: '@x/opt',
      kinds: ['layout', 'slot'],
      layout: { hide: ['composer.voice', 'sider.features.phone'] },
      slots: [{ slot: 'composer.buttons', id: 'a', title: 'A', action: { insert: 'hi' } }],
    };
    fe.catalogPlugins.value = [...fe.catalogPlugins.value.filter((x) => x.id !== p.id), p];
    prefs.value = { ...prefs.value, advanced: true };
    await fe.installPlugin(p.id);
    expect(meta.optionsOf(p).map((o) => o.key)).toEqual(['slot:composer.buttons#a', 'hide:composer.voice', 'hide:sider.features.phone']);
    expect(fe.layoutHidden.value.has('composer.voice')).toBe(true);
    expect(fe.slotItems('composer.buttons').some((x) => x.title === 'A')).toBe(true);
    await fe.setPluginOption(p.id, 'hide:composer.voice', false);
    await fe.setPluginOption(p.id, 'slot:composer.buttons#a', false);
    expect(fe.layoutHidden.value.has('composer.voice')).toBe(false);
    expect(fe.layoutHidden.value.has('sider.features.phone')).toBe(true);
    expect(fe.slotItems('composer.buttons').some((x) => x.title === 'A')).toBe(false);
  });

  it('keeps panel data per plugin, measures and clears it, and uninstall removes it', async () => {
    await fe.pluginDataSet('@x/opt', 'note', 'abcd');
    expect(await fe.pluginDataSize('@x/opt')).toEqual({ items: 1, bytes: 8 });
    await fe.removePlugin('@x/opt');
    expect(fe.isInstalled('@x/opt')).toBe(false);
    expect(await fe.pluginDataSize('@x/opt')).toEqual({ items: 0, bytes: 0 });
    expect(await fe.pluginDataGet('@x/opt', 'note')).toBeNull();
  });

  it('maps web skin tokens onto the phone layout', () => {
    const t = fe.phoneTokens({ '--dsw-alias-bg-base': '#000', '--dsw-alias-brand-primary': '#0ff', '--m-bubble': '#123' });
    expect(t['--m-bg']).toBe('#000');
    expect(t['--m-accent']).toBe('#0ff');
    expect(t['--m-bubble']).toBe('#123');
    expect(() => checkToken('--m-bg', '#000')).not.toThrow();
  });

  it('scopes a skin’s custom CSS to the preview', () => {
    expect(pv.scopeCss('.md p, .bubble { color: red; }\n.greeting{x:y}', '.pv')).toBe('.pv .md p, .pv .bubble { color: red; }\n.pv .greeting {x:y}');
  });

  it('market rules accept store-page fields and reject bad ones', () => {
    expect(checkManifest({ ...base, description: 'd', highlights: ['a'], category: 'tools' }).errors).toEqual([]);
    expect(checkManifest({ ...base, category: 'games' }).errors.length).toBe(1);
    expect(checkManifest({ ...base, highlights: ['1', '2', '3', '4', '5', '6'] }).errors.length).toBe(1);
  });
});

describe('engine plugins: setup call', () => {
  const engine = (setup: unknown) =>
    ({ ...base, kinds: ['engine'], engine: { package: 'dsh-persona-dafeiyu', version: '0.8.0', setup } }) as unknown as ApiDemoManifest;
  it('may only reach the package’s own routes with a small JSON object', () => {
    expect(() => validateManifest(engine({ path: '/api/dsh-persona-dafeiyu/mutate', body: { action: 'set-current', id: null } }))).not.toThrow();
    for (const path of ['/api/credentials/set', '/api/dsh-persona-dafeiyu/../credentials/set', '/api/dsh-persona-dafeiyu/mutate?x=1', '/dsh-go/v1/invoke', 'https://evil.example/api/dsh-persona-dafeiyu/']) {
      expect(() => validateManifest(engine({ path, body: {} }))).toThrow();
    }
    expect(() => validateManifest(engine({ path: '/api/dsh-persona-dafeiyu/mutate', body: ['x'] }))).toThrow();
    expect(() => validateManifest(engine({ path: '/api/dsh-persona-dafeiyu/mutate', body: { t: 'x'.repeat(3000) } }))).toThrow();
  });
  it('the market rules say the same', () => {
    const m = (setup: unknown) => ({ ...base, kinds: ['engine'], engine: { package: 'dsh-persona-dafeiyu', version: '0.8.0', setup } });
    expect(checkManifest(m({ path: '/api/dsh-persona-dafeiyu/mutate', body: { action: 'set-current', id: null } })).errors).toEqual([]);
    expect(checkManifest(m({ path: '/api/credentials/set', body: {} })).errors.join()).toContain('engine.setup.path');
    expect(checkManifest(m({ path: '/api/dsh-persona-dafeiyu/mutate', body: {}, method: 'DELETE' })).errors.join()).toContain('engine.setup 不认识');
  });
});
