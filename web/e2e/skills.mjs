// 技能: list (mine / built-in), edit and save, create, use (/name in the input),
// delete — from the drawer, with no conversation open.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'skills');
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
const toast = async () => (await page.waitForSelector('.toast', { timeout: 3000 }).catch(() => null)) && page.textContent('.toast');
const names = (sec) => page.$$eval(`.plg-sec:has(.plg-sec-t:text-is("${sec}")) .plg-row-t`, (e) => e.map((x) => x.childNodes[0].textContent.trim()));
const back = async () => (await page.click('[aria-label="返回"] >> nth=-1'), await page.waitForTimeout(450));

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('[aria-label="高级模式"]');
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(400);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-frow:has-text("技能")');
await page.waitForTimeout(700);
check(JSON.stringify(await names('我的技能')) === '["weekly-report"]', 'mine: the user skill');
const builtIn = await names('内置和项目里的');
check(builtIn.includes('pdf') && builtIn.includes('docx') && !builtIn.includes('weekly-report'), `built-in, read-only: ${builtIn.join(' ')}`);
await shot('01-list');

// a long description: two lines in the list, all of it on 查看详情
const rowH = await page.$eval('.plg-row:has-text("docx") .plg-row-s', (e) => e.getBoundingClientRect().height);
check(rowH < 40, `long description clamps to two lines in the list (${Math.round(rowH)} px)`);
await page.click('.plg-row:has-text("docx")');
await page.waitForTimeout(450);
check((await page.textContent('.sk-text')).includes('只要 PDF 或纯文本时不要用'), '详情 shows the whole description');
check((await page.textContent('.sk-path')) === '/root/.dsh/engine/skills/docx/SKILL.md', '详情 shows where it lives');
await shot('01b-info');
await page.click('.plg-btn.pri:has-text("在对话里用")');
await page.waitForTimeout(400);
check((await page.inputValue('#input')) === '/docx ', '详情 › 在对话里用');
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-frow:has-text("技能")');
await page.waitForTimeout(600);

// edit and save
await page.click('.plg-row:has-text("weekly-report")');
await page.waitForTimeout(500);
check((await page.inputValue('.sk-desc')).includes('周报'), 'editor: description read from SKILL.md');
check((await page.inputValue('.ske-body')).startsWith('# 周报'), 'editor: instructions without the front matter');
check(await page.isDisabled('.plg-actions .plg-btn >> nth=0'), 'nothing to save before an edit');
await page.fill('.sk-desc', '把这周的提交、笔记和会议整理成周报: 三段式');
await page.fill('.ske-body', '# 周报\n\n1. 读 git log、notes/ 和会议纪要\n2. 按「完成 / 进行中 / 下周」三段写\n');
await page.click('.plg-btn.pri');
check((await toast()) === '已保存', 'saved');
await page.waitForTimeout(300);
check((await page.textContent('.plg-actions .plg-btn >> nth=0')) === '已保存', 'button says it is saved');
await shot('02-edit');
await back();
check((await page.textContent('.plg-row:has-text("weekly-report") .plg-row-s')) === '把这周的提交、笔记和会议整理成周报: 三段式', 'list shows the new description (quoted in YAML, read back)');

// create
await page.click('.plg-link:has-text("新建技能")');
await page.waitForTimeout(450);
await page.fill('.sk-field input', '日报');
await page.fill('.sk-desc', '用户要写今天的日报时');
await page.fill('.ske-body', '# 日报\n\n列出今天做完的事和明天的计划。\n');
await page.click('.plg-btn.pri');
check((await toast())?.includes('名字只能用英文'), 'rejects a name DSH cannot use');
await page.waitForTimeout(2000);
await page.fill('.sk-field input', 'daily-notes');
await page.click('.plg-btn.pri');
check((await toast()) === '已新建「daily-notes」', 'created');
await page.waitForTimeout(500);
check((await page.textContent('.sk-name')) === '/daily-notes', 'opens the new skill');
await shot('03-new');
await back();
check(JSON.stringify(await names('我的技能')) === '["daily-notes","weekly-report"]', 'listed with the others');

// use: /name in the input
await page.click('.plg-row:has-text("daily-notes") .plg-get');
await page.waitForTimeout(400);
check((await page.inputValue('#input')) === '/daily-notes ', '使用 puts /daily-notes in the input');

// the engine sees it too (skills/list in a new conversation)
await page.fill('#input', '/daily-notes 帮我写');
await page.click('#sendBtn');
await page.waitForTimeout(2500);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-frow:has-text("技能")');
await page.waitForTimeout(700);
check((await names('我的技能')).includes('daily-notes'), 'still there with a conversation open');

// delete
await page.click('.plg-row:has-text("daily-notes")');
await page.waitForTimeout(450);
await page.click('.plg-btn.danger');
await page.waitForTimeout(300);
await page.click('.m-alert-btns button >> nth=-1');
check((await toast()) === '已删除', 'deleted');
await page.waitForTimeout(500);
check(JSON.stringify(await names('我的技能')) === '["weekly-report"]', 'gone from the list');
await shot('04-after-delete');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('skills e2e ok', scheme);
