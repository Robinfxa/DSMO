// 长期记忆 moved to our fork dsmo-memory-share (forks/memory-share): updating from 1.1.1 removes the
// old dsh-plugin-memory-share from the host before installing the fork (engine.replaces), and the
// memories carry over; uninstalling removes the package and, if asked, what it remembered.
// Runs the built prototype (npm run build:proto); the mock host starts with the old package
// (window.__mockSeedBundles).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'memory-fork');
mkdirSync(shots, { recursive: true });
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const ID = '@api-demo/memory-share';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await ctx.addInitScript((id) => {
  window.__mockSeedBundles = ['dsh-plugin-memory-share@0.6.0'];
  localStorage.setItem('api-demo:plugins', JSON.stringify([{ id, enabled: true, version: '1.1.1', setupDone: true }]));
}, ID);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: join(shots, `${n}.png`) });
const rpc = (method, args = {}) => page.evaluate(([m, a]) => window.__mockEngine.rpc.call(m, a).catch((e) => ({ error: String(e.message || e) })), [method, args]);
const bundles = async () => ((await rpc('pluginManager/listBundles')) || []).filter((b) => b.installed).map((b) => `${b.name}@${b.version}`);
const installedVersion = () => page.evaluate((id) => JSON.parse(localStorage.getItem('api-demo:plugins') ?? '[]').find((x) => x.id === id)?.version ?? null, ID);
const toastHas = (text) =>
  page.waitForSelector(`.toast:has-text(${JSON.stringify(text)})`, { timeout: 5000 }).then(
    () => true,
    () => false,
  );

await page.goto(url);
await page.waitForTimeout(1500);
check((await bundles()).includes('dsh-plugin-memory-share@0.6.0'), 'start: the host has the old package');
const before = (await rpc('memoryShare/list')).entries?.length ?? 0;
check(before > 0, `start: memories (${before})`);

// 1. update to 1.2.0: official plugins update themselves; otherwise press 更新 on its page
for (let i = 0; i < 20 && (await installedVersion()) !== '1.2.1'; i++) await page.waitForTimeout(300);
if ((await installedVersion()) !== '1.2.1') {
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(450);
  if ((await page.getAttribute('[role="switch"][aria-label="高级模式"]', 'aria-checked')) !== 'true') await page.click('[role="switch"][aria-label="高级模式"]');
  await page.getByText('插件', { exact: true }).click();
  await page.waitForTimeout(500);
  await page.click('.plg-seg button:has-text("已安装")');
  await page.waitForTimeout(300);
  await page.click('.plg-row:not(.static):has-text("长期记忆")');
  await page.waitForTimeout(600);
  await page.click('.plg-btn:has-text("更新")');
  for (let i = 0; i < 20 && (await installedVersion()) !== '1.2.1'; i++) await page.waitForTimeout(300);
}
check((await installedVersion()) === '1.2.1', '长期记忆 is at 1.2.1');
let b = await bundles();
check(b.includes('dsmo-memory-share@0.6.2'), `the fork is installed (${b.filter((x) => /memory/.test(x)).join(', ')})`);
check(!b.some((x) => x.startsWith('dsh-plugin-memory-share@')), 'the old package is gone from the host');
check(((await rpc('memoryShare/list')).entries?.length ?? 0) === before, 'memories carried over');

// 2. uninstall, deleting what it remembered
await page.goto(url);
await page.waitForTimeout(1200);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(450);
if ((await page.getAttribute('[role="switch"][aria-label="高级模式"]', 'aria-checked')) !== 'true') await page.click('[role="switch"][aria-label="高级模式"]');
await page.getByText('插件', { exact: true }).click();
await page.waitForTimeout(500);
await page.click('.plg-seg button:has-text("已安装")');
await page.waitForTimeout(300);
await page.click('.plg-row:not(.static):has-text("长期记忆")');
await page.waitForTimeout(600);
await page.click('.plg-btn:has-text("管理")');
await page.waitForTimeout(400);
await page.click('.plg-link:has-text("卸载插件")');
await page.waitForSelector(`.lo-opt:has-text("也删掉它记住的 ${before} 件事")`, { timeout: 4000 }).catch(() => {});
check(await page.isVisible(`.lo-opt:has-text("也删掉它记住的 ${before} 件事")`) && (await page.isVisible('.lo-opt:has-text("卸载，保留记忆")')), 'uninstall offers: delete what it remembered, or keep it');
await shot('1-ask-data');
// closing the sheet keeps everything
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
if (await page.isVisible('.lo-opt')) await page.mouse.click(180, 80);
await page.waitForTimeout(400);
check((await installedVersion()) === '1.2.1' && (await bundles()).includes('dsmo-memory-share@0.6.2'), 'closing the sheet uninstalls nothing');
await page.click('.plg-link:has-text("卸载插件")');
await page.waitForSelector('.lo-opt', { timeout: 4000 });
const toasts = [];
page.on('console', () => {});
const watch = setInterval(async () => { const t = await page.textContent('.toast').catch(() => null); if (t && !toasts.includes(t)) toasts.push(t); }, 150);
await page.click(`.lo-opt:has-text("也删掉它记住的 ${before} 件事")`);
const ok = await toastHas('已卸载「长期记忆」');
clearInterval(watch);
check(ok, `uninstalled (toasts: ${toasts.join(' | ')})`);
b = await bundles();
check(!b.some((x) => /memory-share/.test(x)), 'neither package is on the host');
check((await installedVersion()) === null, 'gone from DSMO');
// put the package back: nothing remembered any more
await rpc('pluginManager/installBundle', { spec: 'dsmo-memory-share@0.6.2' });
check(((await rpc('memoryShare/list')).entries?.length ?? -1) === 0, 'its memories were deleted');

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nall good');
process.exit(errors.length ? 1 : 0);
