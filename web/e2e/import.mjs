// 导入历史对话 straight into the conversation list (dsh-go-bridge session import, mocked):
// preview, progress, the imported chats in the list with their old dates, the chat's
// 「从 DeepSeek 导入」 note, a second import that skips, and moving on-device copies over.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'i');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const tap = async (sel, ms = 450) => (await page.click(sel), await page.waitForTimeout(ms));
const fixtures = ['deepseek-conversations.json', 'chatgpt-conversations.json'].map((f) => join(here, '..', 'test', 'fixtures', f));
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const toData = async () => {
  await tap('[aria-label="打开边栏"]', 400);
  await tap('.m-me [aria-label="设置"]');
  await tap('.m-row:has-text("数据管理")', 400);
};
const pick = async (files) => {
  const chooser = page.waitForEvent('filechooser');
  await page.click('.m-row:has-text("导入历史对话")');
  await (await chooser).setFiles(files);
  await page.waitForTimeout(600);
};

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await toData();
await shot('00-data');
await pick(fixtures);
const body = await page.textContent('.m-alert');
check(/导入 3 个对话/.test(body) && /2026/.test(body) && /对话列表/.test(body), 'preview names count, dates and destination');
await shot('01-confirm');
await tap('.m-alert-btns button >> nth=-1', 150);
await shot('02-progress');
await page.waitForSelector('.imp-run-t:has-text("导入完成")', { timeout: 8000 });
check((await page.textContent('.imp-run')).includes('已导入 3'), 'all three imported');
await shot('03-done');
await tap('.plg-btn.pri:has-text("查看对话")', 700);
await shot('04-list');
check(await page.isVisible('text=周末去哪玩'), 'imported chat in the list');
await tap('.m-item-t:has-text("周末去哪玩")', 1200);
check(await page.isVisible('.imported-note:has-text("从 DeepSeek 导入")'), 'chat says where it came from');
check(await page.isVisible('text=考虑老人体力') || (await page.content()).includes('考虑老人体力'), 'reasoning kept');
await shot('05-chat');

// again: everything skips
await toData();
await pick(fixtures);
check((await page.textContent('.m-alert')).includes('3 个之前导入过'), 'preview spots earlier imports');
await tap('.m-alert-btns button >> nth=-1', 150);
await page.waitForSelector('.imp-run-t:has-text("导入完成")', { timeout: 8000 });
check((await page.textContent('.imp-run')).includes('跳过 3 个'), 'second import skips');
await shot('06-skipped');
await tap('.plg-btn.pri:has-text("完成")', 500);

// an older bridge keeps them on this device; once it can, move them into the list
await page.evaluate(() => history.replaceState(null, '', location.href.split('#')[0] + '#plain-oldbridge'));
await page.goto(`${base}#plain-oldbridge`);
await page.waitForTimeout(1200);
await toData();
await pick([fixtures[0]]);
check((await page.textContent('.m-alert')).includes('这台设备上'), 'older host: kept on this device');
await tap('.m-alert-btns button >> nth=-1', 600);
await shot('07-old-data');
await page.evaluate(() => history.replaceState(null, '', location.href.split('#')[0] + '#plain'));
await tap('.m-row:has-text("保存在这台设备上的对话")', 700);
check(await page.isVisible('.plg-link:has-text("全部转入对话列表")'), 'offer to move them');
await shot('08-local-list');
await tap('.plg-link:has-text("全部转入对话列表")', 500);
await tap('.m-alert-btns button >> nth=-1', 150);
await page.waitForSelector('.imp-run-t:has-text("导入完成")', { timeout: 8000 });
await shot('09-moved');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('import e2e ok', scheme);
