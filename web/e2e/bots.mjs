// Round 3 on the phone: DS Bot (team, chats, cards, details, new) and share codes.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { openFeats } from './feats.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'b');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const b64 = (b) => Buffer.from(b).toString('base64url');
const code = (json) => {
  const body = Buffer.from(JSON.stringify(json));
  return `${b64(deflateRawSync(body))}.${b64(createHash('sha256').update(body).digest().subarray(0, 6))}`;
};
const profile = code({
  v: 1,
  kind: 'profile',
  name: '小王的写作配置',
  created: '2026-11-17T10:00:00Z',
  settings: { subagent: { maxDepth: 4, maxParallel: 4 }, shell: { allowNetwork: false, env: { HTTPS_PROXY: 'http://proxy.lan:8080' } } },
  plugins: [
    { name: 'dsh-plugin-reviewer', source: 'npm', spec: 'dsh-plugin-reviewer@1.4.0', version: '1.4.0', title: '代码审查' },
    { name: '@deepseek-ai/dsh-office', source: 'official', title: 'Office 文档' },
    { name: 'dsh-writer', source: 'github', spec: 'github:acme/dsh-writer#v2.0.0', title: '写作助手' },
  ],
  presets: [{ id: 'writer', name: '写作', bundle: 'dsh-writer' }],
  skills: [{ name: 'outline-first', files: { 'SKILL.md': '---\nname: outline-first\ndescription: 先列提纲再写\n---\n先列提纲。' } }],
  agentsMd: '# 写作习惯\n\n- 少用形容词\n',
});

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
await page.goto(url);
await page.waitForTimeout(900);
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const tall = async (n) => {
  const h = await page.evaluate(() => document.querySelector('.pg-body')?.scrollHeight ?? 780);
  await page.setViewportSize({ width: 360, height: Math.min(h + 70, 2400) });
  await page.waitForTimeout(250);
  await shot(n);
  await page.setViewportSize({ width: 360, height: 780 });
};
const back = async () => (await page.click('.pg-head [aria-label="返回"] >> nth=-1'), await page.waitForTimeout(350));
const drawer = async () => (await page.click('[aria-label="打开边栏"]'), await page.waitForTimeout(400));

