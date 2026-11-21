// 全部功能 › 管理边栏功能区: switch rows of the sidebar's 「功能」 off and on (built-in ones and a
// plugin's entry), it sticks across a reload, 全部功能 always stays, and a row a layout plugin hides
// says so instead of offering a switch that does nothing. Phone and desktop.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { openFeats } from './feats.mjs';
import { serveProto } from './serve.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
// over http: the test reloads and needs localStorage to survive (e2e/serve.mjs)
const server = await serveProto();
const base = server.url;
const shots = join(here, 'shots', 'siderfeats');
mkdirSync(shots, { recursive: true });
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const versions = Object.fromEntries(
  ['index.json', 'examples.json'].flatMap((f) => JSON.parse(readFileSync(join(here, '..', '..', 'market', f), 'utf8')).plugins.map((p) => [p.manifest.id, p.manifest.version])),
);
const seed = ([v]) => {
  if (window !== window.top || localStorage.getItem('api-demo:plugins')) return;
  localStorage.setItem('api-demo:prefs', JSON.stringify({ advanced: true }));
  localStorage.setItem('api-demo:plugins', JSON.stringify([{ id: '@api-demo/quick-prompts', enabled: true, version: v['@api-demo/quick-prompts'], setupDone: true }]));
};
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

for (const mode of ['phone', 'desktop']) {
  const phone = mode === 'phone';
  const ctx = await browser.newContext(phone ? { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(seed, [versions]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
  const shot = (n) => page.screenshot({ path: join(shots, `${mode}-${n}.png`) });
  const ROW = phone ? '.m-feat-rows .m-frow' : '.feat-rows .row';
  const rows = async () => {
    // the drawer may already be open (then its button is covered)
    if (phone) await page.click('[aria-label="打开边栏"]', { timeout: 1500 }).then(() => page.waitForTimeout(400), () => {});
    await openFeats(page);
    return page.$$eval(ROW, (els) => els.map((e) => e.textContent.trim()));
  };
  const openManage = async () => {
    await page.click(`${ROW}:has-text("全部功能")`);
    await page.waitForTimeout(500);
    await page.click('.lrow:has-text("管理边栏功能区"), :text("管理边栏功能区")');
    await page.waitForTimeout(400);
  };
  const back = async () => (await page.click('[aria-label="返回"] >> nth=-1'), await page.waitForTimeout(350));

  await page.goto(`${base}#plain`);
  await page.waitForTimeout(1200);
  const before = await rows();
  check(['插件', '技能', '自动化任务', '手机操控', '常用提示词', '全部功能'].every((t) => before.some((r) => r.includes(t))), `${mode}: all rows to start: ${before.join(' / ')}`);
  await openManage();
  await shot('1-manage');
  check(await page.isVisible('[role="switch"][aria-label="在边栏显示常用提示词"]'), `${mode}: a plugin's entry is listed too`);
  check(await page.isDisabled('[role="switch"][aria-label="在边栏显示全部功能"]'), `${mode}: 全部功能 can't be switched off`);
  for (const t of ['技能', '手机操控', '常用提示词']) await page.click(`[role="switch"][aria-label="在边栏显示${t}"]`);
  await page.waitForTimeout(200);
  check((await page.getAttribute('[role="switch"][aria-label="在边栏显示技能"]', 'aria-checked')) === 'false', `${mode}: switched off`);
  await back();
  check((await page.textContent('body')).includes('3 个按钮没有显示'), `${mode}: 全部功能 says how many are off`);
  await back();
  const after = await rows();
  await shot('2-sidebar');
  check(!after.some((r) => /技能|手机操控|常用提示词/.test(r)) && after.some((r) => r.includes('插件')) && after.some((r) => r.includes('全部功能')), `${mode}: those rows gone, the rest stay: ${after.join(' / ')}`);

  // sticks across a reload
  await page.reload();
  await page.waitForTimeout(1200);
  const reloaded = await rows();
  check(!reloaded.some((r) => /技能|手机操控/.test(r)), `${mode}: still off after a reload`);

  // back on
  await openManage();
  await page.click('[role="switch"][aria-label="在边栏显示技能"]');
  await page.waitForTimeout(200);
  await back();
  await back();
  check((await rows()).some((r) => r.includes('技能')), `${mode}: switched back on`);

  // a layout plugin hides 手机操控: its row says so and can't be flipped here
  await page.evaluate((v) => {
    const list = JSON.parse(localStorage.getItem('api-demo:plugins'));
    list.push({ id: '@api-demo/layout-focus', enabled: true, version: v, setupDone: true });
    localStorage.setItem('api-demo:plugins', JSON.stringify(list));
  }, versions['@api-demo/layout-focus']);
  await page.reload();
  await page.waitForTimeout(1200);
  await rows();
  await openManage();
  const sw = '[role="switch"][aria-label="在边栏显示自动化任务"]';
  check((await page.isDisabled(sw)) && (await page.textContent('body')).includes('被插件「专注布局」藏起来了'), `${mode}: a row a layout plugin hides says which plugin`);
  await shot('3-layout');
  await ctx.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error('\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nsiderfeats ok');
