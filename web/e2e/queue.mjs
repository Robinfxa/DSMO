// 插件 › 发现: tapping 获取 on several plugins in a row queues them (one installs at a time, the rest
// say 等待中), and leaving the market and coming back doesn't make them tappable again. Engine
// installs are slowed down (window.__mockInstallMs) the way a real host's npm install is.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'queue');
mkdirSync(shots, { recursive: true });
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => (window.__mockInstallMs = 2500));
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${n}.png`) });
const get = (title) => page.locator(`.plg-row:has(.plg-row-t:text-is("${title}")) .plg-get`).first();
const label = async (title) => ((await get(title).textContent()) ?? '').trim();
const showRow = async (title) => (await page.fill('.plg-find input', title), await page.waitForTimeout(250));
const toasts = [];
await page.exposeFunction('__toast', (t) => toasts.push(t));

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await page.evaluate(() =>
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast') && window.__toast(n.textContent)))).observe(document.body, { childList: true, subtree: true }),
);
const openMarket = async () => {
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(400);
  if (!(await page.isVisible('.m-row:has-text("插件")'))) {
    await page.click('[aria-label="高级模式"]');
    await page.waitForTimeout(300);
  }
  await page.click('.m-row:has-text("插件") >> nth=-1');
  await page.waitForTimeout(600);
};
await openMarket();
await page.click('.plg-chips button:has-text("引擎")');
await page.waitForTimeout(300);

// three in a row, the first one twice
for (const t of ['今日用量', '今日用量', 'MaiDSH 羁绊', '长期记忆']) {
  await get(t).click({ force: true });
  await page.waitForTimeout(60);
  // 长期记忆 also writes where DS Bot does: say yes
  if (await page.isVisible('.m-alert')) {
    await page.click('.m-alert-btns button:has-text("仍然安装")');
    await page.waitForTimeout(60);
  }
}
await page.waitForTimeout(250);
const states = [await label('今日用量'), await label('MaiDSH 羁绊'), await label('长期记忆')];
check(JSON.stringify(states) === JSON.stringify(['安装中', '等待中', '等待中']), `one installs, the rest wait: ${states.join(' ')}`);
check(await get('MaiDSH 羁绊').isDisabled(), 'a waiting one can’t be tapped again');
await shot('1-queued');

// one that clashes with a queued one asks first, even though that one isn't installed yet
await get('MaiDSH 记忆').click();
await page.waitForTimeout(300);
const ask = (await page.isVisible('.m-alert')) ? await page.getAttribute('.m-alert', 'aria-label') : '';
check(ask.includes('「长期记忆」'), `a clash with a queued plugin is asked about: ${ask}`);
if (ask) await page.click('.m-alert-btns button:has-text("取消")');
await page.waitForTimeout(300);

// leave the market and come back: still busy, still not tappable
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(400);
check(!(await page.isVisible('.plg-get')), 'left the market');
await openMarket();
await page.click('.plg-chips button:has-text("引擎")');
await page.waitForTimeout(300);
const again = [await label('今日用量'), await label('MaiDSH 羁绊'), await label('长期记忆')];
check(again.every((x) => x === '安装中' || x === '等待中' || x === '已安装') && again.some((x) => x !== '已安装'), `back on the market: ${again.join(' ')}`);
check(!(await get('长期记忆').isEnabled()), '长期记忆 still not tappable');
await shot('2-back');

// the detail page shows the same state
await page.click('.plg-row:has(.plg-row-t:text-is("长期记忆"))');
await page.waitForTimeout(300);
const detail = ((await page.textContent('.plg-actions')) ?? '').trim();
check(/等待中|正在安装/.test(detail) && (await page.isDisabled('.plg-btn.pri.wide')), `detail page: ${detail}`);
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(300);

// all three land, each once
await page.waitForFunction(() => JSON.parse(localStorage.getItem('api-demo:plugins') || '[]').length >= 3, null, { timeout: 15000 });
await page.waitForTimeout(600);
const list = await page.evaluate(() => JSON.parse(localStorage.getItem('api-demo:plugins')).map((x) => x.id));
check(list.length === 3 && new Set(list).size === 3, `installed once each: ${list.join(' ')}`);
const done = [await label('今日用量'), await label('MaiDSH 羁绊'), await label('长期记忆')];
check(done.every((x) => x === '已安装'), `all 已安装: ${done.join(' ')}`);
check(toasts.filter((t) => t.includes('已安装「今日用量」')).length === 1, `one toast for the double tap: ${toasts.join(' | ')}`);
await shot('3-done');

await browser.close();
if (errors.length) {
  console.error('\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nqueue ok');
