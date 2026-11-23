// Uninstalling a plugin with an engine half (plugins/frontend.ts removePlugin): the dialog says the
// engine's stored data stays; when the engine refuses (window.__mockRemoveFail = a ManagementFailure
// code) nothing changes and the reason shows, with 「只从 DSMO 移除」 as a way out; when it agrees,
// the plugin goes. Runs the built prototype (npm run build:proto).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'uninstall');
mkdirSync(shots, { recursive: true });
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const ID = '@api-demo/usage-today';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await ctx.addInitScript((id) => {
  if (!sessionStorage.getItem('seeded')) {
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('api-demo:plugins', JSON.stringify([{ id, enabled: true, version: '1.0.0', setupDone: true }]));
  }
}, ID);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: join(shots, `${n}.png`) });
const installed = () => page.evaluate((id) => JSON.parse(localStorage.getItem('api-demo:plugins') ?? '[]').some((x) => x.id === id), ID);
const toastHas = (text) =>
  page.waitForSelector(`.toast:has-text(${JSON.stringify(text)})`, { timeout: 4000 }).then(
    () => true,
    () => false,
  );

async function openUninstall() {
  await page.goto(url);
  await page.waitForTimeout(900);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(450);
  if ((await page.getAttribute('[role="switch"][aria-label="高级模式"]', 'aria-checked')) !== 'true') await page.click('[role="switch"][aria-label="高级模式"]');
  await page.getByText('插件', { exact: true }).click();
  await page.waitForTimeout(500);
  await page.click('.plg-seg button:has-text("已安装")');
  await page.waitForTimeout(300);
  await page.click('.plg-row:has-text("今日用量")');
  await page.waitForTimeout(600);
  await page.click('.plg-btn:has-text("管理")');
  await page.waitForTimeout(400);
  await page.click('.plg-link:has-text("卸载插件")');
  await page.waitForTimeout(350);
}

// 1. the engine refuses: nothing changes, the reason shows
await openUninstall();
const body = await page.textContent('.m-alert');
check(body.includes('在引擎里存的东西') && body.includes('会留着'), 'dialog: the engine’s stored data stays');
await shot('1-confirm');
await page.evaluate(() => (window.__mockRemoveFail = 'bundle-in-use'));
await page.click('.m-alert-btns button >> nth=-1');
await page.waitForSelector('.m-alert:has-text("引擎里没卸掉")', { timeout: 4000 }).catch(() => {});
const refused = (await page.textContent('.m-alert:has-text("引擎里没卸掉")').catch(() => '')) ?? '';
check(!(await page.isVisible('.toast:has-text("正在卸载")')), 'refused: the 正在卸载 toast is gone');
check(refused.includes('引擎里没卸掉') && refused.includes('插件正在被使用'), 'refused: says why');
check(await installed(), 'refused: still installed in DSMO');
await shot('2-refused');

// 2. 只从 DSMO 移除
await page.click('.m-alert-btns button:has-text("只从 DSMO 移除")');
check(await toastHas('已从 DSMO 移除「今日用量」，引擎里的还在'), 'force: says the engine keeps it');
check(!(await installed()), 'force: gone from DSMO');

// 3. the engine agrees
await page.evaluate((id) => localStorage.setItem('api-demo:plugins', JSON.stringify([{ id, enabled: true, version: '1.0.0', setupDone: true }])), ID);
await openUninstall();
await page.evaluate(() => (window.__mockRemoveFail = ''));
await page.click('.m-alert-btns button >> nth=-1');
check(await toastHas('已卸载「今日用量」'), 'agreed: uninstalled');
check(!(await installed()), 'agreed: gone');

// 4. an engine like the phone's (no live recomposition) refuses to remove a running plugin
// (stop-profile): DSMO switches it off, offers the restart, and finishes after the engine is back
const PKG = 'dsh-go-example-usage';
const rpc = (method, args = {}) => page.evaluate(([m, a]) => window.__mockEngine.rpc.call(m, a).catch((e) => ({ error: String(e.message || e) })), [method, args]);
const onHost = async () => ((await rpc('pluginManager/listBundles')) || []).some((b) => b.name === PKG && b.installed !== false);
const pending = () => page.evaluate(() => localStorage.getItem('api-demo:engine-removals'));
await page.evaluate((id) => localStorage.setItem('api-demo:plugins', JSON.stringify([{ id, enabled: true, version: '1.0.0', setupDone: true }])), ID);
await openUninstall();
await rpc('pluginManager/installBundle', { spec: `${PKG}@0.1.0` });
await page.evaluate(() => (window.__mockRemoveFail = 'stop-profile'));
await page.click('.m-alert-btns button >> nth=-1');
await page.waitForSelector('.m-alert:has-text("已卸载「今日用量」")', { timeout: 4000 }).catch(() => {});
const restartAsk = (await page.textContent('.m-alert:has-text("已卸载「今日用量」")').catch(() => '')) ?? '';
check(restartAsk.includes('重启后才完全停下') && (await page.isVisible('.m-alert-btns button:has-text("重启引擎")')), `refused while running: switched off, offers the restart (${restartAsk.slice(0, 40)})`);
check(!(await page.isVisible('.toast:has-text("正在卸载")')), 'refused while running: the 正在卸载 toast is gone');
await shot('3-restart');
check(!(await installed()), 'refused while running: gone from DSMO');
check((await pending())?.includes(PKG), 'refused while running: removal waits for the restart');
await page.click('.m-alert-btns button:has-text("取消")');
// the engine is back (here: the page starts again with removals allowed)
await page.evaluate(() => (window.__mockRemoveFail = ''));
await page.reload();
await page.waitForTimeout(2500);
check(!(await onHost()) && !(await pending()), 'after the restart: removed from the engine, nothing left waiting');

// 5. a plugin uninstalled by an older DSMO that the engine still runs: 已安装 offers to remove it
await page.goto(url);
await page.waitForTimeout(900);
await rpc('pluginManager/installBundle', { spec: `${PKG}@0.1.0` });
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(450);
if ((await page.getAttribute('[role="switch"][aria-label="高级模式"]', 'aria-checked')) !== 'true') await page.click('[role="switch"][aria-label="高级模式"]');
await page.getByText('插件', { exact: true }).click();
await page.waitForTimeout(500);
await page.click('.plg-seg button:has-text("已安装")');
await page.waitForTimeout(800);
check(await page.isVisible('.plg-row:has-text("「今日用量」没卸干净")'), 'stray: 已安装 says it was not fully uninstalled');
await shot('4-stray');
await page.click('.plg-row:has-text("没卸干净") .plg-get');
check(await toastHas('已卸载「今日用量」'), 'stray: removed');
check(!(await onHost()), 'stray: gone from the engine');

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nall good');
process.exit(errors.length ? 1 : 0);
