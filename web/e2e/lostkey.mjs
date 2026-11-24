// The phone's copy of the DeepSeek key can go unreadable after a cold start (some ROMs lose the
// Keystore key when the app is cleared from recents) and dsh-Go's first run then asks for it again.
// setup/gate.tsx Connect looks in the engine's credential file first: a key there means no asking.
// The 复制排查信息 line tells where the key is. Runs the built prototype (npm run build:proto).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire(process.env.PW_NODE_MODULES ?? '/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'lostkey');
mkdirSync(shots, { recursive: true });
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });

async function run(saved) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  if (saved) await ctx.addInitScript(() => (window.__mockSeedCredentials = { DEEPSEEK_API_KEY: 'sk-saved-in-the-engine' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}#lost-key`);
  return page;
}

// 1. the engine still has the key: no asking, straight on
let page = await run(true);
await page.waitForTimeout(400);
const sawCheck = await page.isVisible('.eg :text("正在查找已保存的 Key")');
await page.waitForSelector('.toast:has-text("引擎里已经存着 API Key")', { timeout: 5000 }).catch(() => {});
check(await page.isVisible('.toast:has-text("引擎里已经存着 API Key")'), `saved: says the engine has it${sawCheck ? ' (looked first)' : ''}`);
await page.waitForTimeout(800);
check(!(await page.isVisible('.eg :text("连接 DeepSeek")')) && !(await page.isVisible('.eg :text("输入 API Key")')), 'saved: never asks for the key');
check(!(await page.isVisible('.eg')), 'saved: first run is done, the chat shows');
await page.screenshot({ path: join(shots, '1-saved.png') });
await page.context().close();

// 2. nothing in the engine either: asks, as before
page = await run(false);
await page.waitForSelector('.eg :text("连接 DeepSeek")', { timeout: 5000 }).catch(() => {});
check(await page.isVisible('.eg :text("连接 DeepSeek")'), 'nothing saved: asks for the key');
await page.screenshot({ path: join(shots, '2-ask.png') });
await page.click('.eg .plg-btn:has-text("使用 API Key")');
await page.fill('.eg input', 'sk-' + 'x'.repeat(32));
await page.click('.eg .plg-btn.pri:has-text("保存并继续")');
await page.waitForTimeout(1200);
check(!(await page.isVisible('.eg')), 'nothing saved: typing one carries on');
await page.context().close();

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nall good');
process.exit(errors.length ? 1 : 0);
