// 使用说明 (manifest guide): the detail page's 怎么用, the full guide page (tips, questions, a button
// that takes you there), the 怎么用 on the 已安装 toast, and the row on 管理. Every listed plugin has one.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'guide');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const market = JSON.parse(readFileSync(join(here, '..', '..', 'market', 'index.json'), 'utf8')).plugins.map((p) => p.manifest);
check(market.every((m) => m.guide && m.guide.steps.length >= 2 && m.guide.where), `every listed plugin has a guide (${market.length})`);

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const back = async () => (await page.click('[aria-label="返回"] >> nth=-1'), await page.waitForTimeout(350));
const find = async (q) => (await page.fill('.plg-find input', q), await page.waitForTimeout(250));

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('[aria-label="高级模式"]');
await page.waitForTimeout(300);
await page.click('.m-row:has-text("插件") >> nth=-1');
await page.waitForTimeout(700);

// detail page: 使用说明 right under the 安装 / 已安装 row, the whole guide inline
await find('人设库');
await page.click('.plg-row:has-text("人设库")');
await page.waitForTimeout(500);
const persona = market.find((m) => m.title === '人设库').guide;
const order = await page.$$eval('.plg-detail > *', (els) => els.map((e) => e.className));
const ai = order.findIndex((c) => c.includes('plg-actions'));
const gi = order.findIndex((c) => c.includes('plg-guide-sec'));
check(ai >= 0 && gi > ai && order.slice(ai + 1, gi).every((c) => c.includes('plg-note')), `detail: 使用说明 directly under the actions (${order.slice(ai, gi + 1).join(' | ')})`);
check((await page.textContent('.plg-guide-sec .plg-sec-t')) === '使用说明', 'detail: titled 使用说明');
check((await page.textContent('.plg-guide-where')).includes('设置 › 陪伴 › 人设'), 'detail: where it is');
check((await page.$$('.plg-guide .plg-step')).length === persona.steps.length, `detail: ${persona.steps.length} steps`);
check((await page.textContent('.plg-step-t >> nth=0')) === persona.steps[0].title, 'detail: step titles in order');
check(!(await page.isVisible('.plg-guide-try')), 'not installed: no 打开 button');
check((await page.$$('.plg-faq-i')).length === persona.faq.length, 'detail: questions inline');
check(!(await page.isVisible('.plg-faq-a')), 'answers folded');
await page.click('.plg-faq-q:has-text("DS Bot")');
await page.waitForTimeout(200);
check((await page.textContent('.plg-faq-a')).includes('Bot 的对话里不用人设'), 'a question opens its answer');
await shot('1-detail');
await page.locator('.plg-faq').scrollIntoViewIfNeeded();
await shot('2-detail-faq');
await back();

// install from the list: the toast offers 怎么用
await find('常用提示词');
await page.click('.plg-row:has(.plg-row-t:text-is("常用提示词")) .plg-get');
await page.waitForSelector('.toast:has-text("已安装「常用提示词」") .toast-act:text-is("怎么用")', { timeout: 4000 });
check(true, 'the 已安装 toast offers 怎么用');
await page.click('.toast-act');
await page.waitForTimeout(400);
check(await page.isVisible('.plg-guide-page'), '怎么用 opens the guide');
await shot('3-guide-installed');
// installed: the button takes you there
check((await page.textContent('.plg-guide-try .plg-btn')).trim() === '打开常用提示词', 'installed: 打开 button');
await page.click('.plg-guide-try .plg-btn');
await page.waitForTimeout(900);
check(await page.isVisible('iframe.plugin-frame'), 'the button opens the panel');
await page.click('.p-close');
await page.waitForTimeout(300);
await back();

// 管理 has the guide too
await page.click('.plg-seg button:has-text("已安装")');
await page.waitForTimeout(300);
await page.click('.plg-row:has(.plg-row-t:text-is("常用提示词"))');
await page.waitForTimeout(400);
await page.click('.plg-btn:has-text("管理")');
await page.waitForTimeout(400);
check(await page.isVisible('.plg-manage .plg-link:has-text("使用说明")'), '管理: 使用说明 row');
await page.click('.plg-manage .plg-link:has-text("使用说明")');
await page.waitForTimeout(400);
check(await page.isVisible('.plg-guide-page'), '管理 → 使用说明');
await shot('4-from-manage');

await browser.close();
if (errors.length) {
  console.error('\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nguide ok');
