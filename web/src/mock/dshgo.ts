// The dsh-go bridge as the prototype pretends it: the 用量 example plugin in the
// shape of dsh-Go's examples/plugins, answering the same routes. The host starts
// with nothing installed; the market's 今日用量 installs it (pluginManager/installBundle).
import type { DshGoTransport } from '../plugins/dshgo';

const USAGE = 'dsh-go-example-usage';
const hostInstalled = new Set<string>();
let hostRev = 1;
/** pluginManager/installBundle|removeBundle on the mock engine land here. */
export function mockHostBundle(spec: string, install: boolean) {
  const pkg = spec.replace(/@[^@/]+$/, '');
  if (pkg !== USAGE) throw new Error(`这台模拟主机上没有 ${pkg}`);
  install ? hostInstalled.add(pkg) : hostInstalled.delete(pkg);
  hostRev++;
}
export const mockHostBundles = () => [...hostInstalled];

let spent = 3.1;
let range = 'week';
const usageData = () => ({
  today: `¥${spent.toFixed(2)}`,
  quota: Math.min(100, Math.round((spent / 10) * 100)),
  range,
  days: range === 'week' ? ['一', '二', '三', '四', '五', '六', '日'] : ['第1周', '第2周', '第3周', '第4周'],
  values: range === 'week' ? [1.2, 2.0, 1.4, 0, 2.6, 3.1, spent] : [9.4, 12.1, 8.8, spent * 3],
  rows: [
    { title: 'deepseek-v4-pro', subtitle: '输入 1.2M · 输出 86K', trailing: '¥2.40' },
    { title: 'deepseek-flash', subtitle: '输入 820K · 输出 40K', trailing: '¥0.70' },
  ],
});

const VIEW = {
  v: 2,
  type: 'stack',
  title: '用量',
  children: [
    { type: 'row', children: [{ type: 'metric', label: '今日花费', value: { $: 'data.today' }, tone: 'good' }, { type: 'progress', label: '本月额度', value: { $: 'data.quota' } }] },
    { type: 'options', id: 'range', options: [{ label: '本周', value: 'week' }, { label: '本月', value: 'month' }], selected: { $: 'data.range' } },
    { type: 'chart', kind: 'bar', categories: { $: 'data.days' }, series: [{ name: '花费', values: { $: 'data.values' } }], unit: '元' },
    { type: 'list', items: { $: 'data.rows' } },
    { type: 'actions', items: [{ label: '刷新', action: 'refresh' }, { label: '把用量放进输入框', action: 'insert', style: 'primary' }] },
  ],
};

type ImportSink = (source: string, conversations: unknown[]) => Promise<Record<string, unknown>[]>;
let importSink: ImportSink | null = null;
/** The mock engine receives `/dsh-go/v1/sessions/import`; `#oldbridge` pretends a host without it. */
export const setMockSessionImport = (f: ImportSink) => (importSink = f);
const importable = () => !!importSink && !(typeof location !== 'undefined' && location.hash.includes('oldbridge'));

export const mockDshGo: DshGoTransport = {
  async get(path) {
    if (path === '/dsh-go/v1/sessions/import') return { status: 200, json: { supported: importable(), version: 1, format: 4 } };
    if (path === '/dsh-go/v1/contributions')
      return {
        status: 200,
        json: {
          v: 1,
          bridge: 'mock',
          rev: `r${hostRev}`,
          plugins: [
            hostInstalled.has(USAGE) && {
              pkg: 'dsh-go-example-usage',
              version: '1.0.0',
              title: { zh: '用量', en: 'Usage' },
              icon: 'chart',
              state: 'ok',
              contributes: {
                'composer.strip': [{ id: 'today', icon: 'chart', text: `今日用量 ¥${spent.toFixed(2)}`, panel: 'usage' }],
                panels: [{ id: 'usage', title: '用量', icon: 'chart', placement: ['features', 'session.tab'] }],
              },
            },
          ].filter(Boolean),
        },
      };
    if (path.startsWith('/dsh-go/v1/views/dsh-go-example-usage/usage') && hostInstalled.has(USAGE)) return { status: 200, json: { pkg: 'dsh-go-example-usage', id: 'usage', title: '用量', view: VIEW, data: usageData(), rev: '1' } };
    return { status: 404, json: { code: 'route-not-found', message: 'not found' } };
  },
  async post(path, body: any) {
    await new Promise((r) => setTimeout(r, 250));
    if (path === '/dsh-go/v1/sessions/import') {
      if (!importable()) return { status: 404, json: { error: { code: 'route-not-found', message: 'not found' } } };
      return { status: 200, json: { results: await importSink!(String(body.source), Array.isArray(body.conversations) ? body.conversations : []) } };
    }
    if (path !== '/dsh-go/v1/invoke') return { status: 404, json: {} };
    if (body.pkg === 'dsh-go-example-usage') {
      if (body.action === 'range') {
        range = body.value?.value ?? range;
        return { status: 200, json: { effects: [{ type: 'patch', data: usageData() }] } };
      }
      if (body.action === 'refresh') {
        spent += 0.05;
        return { status: 200, json: { effects: [{ type: 'refresh' }, { type: 'toast', text: '已刷新' }] } };
      }
      if (body.action === 'insert') return { status: 200, json: { effects: [{ type: 'insert', text: `今天模型花费 ¥${spent.toFixed(2)}。` }] } };
    }
    return { status: 200, json: { effects: [] } };
  },
};
