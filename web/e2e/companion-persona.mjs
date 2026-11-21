// 陪伴跟着人设走（maidsh/CONTRACT.md §13.4, web/src/maidsh/profiles.ts）against the real MaiDSH
// plugins (maidsh-host.mjs) and a stand-in for the persona library's loopback API (as persona.mjs).
// Covers: the first sync gives the existing companion to the persona in use; another persona gets a
// fresh one; 不启用人设 gets its own; switching back finds the old one; the 陪伴 page reads the shown
// one; the 每个人设的陪伴 list can look at another one without switching.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { startMaidshHost } from './maidsh-host.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'shots', 'companion-persona');
mkdirSync(shots, { recursive: true });
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};

const host = await startMaidshHost();
const origin = new URL(host.url).origin;
const api = async (p, body) =>
  (await fetch(new URL(p, host.url), body ? { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) } : {})).json();
// TA already knows something (in the one 档案 there is before this change)
await api('/api/maidsh/learn', { textType: 'aboutme', title: '自我介绍', text: '我叫小林，在多伦多读计算机。喜欢下雨天在家看书。' });
for (let i = 0; i < 40 && (await api('/api/maidsh/jobs')).value.some((j) => j.status === 'running' || j.status === 'queued'); i++) await new Promise((r) => setTimeout(r, 200));
check((await api('/api/maidsh-memory/list')).value.facts.length === 2, 'seed: two facts in the default 档案');

const ALL = ['core', 'mood', 'bond', 'memory', 'expression', 'initiative'];
const VERSIONS = Object.fromEntries(JSON.parse(readFileSync(join(here, '..', '..', 'market', 'index.json'), 'utf8')).plugins.map((p) => [p.manifest.id, p.manifest.version]));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await ctx.addInitScript(
  ([all, versions]) => {
    localStorage.setItem(
      'api-demo:plugins',
      JSON.stringify([
        ...all.map((m) => ({ id: `@api-demo/maidsh-${m}`, enabled: true, version: versions[`@api-demo/maidsh-${m}`] ?? '1.0.0', setupDone: true })),
        { id: '@api-demo/persona-library', enabled: true, version: versions['@api-demo/persona-library'] ?? '1.0.0', setupDone: true },
      ]),
    );
    // the persona library: 大肥鱼 in use (sessionStorage keeps the choice across the reloads below)
    const builtins = [
      { id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼' },
      { id: 'acha', name: '阿茶', text: '# 人设：阿茶' },
    ];
    const saved = sessionStorage.getItem('persona-current');
    const store = { current: saved === null ? 'dafeiyu' : saved === '' ? null : saved };
    const snapshot = () => {
      const cur = builtins.find((p) => p.id === store.current);
      return {
        current: cur?.id ?? null,
        currentName: cur?.name ?? null,
        globalOff: store.current === null,
        personas: builtins.map((p) => ({ id: p.id, name: p.name, source: 'builtin', builtin: true, enabled: true, current: p.id === store.current, chars: p.text.length })),
      };
    };
    const real = window.fetch.bind(window);
    const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const m = /\/api\/dsh-persona-dafeiyu\/(status|persona|mutate)/.exec(url);
      if (!m) return real(input, init);
      if (m[1] === 'mutate') {
        const b = JSON.parse(init.body);
        if (b.action === 'set-current') store.current = b.id;
        sessionStorage.setItem('persona-current', store.current ?? '');
      }
      return json({ ok: true, value: snapshot() });
    };
  },
  [ALL, VERSIONS],
);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${n}.png`), fullPage: true });
const toastHas = (text) =>
  page.waitForSelector(`.toast:has-text(${JSON.stringify(text)})`, { timeout: 4000 }).then(
    () => true,
    () => false,
  );
const settings = async () => {
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(400);
};
const openCompanion = async () => {
  await settings();
  await page.click('.m-row:has-text("TA 的状态")');
  await page.waitForTimeout(900);
};
const scopeOfNew = async () => (await api('/api/maidsh/scope?sessionId=session-new')).value.profile;
const profiles = async () => (await api('/api/maidsh/profiles')).value;
const memoryTab = async () => {
  await page.click('.cp-tabs button:text-is("记忆")');
  await page.waitForTimeout(600);
  return page.textContent('.cp');
};

// 1. first start: the companion there is goes to 大肥鱼
await page.goto(`${host.url}#plain`);
check(await toastHas('原来的陪伴（记忆、心情、关系）归到了「大肥鱼」'), 'first start: the existing companion goes to the persona in use');
let v = await profiles();
check(v.profiles.length === 1 && v.profiles[0].persona === '大肥鱼' && v.profiles[0].name === '大肥鱼', 'engine: the default 档案 is linked to and named after 大肥鱼');
await page.waitForTimeout(1200);
await openCompanion();
check((await page.textContent('.cp-prof')).includes('「大肥鱼」的陪伴'), '陪伴: says whose companion this is');
check((await memoryTab()).includes('在多伦多读计算机'), '陪伴 › 记忆: 大肥鱼 keeps what TA knew');
await shot('1-dafeiyu');

