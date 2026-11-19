// Round 4 on the phone: first run, the engine screens, safe mode, the DeepSeek account, the update offer.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 's');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const open = async (hash) => {
  await page.goto('about:blank');
  await page.goto(`${base}#${hash}`);
  await page.waitForTimeout(1200);
};
const tap = async (sel, ms = 500) => (await page.click(sel), await page.waitForTimeout(ms));

// ---- first run on this phone (fast unpack)
await open('first-run-fast');
await shot('00-welcome');
await tap('.eg .plg-btn.pri:has-text("开始")');
await shot('01-choice');
await tap('.eg-option:has-text("本机")', 200);
await tap('.eg .plg-btn.pri:has-text("继续")');
await shot('02-appearance');
await tap('.eg-theme:has-text("深色")', 300);
await shot('03-appearance-dark');
await tap('.eg-theme:has-text("跟随系统")', 200);
await tap('.eg .plg-btn.pri:has-text("继续")');
await shot('04-access');
await page.click('[role="switch"][aria-label="语音输入"]');
await tap('.eg .plg-btn.pri:has-text("开启所选")');
await shot('05-access-walk');
await tap('.eg .plg-row:has-text("允许使用麦克风")', 300);
await tap('.eg .plg-btn.pri');
await shot('06-connect');
await tap('.eg .plg-btn:has-text("使用 API Key")');
await page.fill('.eg input.sf-input', 'abc123');
await page.waitForTimeout(200);
await shot('07-key-warn');
if (await page.$('.eg .plg-btn:has-text("用 DeepSeek 账号登录")')) errors.push('account sign-in should be hidden');
await page.fill('.eg input.sf-input', 'sk-' + 'x'.repeat(32));
await tap('.eg .plg-btn.pri:has-text("保存并继续")', 900);
await shot('08-key-saved');
await page.waitForTimeout(4500);
const left = await page.$('.eg');
if (left) errors.push('first run did not finish: ' + (await left.textContent()).slice(0, 80));
await shot('09-home-after-setup');

// ---- remote host instead
await open('first-run');
await tap('.eg .plg-btn.pri:has-text("开始")');
await tap('.eg-option:has-text("远程主机")', 200);
await tap('.eg .plg-btn.pri:has-text("继续")', 700);
await shot('10-remote-hosts');
await tap('.plg-row:has-text("电脑")', 1500);
if (await page.$('.eg')) errors.push('choosing a remote host did not finish first run');
await shot('11-remote-home');

// ---- an engine that crashed
await open('engine-failed');
await shot('20-failed');
await tap('.eg .plg-btn:has-text("查看日志")', 700);
await shot('21-failure-log');
await tap('.pg-head [aria-label="返回"] >> nth=-1');
await tap('.eg .plg-btn:has-text("进入安全模式")', 500);
await shot('22-move-aside');
await tap('.m-alert-btns button >> nth=-1', 1600);
if (await page.$('.eg')) errors.push('safe mode start did not clear the gate');
await shot('23-safe-banner');
await tap('.eg-banner', 900);
await page.setViewportSize({ width: 360, height: 1500 });
await page.waitForTimeout(300);
await shot('24-engine-safe');
await page.setViewportSize({ width: 360, height: 780 });
await tap('.eg-card .plg-btn:has-text("恢复正常模式")', 400);
await tap('.m-alert-btns button >> nth=-1', 1600);
await shot('25-probation');

// ---- stopped engine
await open('plain');
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('[role="switch"][aria-label="高级模式"]').catch(() => {});
await tap('.m-row:has-text("本机引擎")', 700);
await tap('.plg-btn:has-text("停止")', 300);
await tap('.m-alert-btns button >> nth=-1', 1600);
await page.click('.pg-head [aria-label="返回"] >> nth=-1').catch(() => {});
await page.waitForTimeout(500);
await shot('30-stopped');
await tap('.eg .plg-btn.pri:has-text("启动引擎")', 1800);
if (await page.$('.eg')) errors.push('start engine did not clear the gate');

// ---- DeepSeek account sign-in is hidden (ACCOUNT_SIGN_IN)
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await tap('.m-row:has-text("账号管理")', 600);
await shot('40-account');
if (await page.$('.m-acc, .m-group-h:has-text("DeepSeek 账号")')) errors.push('account sign-in should be hidden in 账号管理');

// ---- the update offer
await open('update');
await page.waitForTimeout(6800);
await shot('50-update-toast');
const t = await page.textContent('.toast').catch(() => '');
if (!/新版本/.test(t ?? '')) errors.push('no update toast: ' + t);

await browser.close();
console.log(errors.length ? errors.join('\n') : 'no errors');
