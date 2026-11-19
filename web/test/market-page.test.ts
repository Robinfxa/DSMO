// 插件 › 发现 with a big catalog: the overview stays short (3 per shelf, 全部 ›),
// a category shows everything in it, and search finds across all of them.
import { describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { catalogPlugins, type ApiDemoManifest } from '../src/plugins/frontend';
import { PluginsPage } from '../src/plugins/PluginsPage';

const kinds = ['skin', 'skill', 'schedule', 'slot'] as const;
const big: ApiDemoManifest[] = Array.from({ length: 30 }, (_, i) => ({
  v: 1,
  id: `@test/p${i}`,
  title: `插件 ${i}`,
  summary: i === 17 ? '把网页整理成摘要' : `第 ${i} 个`,
  version: '1.0.0',
  official: true,
  kinds: [kinds[i % 4]],
  permissions: [],
  ...(kinds[i % 4] === 'skill' ? { skills: [{ name: `s${i}`, files: { 'SKILL.md': 'x' } }] } : {}),
  ...(kinds[i % 4] === 'schedule' ? { schedules: [{ id: 't', title: `任务 ${i}`, prompt: 'x', timing: { kind: 'daily', time: '08:00' } }] } : {}),
  ...(kinds[i % 4] === 'slot' ? { slots: [{ slot: 'sider.features', id: 'x', title: `入口 ${i}`, action: { insert: 'x' } }] } : {}),
  ...(kinds[i % 4] === 'skin' ? { skin: { light: {} } } : {}),
})) as unknown as ApiDemoManifest[];

const titles = (el: HTMLElement) => [...el.querySelectorAll('.plg-group .plg-row-t')].map((e) => e.textContent);

describe('插件 › 发现', () => {
  it('keeps 30 plugins to a short page, and lets every one be reached', async () => {
    catalogPlugins.value = big;
    const el = document.createElement('div');
    document.body.append(el);
    await act(() => render(h(PluginsPage, {}), el));
    expect(titles(el)).toHaveLength(4 * 3); // four categories, three each
    const more = [...el.querySelectorAll<HTMLButtonElement>('.plg-more')];
    expect(more.map((b) => b.textContent)).toEqual(['全部 8', '全部 7', '全部 8', '全部 7']);
    await act(() => more[1].click()); // the second shelf
    expect(titles(el)).toHaveLength(7);
    expect(el.querySelector('.plg-chips [aria-selected="true"]')?.textContent).toBe('工具');

    const input = el.querySelector<HTMLInputElement>('.plg-find input')!;
    await act(() => {
      input.value = '摘要';
      input.dispatchEvent(new Event('input'));
    });
    expect(titles(el)).toEqual(['插件 17']);
    render(null, el);
  });
});