// 2. switch to 阿茶: a fresh one
await page.reload();
await page.waitForTimeout(1200);
await settings();
await page.click('.m-row:has-text("人设")');
await page.waitForTimeout(600);
await page.click('.plg-row:has-text("阿茶")');
check(await toastHas('已启用「阿茶」。「阿茶」的陪伴是新的一份'), '人设: switching says 阿茶 starts fresh');
v = await profiles();
const acha = v.profiles.find((p) => p.persona === '阿茶');
check(!!acha && v.default === acha.id && (await scopeOfNew()) === acha.id, 'engine: new conversations now belong to 阿茶');
await page.reload();
await page.waitForTimeout(1200);
await openCompanion();
check((await page.textContent('.cp-prof')).includes('「阿茶」的陪伴'), '陪伴: now 阿茶');
let t = await memoryTab();
check(!t.includes('在多伦多读计算机'), '陪伴 › 记忆: 阿茶 does not know 大肥鱼’s things');
await shot('2-acha');

// 3. the list: look at 大肥鱼's without switching
await page.click('.cp-prof .plg-row');
await page.waitForTimeout(600);
const rows = await page.$$eval('.plg-row .plg-row-t', (e) => e.map((x) => x.textContent.trim()));
check(rows.some((r) => r.startsWith('大肥鱼')) && rows.some((r) => r.startsWith('阿茶') && r.includes('现在用的')), `list: both, 阿茶 in use (${rows.join(' / ')})`);
await shot('3-list');
await page.click('.plg-row:has-text("大肥鱼")');
await page.waitForTimeout(400);
await shot('4-sheet');
await page.click('.lo-opt:has-text("看这一份")');
await page.waitForTimeout(900);
t = await page.textContent('.cp');
check(t.includes('「大肥鱼」的陪伴') && t.includes('不是现在用的'), '陪伴: looking at 大肥鱼’s, marked as not in use');
check(t.includes('在多伦多读计算机'), '陪伴 › 记忆: reads 大肥鱼’s');
check((await profiles()).default === acha.id, 'engine: looking does not switch');
await shot('5-looking');

// 4. persona off: its own; back to 大肥鱼: the old one
await page.reload();
await page.waitForTimeout(1200);
await settings();
await page.click('.m-row:has-text("人设")');
await page.waitForTimeout(600);
await page.click('.plg-row:has-text("不启用人设")');
check(await toastHas('已关闭人设。没开人设时的陪伴是新的一份'), '人设 off: its own companion');
await page.waitForTimeout(300);
await page.click('.plg-row:has-text("大肥鱼")');
check(await toastHas('已启用「大肥鱼」。已切到「大肥鱼」的陪伴'), 'back to 大肥鱼: finds the old one');
v = await profiles();
check(v.default === 'default' && v.profiles.length === 3, `engine: back on the default 档案, three in all (${v.profiles.map((p) => p.name).join('、')})`);

await browser.close();
await host.stop();
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nall good');
process.exit(errors.length ? 1 : 0);
