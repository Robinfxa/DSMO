// 设置 › 关于 › 界面更新, against a stand-in for the app's bridge: the version in
// use, a check that says what it found, and switching to the new page.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'webupdate');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
// The app's bridge, as far as these rows need it; `latest` is what the repository has.
await ctx.addInitScript(() => {
  const answers = {
    info: () => ({ appVersion: '0.3.0', webVersion: 'abc1234', hosts: [], nativePages: [], voice: false, notifications: false }),
    'webUpdate.check': () => new Promise((r) => setTimeout(() => r({ updated: window.__latest !== 'abc1234', latest: window.__latest, serving: 'abc1234' }), 600)),
    'webUpdate.apply': () => ((window.__applied = true), true),
  };
  window.__latest = 'abc1234';
  window.__calls = [];
  window.ApiDemoNative = {
    postMessage(text) {
      const { id, method } = JSON.parse(text);
      window.__calls.push(method);
      const fn = answers[method];
      Promise.resolve(fn ? fn() : null).then((v) => setTimeout(() => window.__apiDemo?.reply(id, true, v)));
    },
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const row = (label) => page.locator(`.m-row:has(.m-row-t:text-is("${label}"))`);

await page.goto(`${base}#plain`);
await page.waitForTimeout(1500);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(500);
await row('界面版本').scrollIntoViewIfNeeded();
check((await row('界面版本').textContent()).includes('abc1234'), 'shows the page version in use');
check(await row('检查 App 更新').isVisible(), 'APK update keeps its own row, named apart');

await row('检查界面更新').click();
await page.waitForTimeout(150);
check((await row('检查界面更新').textContent()).includes('正在检查'), 'says it is checking');
await page.waitForTimeout(900);
check((await row('检查界面更新').textContent()).includes('已是最新'), 'up to date');
await shot('01-latest');

await page.evaluate(() => (window.__latest = 'def5678'));
await row('检查界面更新').click();
await page.waitForTimeout(1200);
check(await row('使用新界面').isVisible(), 'a newer page: offers to use it');
check((await row('使用新界面').textContent()).includes('def5678'), 'names the new version');
await shot('02-ready');
await row('使用新界面').click();
await page.waitForTimeout(300);
check(await page.evaluate(() => window.__applied === true), 'switches to it');

// automatic: a downloaded page is switched to without asking, at a quiet moment
const leave = async () => {
  for (let i = 0; i < 4 && (await page.isVisible('[aria-label="返回"] >> nth=-1')); i++) {
    await page.click('[aria-label="返回"] >> nth=-1');
    await page.waitForTimeout(400);
  }
};
const ready = (v) => page.evaluate((v) => ((window.__applied = false), window.__apiDemo.event('webUpdate.ready', { version: v })), v);
const applied = () => page.evaluate(() => window.__applied === true);
await leave();
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
const title = (await page.textContent('.m-item .m-item-t >> nth=1')).trim();
await page.click('.m-item .m-item-t >> nth=1');
await page.waitForTimeout(800);

// typing: it waits
await page.fill('#input', '写到一半');
await ready('fed9876');
await page.waitForTimeout(4500);
check(!(await applied()), 'waits while something is typed');
check(!(await page.isVisible('.toast:has-text("界面有更新")')), 'no prompt');
await page.fill('#input', '');
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(2600);
check(await applied(), 'switches by itself once nothing is in the way');
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('api-demo:resume-after-update') || 'null'));
check(!!saved?.id, 'notes the open conversation first');

// the new page comes back to the same conversation
await page.reload();
await page.waitForTimeout(1800);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
check(((await page.textContent('.m-item.on .m-item-t').catch(() => '')) ?? '').trim() === title, `back in 「${title}」 after the switch`);
await page.click('[aria-label="打开边栏"]').catch(() => {});
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(300);

// in the background: at once, even with a draft (kept for the new page)
await page.evaluate(() => {
  const ta = document.querySelector('#input');
  ta && (ta.value = '后台时写的', ta.dispatchEvent(new Event('input', { bubbles: true })));
});
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await ready('a1b2c3d');
await page.waitForTimeout(800);
check(await applied(), 'in the background: switches at once');
check((await page.evaluate(() => JSON.parse(localStorage.getItem('api-demo:resume-after-update') || 'null')))?.draft === '后台时写的', 'the draft goes along');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('webupdate e2e ok', scheme);
