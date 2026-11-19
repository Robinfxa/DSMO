// Round 6 on the phone: 手机操控 › 不打扰模式 (Shizuku, 自连 ADB pairing), 自动恢复无障碍,
// Android Shell, 操作记录; 识别方式 › 本机语音模型.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'ph');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
await page.goto(url + '#plain');
await page.waitForTimeout(900);
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const tall = async (n) => {
  const h = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.pg-body')].map((b) => b.scrollHeight), 780));
  await page.setViewportSize({ width: 360, height: Math.min(h + 70, 2600) });
  await page.waitForTimeout(250);
  await shot(n);
  await page.setViewportSize({ width: 360, height: 780 });
};
const wait = (ms) => page.waitForTimeout(ms);
const back = async () => (await page.click('[aria-label="返回"] >> nth=-1'), await wait(400));
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const text = () => page.textContent('.pg-body >> nth=-1');
const settings = async () => {
  await page.click('[aria-label="打开边栏"]');
  await wait(400);
  await page.click('.m-me [aria-label="设置"]');
  await wait(450);
};
const answer = async (value) => {
  await page.fill('.m-alert input.dlg-input', value);
  await page.click('.m-alert-btns button >> nth=-1');
  await wait(300);
};

// 手机操控 (advanced mode): turn it on, then the new rows
await settings();
await page.click('[role="switch"][aria-label="高级模式"]');
await wait(200);
await page.click('.m-row:has-text("手机操控")');
await wait(500);
await page.click('.plg-btn:has-text("继续")');
await wait(400);
await page.click('.plg-row:has-text("无障碍")');
await wait(800);
await page.click('[role="switch"][aria-label="手机操控"]');
await wait(3500);
await tall('00-phone');
check((await text()).includes('不打扰模式') && (await text()).includes('Android Shell'), 'phone page links the advanced pages');

// 不打扰模式: Shizuku → authorize → enable
await page.click('.plg-link:has-text("不打扰模式")');
await wait(600);
await tall('01-dnd');
await page.click('.plg-row:has-text("Shizuku")');
await wait(300);
check((await text()).includes('Shizuku 已在运行，还要给 DSMO 授权'), 'Shizuku: running, needs grant');
await page.click('.plg-btn:has-text("授权给 DSMO")');
await wait(700);
await page.click('.plg-btn:has-text("用 Shizuku 开启")');
await wait(900);
await tall('02-dnd-shizuku');
check((await text()).includes('正在使用：Shizuku'), 'Shizuku in use');
// 自连 ADB under 更换连接方式: pairing by hand
await page.click('.plg-fold:has-text("更换连接方式")');
await wait(200);
await page.click('.plg-row:has-text("自连 ADB")');
await wait(200);
await page.click('.plg-fold:has-text("配对帮助")');
await wait(200);
await page.click('.dnd-panel .plg-btn:has-text("手动填写")');
await wait(300);
await answer('123456');
await answer('37123');
await wait(900);
await tall('03-dnd-adb-paired');
check((await text()).includes('配对成功，点「连接」'), 'ADB paired');
await back();

// 自动恢复无障碍
await page.click('.plg-link:has-text("自动恢复无障碍")');
await wait(500);
await page.click('.plg-btn.pri');
await wait(900);
await tall('04-a11y-restore');
check((await text()).includes('已开启'), 'a11y restore granted');
await back();

// Android Shell
await page.click('.plg-link:has-text("Android Shell")');
await wait(600);
await page.click('[role="switch"][aria-label="允许 Android Shell"]');
await wait(300);
await page.click('.m-alert-btns button >> nth=-1');
await wait(700);
await page.click('.plg-link:has-text("连接所选通道")');
await wait(1000);
await tall('05-shell');
check((await text()).includes('已连接'), 'Android Shell connected');
await back();

// 操作记录
await page.click('.plg-link:has-text("操作记录")');
await wait(500);
await shot('06-log');
check((await text()).includes('已拦下'), 'log lists decisions');
await back();
await back();

// 识别方式 › 本机语音模型
await settings();
await page.click('.m-row:has-text("识别方式")');
await wait(500);
await tall('07-voice');
await page.click('.plg-btn.pri:has-text("下载")');
await wait(1200);
await shot('08-voice-downloading');
await wait(3800);
await tall('09-voice-ready');
check((await text()).includes('已就绪'), 'voice model ready');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('phone e2e ok', scheme);
