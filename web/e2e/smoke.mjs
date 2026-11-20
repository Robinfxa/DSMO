// Drives the built prototype (dist-proto/index.html) in Chrome and screenshots key states.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots');
mkdirSync(shots, { recursive: true });
const errors = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

async function run(name, viewport, fn) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
  await page.goto(url);
  await page.waitForTimeout(600);
  await fn(page);
  await ctx.close();
}
const shot = (page, n) => page.screenshot({ path: join(shots, n + '.png') });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

await run('desktop', { width: 1280, height: 800 }, async (page) => {
  await shot(page, '01-welcome');
  await page.click('.item-title >> nth=0');
  await page.waitForTimeout(500);
  await shot(page, '02-open-session');
  // basic send
  await page.click('.new-chat');
  await page.fill('#input', '你好');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await shot(page, '03-streaming');
  await page.waitForSelector('.a-actions:not(:empty)', { timeout: 10000 });
  await shot(page, '04-replied');
  // advanced mode
  await page.click('[aria-label="设置"]');
  await page.waitForTimeout(400);
  await shot(page, '05-settings');
  await page.click('[role="switch"][aria-label="高级模式"]');
  await page.click('.p-close');
  await page.waitForTimeout(400);
  await shot(page, '06-advanced');
  await page.click('.new-chat');
  await page.fill('#input', '修复登录按钮重复提交的 bug 并补测试');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-protected="approval"]', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, '07-approval');
  // click inside closed shadow root: use the host's center-ish → find the primary button by coordinates
  const box = await page.locator('[data-protected="approval"]').boundingBox();
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 30);
  await page.waitForSelector('[data-protected="approval"]', { state: 'detached', timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('#sendBtn[data-mode="stop"]'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, '08-tools-done');
  // features page (no conversation items any more) and the chat menu (top right)
  await page.click('.row:has-text("全部功能")');
  await page.waitForTimeout(400);
  await shot(page, '09-features');
  await page.click('[aria-label="返回"]');
  const menu = async (name) => {
    await page.click('.h-more');
    await page.waitForTimeout(350);
    await page.click(`.cm-item:has-text("${name}")`);
    await page.waitForTimeout(400);
  };
  await page.click('.h-more');
  await page.waitForTimeout(400);
  await shot(page, '09b-chat-menu');
  await page.click('.overlay.open .p-close');
  await page.waitForTimeout(300);
  await menu('对话详情');
  await shot(page, '10-detail');
  await page.click('[aria-label="返回"]');
  await menu('计划与目标');
  await shot(page, '11-plan');
  await page.click('[aria-label="返回"]');
  await menu('文件');
  await shot(page, '12-files');
  await page.click('[aria-label="返回"]');
  await menu('权限');
  await shot(page, '13-permission');
  await page.click('[aria-label="返回"]');
  // plugins: 发现 → detail → install (skin, prompts, notes, 今日用量 engine plugin)
  await page.click('.row:has-text("插件")');
  await page.waitForTimeout(300);
  await shot(page, '14-market');
  for (const name of ['夜航', '常用提示词', '随手记', '今日用量']) {
    await page.click(`.plg-card:has-text("${name}"), .plg-row:has-text("${name}")`);
    await page.waitForTimeout(400);
    await page.click('.plg-btn.pri:has-text("安装")');
    await page.waitForTimeout(500);
    await page.click('[aria-label="返回"]');
    await page.waitForTimeout(300);
  }
  await page.click('[aria-label="返回"]');
  await page.waitForTimeout(300);
  await shot(page, '15-after-plugins');
  await page.click('.row:has-text("随手记")');
  await page.waitForTimeout(900);
  await shot(page, '16-notes-panel');
  await page.click('.p-close');
  await page.waitForTimeout(300);
  // the engine plugin's strip pill → its dsh-Go panel
  await page.click('.pill:has-text("今日用量")');
  await page.waitForTimeout(700);
  await shot(page, '17-dshgo-panel');
  await page.click('.p-close');
  console.log('overflow desktop:', await overflow(page));
});

await run('mobile', { width: 390, height: 844 }, async (page) => {
  await shot(page, '20-m-welcome');
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await shot(page, '21-m-drawer');
  await page.click('.m-item-t >> nth=0');
  await page.waitForTimeout(500);
  await shot(page, '22-m-chat');
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-me-main');
  await page.waitForTimeout(500);
  await shot(page, '23-m-login');
  await page.click('.m-screen [aria-label="返回"]');
  await page.waitForTimeout(450);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(450);
  await page.click('[role="switch"][aria-label="高级模式"]');
  await page.waitForTimeout(200);
  await shot(page, '24-m-settings-adv');
  await page.click('.m-screen [aria-label="返回"]');
  await page.waitForTimeout(450);
  await page.click('.h-more');
  await page.waitForTimeout(500);
  await shot(page, '25-m-chat-menu');
  console.log('overflow mobile:', await overflow(page));
});

await run('guard', { width: 1280, height: 800 }, async (page) => {
  // Advanced mode, then a skin with custom CSS; then a hostile rule that hides approval cards.
  await page.click('[aria-label="设置"]');
  await page.click('[role="switch"][aria-label="高级模式"]');
  await page.click('.p-close');
  await page.click('.row:has-text("插件")');
  await page.click('.plg-row:has-text("纸张")');
  await page.click('.plg-btn.pri:has-text("安装")');
  await page.waitForTimeout(300);
  await page.click('[aria-label="返回"]');
  await page.click('[aria-label="返回"]');
  await page.evaluate(() => { document.getElementById('plugin-css').textContent += '\n.a-approval { opacity: 0 !important; } .md p { color: #8a5a00; }'; });
  await page.click('.new-chat');
  await page.fill('#input', '删除 build 目录');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-protected="approval"]', { timeout: 15000 });
  await page.waitForTimeout(1600);
  const css = await page.evaluate(() => document.getElementById('plugin-css').textContent);
  const toast = await page.evaluate(() => document.querySelector('.toast')?.textContent ?? '');
  const visible = await page.evaluate(() => getComputedStyle(document.querySelector('.a-approval')).opacity);
  console.log('guard: plugin css cleared =', css === '', '| toast =', toast, '| approval opacity =', visible);
  if (css !== '') errors.push('guard did not suspend plugin css');
  await shot(page, '30-guard');
  // artifacts: the 表 script presents a file
  await page.click('.new-chat');
  await page.fill('#input', '把花销做成表');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.a-text')?.textContent?.includes('332.70'), null, { timeout: 15000 });
  await page.click('.h-more');
  await page.waitForTimeout(350);
  await page.click('.cm-item:has-text("产出的文件")');
  await page.waitForTimeout(400);
  await page.click('.lrow-main:has-text("汇总-10月.csv")');
  await page.waitForTimeout(500);
  const preview = await page.evaluate(() => document.querySelector('.overlay.open pre.code')?.textContent ?? '');
  console.log('artifact preview ok =', preview.includes('餐饮'));
  if (!preview.includes('餐饮')) errors.push('artifact preview failed');
  await shot(page, '31-artifact');
  await page.click('.overlay.open .p-close');
  await page.click('[aria-label="返回"]');
  await page.click('.new-chat');
  await page.fill('#input', '帮我选一个风格写介绍');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.callout.question', { timeout: 15000 });
  await shot(page, '32-question');
  await page.click('.callout.question .toggle:has-text("详细")');
  await page.click('.callout.question .btn.primary');
  await page.waitForFunction(() => [...document.querySelectorAll('.a-text')].some((e) => e.textContent.includes('详细')), null, { timeout: 15000 });
  console.log('question answered ok');
});

await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
