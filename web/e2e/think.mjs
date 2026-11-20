// 思考过程 starts collapsed (已思考 row only, tap to open); 设置 › 展开思考过程 brings back open-by-default.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'think');
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
const send = async (text) => {
  await page.fill('#input', text);
  await page.click('#sendBtn');
  await page.waitForSelector('.a-think', { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('.shimmer'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
};
const last = '.msg.assistant >> nth=-1';

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await page.click('button:has-text("深度思考")');
await send('为什么天空是蓝色的？');
const body = page.locator(`${last} >> .a-think-body`);
check((await body.getAttribute('class')).includes('closed'), 'thinking starts collapsed');
check((await page.textContent(`${last} >> .a-think-head`)).includes('已思考'), 'the 已思考 row is there');
check(await page.isVisible(`${last} >> .a-row[aria-expanded="false"]`), 'marked collapsed for screen readers');
await shot('01-collapsed');
await page.click(`${last} >> .a-think-head .a-row`);
await page.waitForTimeout(300);
check(!(await body.getAttribute('class')).includes('closed'), 'tap opens it');
await shot('02-opened');

// 设置 › 展开思考过程
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('[aria-label="展开思考过程"]');
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(400);
await send('再解释一下傍晚为什么是红色的');
check(!(await page.locator(`${last} >> .a-think-body`).getAttribute('class')).includes('closed'), 'with 展开思考过程 on, new replies start open');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('think e2e ok', scheme);
