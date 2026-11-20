// 插件 › 发现 as a market: search, category chips, 精选 cards, shelves, and the
// way back from a plugin's page keeps where you were.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'market');
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
const rows = () => page.$$eval('.plg .plg-group .plg-row .plg-row-t', (els) => els.map((e) => e.textContent));
const search = async (q) => (await page.fill('.plg-find input', q), await page.waitForTimeout(200));

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
await shot('01-discover');

const cards = await page.$$eval('.plg-card-t', (e) => e.map((x) => x.textContent));
const featured = JSON.parse(readFileSync(join(here, '..', '..', 'market', 'index.json'), 'utf8')).featured;
check(cards.length === featured.length && cards[0] === '人设库' && cards[1] === '长期记忆', `精选 follows the market's list: ${cards.join(' ')}`);
const chips = await page.$$eval('.plg-chips button', (b) => b.map((x) => x.textContent));
check(chips[0] === '全部' && chips.includes('技能') && chips.includes('引擎'), `chips: ${chips.join(' ')}`);

await page.click('.plg-chips button:has-text("技能")');
await page.waitForTimeout(250);
check(JSON.stringify(await rows()) === JSON.stringify(['代码审查', '会议纪要']), 'a chip shows just that category');
await shot('02-skills');
await page.click('.plg-chips button:has-text("全部")');
await page.waitForTimeout(250);

await search('会议');
check((await rows())[0] === '会议纪要', 'search: a name match comes first');
check(!(await page.isVisible('.plg-cards')), 'search hides 精选 and shelves');
await search('皮肤 夜间');
check(JSON.stringify(await rows()) === JSON.stringify(['夜航']), 'every word must match');
await search('自动化');
check(JSON.stringify((await rows()).slice(0, 2).sort()) === JSON.stringify(['每周回顾', '每日计划'].sort()), 'search by category name: that category first');
await shot('03-search');
await search('不存在的东西');
check(await page.isVisible('text=没有找到「不存在的东西」'), 'says when nothing matches');
await page.click('.plg-empty .plg-text-btn');
await page.waitForTimeout(200);
check((await page.inputValue('.plg-find input')) === '' && (await page.isVisible('.plg-cards')), 'clear brings 发现 back');

// a card opens the plugin; back returns to the same view
await page.click('.plg-chips button:has-text("工具")');
await page.waitForTimeout(250);
await page.click('.plg-row:has-text("常用提示词")');
await page.waitForTimeout(500);
check(await page.isVisible('.plg-detail h2:has-text("常用提示词")'), 'row opens the plugin page');
await page.click('[aria-label="返回"]');
await page.waitForTimeout(500);
check((await page.textContent('.plg-chips button[aria-selected="true"]')) === '工具', 'back keeps the chosen category');

// install from a card, then find it in 已安装 by search
await page.click('.plg-chips button:has-text("全部")');
await page.waitForTimeout(250);
await page.click('.plg-card:has-text("常用提示词") .plg-get');
await page.waitForTimeout(600);
check((await page.textContent('.plg-card:has-text("常用提示词") .plg-get')).includes('已安装'), 'install from a card');
await page.click('.plg-seg button:has-text("已安装")');
await page.waitForTimeout(300);
await search('提示');
check(JSON.stringify(await rows()) === JSON.stringify(['常用提示词']), '已安装 is searchable');
await shot('04-installed');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('market e2e ok', scheme);
