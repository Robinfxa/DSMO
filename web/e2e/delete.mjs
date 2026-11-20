// Deleting conversations. DSH's session/list still returns archived (deleted) ones, and the
// prototype's engine now does too, so the list must leave them out — also after it refreshes
// (删除所有历史对话 refreshes at once; a reconnect does the same in the app). Search too.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'delete');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
/** Opens [title] (its 更多 shows on the open one), then 更多 › 删除 › confirm. */
const del = async (title) => {
  await page.click(`.m-item:has-text("${title}") .m-item-t`);
  await page.waitForTimeout(600);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(500);
  await page.click(`.m-item.on [aria-label="更多"]`);
  await page.waitForTimeout(300);
  await page.click('.m-pop-row:has-text("删除")');
  await page.waitForTimeout(250);
  await page.click('.m-alert-btns button >> nth=-1');
};
const titles = () => page.$$eval('.m-item .m-item-t', (e) => e.map((x) => x.textContent.trim()));
const toastIs = (text) =>
  page.waitForSelector(`.toast:text-is(${JSON.stringify(text)})`, { timeout: 4000 }).then(
    () => true,
    () => false,
  );

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(500);
const before = await titles();
check(before.length >= 3, `the list has conversations (${before.length})`);
const victim = before[1];
const searchHits = async (q) => {
  await page.click('button.m-search');
  await page.waitForTimeout(500);
  await page.fill('.m-search.field input', q);
  await page.waitForTimeout(800);
  const hits = await page.$$eval('.m-hit', (e) => e.map((x) => x.textContent));
  await page.click('[aria-label="返回"] >> nth=-1').catch(() => {});
  await page.waitForTimeout(400);
  await page.click('[aria-label="打开边栏"]').catch(() => {});
  await page.waitForTimeout(500);
  return hits;
};
const query = victim.slice(0, 3);
check(
  (await searchHits(query)).some((h) => h.includes(victim)),
  `search finds 「${victim}」 before it is deleted`,
);

// delete one
await del(victim);
check(await toastIs('已删除对话'), 'deleted');
await page.waitForTimeout(400);
check(!(await titles()).includes(victim), 'gone from the list');

// undo brings it back; delete it again
await page.click('.toast .toast-act');
await page.waitForTimeout(500);
check((await titles()).includes(victim), 'undo brings it back');
await page.waitForTimeout(1800);
await page.click('[aria-label="打开边栏"]').catch(() => {});
await page.waitForTimeout(500);
await del(victim);
await page.waitForTimeout(2200);

// search doesn't find it any more (the engine's search returns archived ones too)
await page.click('[aria-label="打开边栏"]').catch(() => {});
await page.waitForTimeout(500);
check(!(await searchHits(query)).some((h) => h.includes(victim)), 'search leaves it out after');

// 设置 › 数据管理 › 删除所有历史对话: refreshes the list from the engine at once
await page.click('[aria-label="打开边栏"]').catch(() => {});
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('.m-row:has-text("数据管理")');
await page.waitForTimeout(400);
await page.click('.m-row:has-text("删除所有历史对话")');
await page.waitForTimeout(250);
await page.click('.m-alert-btns button >> nth=-1');
check(await toastIs('已删除全部对话'), 'deleted all');
await page.waitForTimeout(500);
for (let i = 0; i < 3; i++) {
  await page.click('[aria-label="返回"] >> nth=-1').catch(() => {});
  await page.waitForTimeout(300);
}
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(500);
const after = await titles();
check(after.length === 0, `the list stays empty after the engine is asked again (${after.join(', ')})`);
await shot('01-empty');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('delete e2e ok', scheme);
