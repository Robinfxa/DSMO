// Switching models (高级模式): for a new conversation, and inside one, the choice
// shows on the composer chip and in the picker, and the replies come from it.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'model');
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
const chip = () => page.textContent('.m-fn .m-chip');
const pick = async (name) => {
  await page.click('.m-fn .m-chip');
  await page.waitForTimeout(400);
  await page.click(`.opt-row:has-text("${name}")`);
  await page.waitForTimeout(500);
  const checked = await page.textContent('.opt-row[aria-checked="true"] .opt-label');
  await page.click('.p-close');
  await page.waitForTimeout(400);
  return checked;
};

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
// 高级模式 on
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('[aria-label="高级模式"]');
await page.waitForTimeout(300);
await page.click('[aria-label="返回"]');
await page.waitForTimeout(500);

// a new conversation
check((await pick('V4 Flash')) === 'V4 Flash', 'new chat: picker marks the choice');
check((await chip()).includes('Flash'), 'new chat: chip shows it');
await page.fill('#input', '你好');
await page.click('#sendBtn');
await page.waitForTimeout(3500);
check((await chip()).includes('Flash'), 'still Flash once the conversation exists');
await shot('01-new');

// inside the conversation: back to Pro, and the next reply comes from it
check((await pick('V4 Pro')) === 'V4 Pro', 'in chat: picker marks the choice');
check((await chip()).includes('Pro'), 'in chat: chip shows it');
await shot('02-switched');
await page.fill('#input', '再说一次');
await page.click('#sendBtn');
await page.waitForTimeout(3500);
check((await chip()).includes('Pro'), 'in chat: still Pro after the next turn');

// open it again: the switch was kept
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-item:not(.on) >> nth=0');
await page.waitForTimeout(700);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-item >> nth=0');
await page.waitForTimeout(900);
check((await chip()).includes('Pro'), 'reopened: Pro');
await shot('03-reopened');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('models e2e ok', scheme);
