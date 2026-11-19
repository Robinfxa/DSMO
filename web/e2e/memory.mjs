// 设置 › 陪伴 › 长期记忆 (plugin 长期记忆, dsh-plugin-memory-share's memoryShare/* Remote):
// before the engine has the package, after installing it from the market, then edit and forget.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'memory');
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
page.on('console', (m) => m.type() === 'error' && !/memoryShare|unknown-endpoint/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const toastIs = (text) =>
  page.waitForSelector(`.toast:text-is(${JSON.stringify(text)})`, { timeout: 3000 }).then(
    () => true,
    () => false,
  );
const texts = (sec) => page.$$eval(`.plg-sec:has(.plg-sec-t:text-matches("^${sec}")) .mem-text`, (e) => e.map((x) => x.textContent));
const settings = async () => {
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(400);
};

// installed on the device, but not yet in the engine (or the engine not restarted)
{
  const c2 = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, colorScheme: scheme });
  await c2.addInitScript(() => localStorage.setItem('api-demo:plugins', JSON.stringify([{ id: '@api-demo/memory-share', enabled: true, version: '1.1.0', setupDone: true }])));
  const p2 = await c2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(`${base}#plain`);
  await p2.waitForTimeout(1200);
  await p2.click('[aria-label="打开边栏"]');
  await p2.waitForTimeout(400);
  await p2.click('.m-me [aria-label="设置"]');
  await p2.waitForTimeout(400);
  await p2.click('.m-row:has-text("长期记忆")');
  await p2.waitForTimeout(700);
  check(await p2.isVisible('text=还没装「长期记忆」插件'), 'engine without the package: says so');
  await c2.close();
}

// install from the market: the engine half goes onto the host, 设置 gets the entry
await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await settings();
await page.click('[aria-label="高级模式"]');
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(400);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-frow:has-text("插件")');
await page.waitForTimeout(600);
await page.click('.plg-row:has-text("长期记忆")');
await page.waitForTimeout(500);
await page.click('.plg-btn.pri.wide:has-text("安装")');
check(await toastIs('已安装「长期记忆」'), 'installed from the market');
for (let i = 0; i < 2; i++) {
  await page.click('[aria-label="返回"] >> nth=-1');
  await page.waitForTimeout(400);
}
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
check(await page.isVisible('.m-frow:has-text("长期记忆")'), 'sidebar entry (advanced mode)');
await page.click('.m-frow:has-text("长期记忆")');
await page.waitForTimeout(700);
check(JSON.stringify(await texts('关于你')) === JSON.stringify(['回答用中文，代码和注释用英文。', '用户叫小林，喜欢别人叫他林子。', '不吃香菜，喜欢辣。']), 'about you: 常驻 first, then the newest');
check((await texts('某个工作区')).length === 1, 'workspace memories in their own group');
check((await page.textContent('.plg-note.foot')).includes('/root/.dsh/memory-share/memories.json'), 'says where they are kept');
await shot('01-list');

// edit one
await page.click('.plg-row:has-text("不吃香菜")');
await page.waitForTimeout(450);
check((await page.textContent('.sk-field small')).includes('按话题'), 'shows where it is used');
await page.fill('.mem-edit', '不吃香菜和葱，喜欢辣。');
await page.click('.plg-btn.pri:has-text("保存")');
check(await toastIs('已保存'), 'saved');
await page.waitForTimeout(400);
check((await texts('关于你')).includes('不吃香菜和葱，喜欢辣。'), 'the list shows the change');
await shot('02-edited');

// forget one
await page.click('.plg-row:has-text("pnpm")');
await page.waitForTimeout(450);
await page.click('.plg-btn.danger');
await page.waitForTimeout(300);
await page.click('.m-alert-btns button >> nth=-1');
check(await toastIs('已忘掉'), 'forgotten');
await page.waitForTimeout(400);
check(!(await page.isVisible('.plg-sec-t:text-matches("^某个工作区")')), 'its group is gone with it');

// add: hands the AI a 「记住：」 line
await page.click('.plg-btn.wide:has-text("让它记住")');
await page.waitForTimeout(400);
check((await page.inputValue('#input')) === '记住：', '让它记住… puts 记住： in the input');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('memory e2e ok', scheme);
