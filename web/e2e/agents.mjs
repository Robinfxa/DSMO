// Round 6: 智能体团队 (chat ⋯ menu; #team seeds a Lead with two teammates) and Agent 预设
// (全部功能): default, config, delete, and 新建 handing a request to creator mode.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openFeats } from './feats.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'ag');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const wait = (ms) => page.waitForTimeout(ms);
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const body = () => page.textContent('.pg-body >> nth=-1');

await page.goto(url + '#plain-team');
await wait(900);
await page.evaluate(() => localStorage.setItem('api-demo:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('api-demo:prefs') || '{}'), advanced: true })));
await page.reload();
await wait(1000);

// 智能体团队 from the Lead's ⋯ menu
await page.click('[aria-label="打开边栏"]');
await wait(400);
await page.click('.m-item-t:has-text("重构登录模块")');
await wait(800);
await page.click('[aria-label="这个对话的功能"]');
await wait(400);
await page.click('.cm-item:has-text("智能体团队")');
await wait(1200);
await shot('00-members');
check((await body()).includes('负责人') && (await body()).includes('模型额度用完了'), 'members with lead and a failure');
await page.click('.tm-tabs button:has-text("任务")');
await wait(300);
await shot('01-tasks');
check((await body()).includes('等依赖：表单校验改成失焦触发'), 'task waits on its dependency');
await page.click('.tm-tabs button:has-text("消息")');
await wait(900);
await shot('02-messages');
check((await body()).includes('负责人 → 前端'), 'team messages read from members');
await page.click('[aria-label="返回"] >> nth=-1');
await wait(400);

// a conversation without a team
await page.click('[aria-label="打开边栏"]');
await wait(400);
await page.click('.m-item-t:has-text("周报草稿")');
await wait(700);
await page.click('[aria-label="这个对话的功能"]');
await wait(400);
await page.click('.cm-item:has-text("智能体团队")');
await wait(1000);
await shot('03-no-team');
check((await body()).includes('这台主机没有智能体团队') || (await body()).includes('这个对话还没有团队'), 'empty team state');
await page.click('[aria-label="返回"] >> nth=-1');
await wait(400);

// Agent 预设
await page.click('[aria-label="打开边栏"]');
await wait(400);
await openFeats(page);
await page.click('.m-frow:has-text("全部功能")');
await wait(400);
await page.click('.lrow:has-text("Agent 预设")');
await wait(800);
await shot('10-presets');
await page.click('.plg-row:has-text("代码审查")');
await wait(300);
await page.click('.plg-btn:has-text("设为新对话默认")');
await wait(700);
check((await body()).includes('新对话默认'), 'reviewer is the default');
await shot('11-preset-default');
await page.click('.plg-btn:has-text("查看配置")');
await wait(500);
await shot('12-preset-config');
check((await body()).includes('plugins:'), 'config shown');
await page.click('.plg-btn:has-text("返回列表")');
await wait(300);
await page.click('.plg-link:has-text("新建预设")');
await wait(300);
await page.fill('.m-alert input.dlg-input', '只读代码，按清单给出审查意见');
await page.click('.m-alert-btns button >> nth=-1');
await wait(1500);
await shot('13-creator-chat');
check((await page.content()).includes('请帮我新建一个 Agent 预设'), 'creator mode got the request');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('agents e2e ok', scheme);