// DS Bot row in the drawer: advanced mode only, above 全部功能
await drawer();
await openFeats(page);
if (await page.$('.m-frow:has-text("DS Bot")')) errors.push('DS Bot shows without advanced mode');
await page.evaluate(() => {
  localStorage.setItem('api-demo:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('api-demo:prefs') || '{}'), advanced: true }));
});
await page.goto(url);
await page.waitForTimeout(900);
await drawer();
await openFeats(page);
const order = await page.$$eval('.m-feat .m-frow-t', (els) => els.map((e) => e.textContent));
if (order.at(-1) !== '全部功能' || order.at(-2) !== 'DS Bot') errors.push('drawer order: ' + order.join(' / '));
await shot('00-drawer');
await openFeats(page);
await page.click('.m-frow:has-text("DS Bot")');
await page.waitForTimeout(500);
await shot('01-home');
// a Bot's chat: send, stream, reply
await page.click('.bt-row:has-text("小助理")');
await page.waitForTimeout(500);
await page.fill('.bt-cmp textarea', '帮我把下周的事排一下');
await page.click('.bt-cmp-go');
await page.waitForTimeout(900);
await shot('02-streaming');
await page.waitForTimeout(2500);
await shot('03-replied');
await back();
// question card
await page.click('.bt-row:has-text("写手")');
await page.waitForTimeout(500);
await shot('04-question');
await page.click('.bt-chip:has-text("导师")');
await page.click('.bt-card .plg-btn.pri:has-text("提交")');
await page.waitForTimeout(600);
await back();
// waiting for a model
await page.click('.bt-row:has-text("研究员")');
await page.waitForTimeout(500);
await shot('05-model-card');
await page.click('.bt-card button:has-text("选择模型")');
await page.waitForTimeout(400);
await shot('06-model-page');
await page.click('.plg-row:has-text("DeepSeek-V4-Flash")');
await page.click('.plg-btn.pri:has-text("保存")');
await page.waitForTimeout(2500);
await shot('07-greeted');
// details
await page.click('.pg-head [aria-label="详情"]');
await page.waitForTimeout(600);
await tall('08-details');
await page.click('.plg-row:has-text("记忆")');
await page.waitForTimeout(400);
await shot('09-memory');
await back();
await back();
await back();
// group chat with an approval
await page.click('.bt-row:has-text("周报小组")');
await page.waitForTimeout(600);
await shot('10-room');
await page.click('.bt-card .plg-btn.pri:has-text("允许本次")');
await page.waitForTimeout(400);
await page.click('.bt-cmp-at');
await page.waitForTimeout(200);
await shot('11-mention');
await page.click('.bt-mention .plg-row:has-text("写手")');
await page.type('.bt-cmp textarea', '今天能出初稿吗');
await page.click('.bt-cmp-go');
await page.waitForTimeout(1300);
await shot('12-room-working');
await page.waitForTimeout(2200);
await page.click('.pg-head [aria-label="详情"]');
await page.waitForTimeout(500);
await tall('13-room-details');
await back();
await back();
// new Bot
await page.click('.plg-row:has-text("新建 Bot")');
await page.waitForTimeout(400);
await page.fill('input[placeholder="名字"]', '翻译官');
await page.fill('input[placeholder^="角色"]', '中英互译');
await tall('14-new-bot');
await page.click('.plg-btn.pri:has-text("创建")');
await page.waitForTimeout(2600);
await shot('15-new-bot-chat');
await back();
// new group
await page.click('.plg-row:has-text("新建群聊")');
await page.waitForTimeout(400);
await page.click('[role="switch"][aria-label="选择写手"]');
await page.click('[role="switch"][aria-label="选择翻译官"]');
await shot('16-new-room');
await page.click('.plg-btn.pri:has-text("创建群聊")');
await page.waitForTimeout(1200);
await shot('17-new-room-chat');
await back();
await shot('18-home-after');
await back();

// share codes: open a profile link, import it (全部功能 needs advanced mode)
await page.evaluate(() => {
  localStorage.setItem('api-demo:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('api-demo:prefs') || '{}'), advanced: true }));
});
await page.goto(url);
await page.waitForTimeout(900);
await drawer();
await openFeats(page);
await page.click('.m-frow:has-text("全部功能")');
await page.waitForTimeout(400);
await page.click('.lrow:has-text("打开分享码")');
await page.waitForTimeout(300);
await page.fill('textarea.sf-input', `看看我的配置 https://go.dshtui.com/share/#p=${profile}`);
await shot('20-open');
await page.click('.plg-btn.pri:has-text("打开")');
await page.waitForTimeout(1200);
await tall('21-import-plan');
await page.click('[role="switch"][aria-label="导入命令执行"]');
await page.click('.plg-btn.pri:has-text("导入")');
await page.waitForTimeout(2500);
await tall('22-import-done');
const done = await page.textContent('.plg-note >> nth=-1');
if (!/完成 \d+ 项/.test(done ?? '')) errors.push('import did not finish: ' + done);
await page.click('.plg-btn.pri:has-text("完成")');
await page.waitForTimeout(300);
await back();
// make a profile share
await page.click('.lrow:has-text("分享配置")');
await page.waitForTimeout(900);
await tall('23-share-profile');
await page.fill('input[placeholder="可不填"]', '我的配置');
await page.click('.plg-btn.pri:has-text("生成分享码")');
await page.waitForTimeout(800);
await page.click('.sh-keys .plg-btn:has-text("二维码")');
await page.waitForTimeout(300);
await tall('24-share-out');
const link = await page.textContent('.sh-link');
if (!/^https:\/\/go\.dshtui\.com\/share\/#p=/.test(link ?? '')) errors.push('no share link: ' + link);
// engine plugins → 分享
await back();
await back();
await back();
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no errors');
