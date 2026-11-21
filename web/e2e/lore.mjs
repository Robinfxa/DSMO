// 设定集 (dsmo-lore) against the real plugin: e2e/maidsh-host.mjs runs maidsh/lore under cordis and
// serves the prototype from the same origin; the prototype's workspaces are mirrored into the
// host's workspaceRegistry. Follows the UI notes' 验收 list: nothing shows when it isn't installed,
// 重启引擎 when it isn't running, works / characters / entries / states / relations, the chapter
// bar, which work a conversation, a workspace and new conversations use, importing (report,
// duplicates, same names: merge / new / skip, undo), deleting a work, DS Bot conversations.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import { startMaidshHost } from './maidsh-host.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'shots', 'lore');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};

// ---- files to import: a SillyTavern PNG card with a world book, and JSON cards
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function pngCard(card) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const text = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'), 'latin1')]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', text), chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const tmp = join(os.tmpdir(), `lore-e2e-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const files = {
  // ASCII names: the test browser's file chooser drops non-ASCII paths
  png: join(tmp, 'lin-wan.png'),
  same: join(tmp, 'shen-yan.json'),
  same2: join(tmp, 'shen-yan-2.json'),
  same3: join(tmp, 'shen-yan-3.json'),
};
writeFileSync(
  files.png,
  pngCard({
    spec: 'chara_card_v2',
    data: {
      name: '林晚',
      description: '沈砚的旧识，{{user}}的同门。',
      first_mes: '你来了。',
      system_prompt: '你是林晚。',
      alternate_greetings: ['又见面了', '好久不见'],
      character_book: {
        entries: [
          { keys: ['青州', '州城'], content: '北境门户，城门入夜即闭。', extensions: { position: 4, depth: 2 } },
          { keys: ['好感度'], content: '{{getvar::好感度}}' },
        ],
      },
    },
  }),
);
const sameCard = (desc, extra = {}) => ({ spec: 'chara_card_v2', data: { name: '沈砚', description: desc, personality: '嘴冷心热', tags: [], ...extra } });
writeFileSync(files.same, JSON.stringify(sameCard('落魄琴师。', { character_book: { entries: [{ keys: ['断弦琴'], content: '沈砚随身的琴，弦断了一根。' }] } })));
writeFileSync(files.same2, JSON.stringify(sameCard('另一个版本的沈砚。')));
writeFileSync(files.same3, JSON.stringify(sameCard('第三个版本。', { character_book: { entries: [{ keys: ['琴馆'], content: '青州城东的琴馆。' }] } })));

// ---- the host and the page
// The model behind 设定集's sorting-out after a turn (LORE-DESIGN §14): 沈砚 moves, 苏九 is new.
const AUTO_ANSWER = {
  changes: [{ subject: '沈砚', key: '位置', value: '北境军营', op: 'replace', quote: '沈砚策马进了北境军营' }],
  relations: [],
  newCharacters: [{ name: '苏九', summary: '军营里的伙夫，消息灵通。', quote: '伙夫苏九端着一碗热汤' }],
  newEntries: [],
};
const host = await startMaidshHost({ modules: ['lore'], model: (system) => (/小说设定整理员/.test(system) ? JSON.stringify(AUTO_ANSWER) : '{}') });
const origin = new URL(host.url).origin;
const api = async (p, body) =>
  (await fetch(new URL(`/api/dsmo-lore${p}`, host.url), body ? { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) } : {})).json();

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const seed = (list) => localStorage.setItem('api-demo:plugins', JSON.stringify(list.map((id) => ({ id, enabled: true, version: '1.0.0', setupDone: true }))));
const phone = async (installed, { width = 390 } = {}) => {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
  await ctx.addInitScript(seed, installed);
  await ctx.addInitScript(() => localStorage.setItem('api-demo:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('api-demo:prefs') || '{}'), advanced: true })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
  await page.goto(`${host.url}#plain`);
  await page.waitForTimeout(1500);
  return { ctx, page };
};
const LORE = '@api-demo/dsmo-lore';

// ===================================================== not installed: nothing anywhere
{
  const { ctx, page } = await phone([]);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(300);
  await page.click('.m-item .m-item-t >> nth=0');
  await page.waitForTimeout(500);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(300);
  await page.click('.m-item.on .m-item-more');
  await page.waitForTimeout(300);
  check(!(await page.isVisible('.m-pop-row:has-text("设定集")')), 'not installed: no 设定集 in a conversation’s menu');
  await page.keyboard.press('Escape');
  await page.mouse.click(200, 700);
  await page.waitForTimeout(300);
  check(!(await page.isVisible('.lo-bar')), 'not installed: no chapter bar');
  await ctx.close();
}

// ===================================================== installed, not running: restart the engine
{
  const { ctx, page } = await phone([LORE]);
  await page.route(/\/api\/dsmo-lore\//, (r) => r.fulfill({ status: 404, body: '' }));
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(300);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(400);
  check(await page.isVisible('.m-group:has-text("写作") .m-row:has-text("设定集")'), 'settings: 写作 › 设定集');
  await page.click('.m-row:has-text("设定集")');
  await page.waitForTimeout(700);
  const t = await page.textContent('.lo-missing').catch(() => '');
  check(/重启引擎后再试/.test(t ?? ''), 'not running: 重启引擎后再试, no red error');
  await ctx.close();
}

// ===================================================== the main run
const { ctx, page } = await phone([LORE]);
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`), fullPage: true });
const toastHas = (text) =>
  page.waitForSelector(`.toast:has-text(${JSON.stringify(text)})`, { timeout: 4000 }).then(
    () => true,
    () => false,
  );
/** Opens [title]'s conversation, then its 更多 menu (the button shows on the open one). */
const menuOf = async (title) => {
  if (!(await page.$('.m-root.drawer'))) {
    await page.click('[aria-label="打开边栏"]');
    await page.waitForTimeout(350);
  }
  await page.click(`.m-item:has-text(${JSON.stringify(title)}) .m-item-t`);
  await page.waitForTimeout(600);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(350);
  await page.click('.m-item.on .m-item-more');
  await page.waitForTimeout(700);
};
const closeMenu = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await page.isVisible('.m-pop-row')) await page.mouse.click(380, 790);
  await page.waitForTimeout(300);
};
const openChat = async (title) => {
  if (!(await page.$('.m-root.drawer'))) {
    await page.click('[aria-label="打开边栏"]');
    await page.waitForTimeout(350);
  }
  await page.click(`.m-item:has-text(${JSON.stringify(title)}) .m-item-t`);
  await page.waitForTimeout(800);
};
const home = async () => {
  for (let i = 0; i < 5 && (await page.isVisible('[aria-label="返回"] >> nth=-1')); i++) {
    await page.click('[aria-label="返回"] >> nth=-1');
    await page.waitForTimeout(350);
  }
};
const settings = async () => {
  await home();
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(350);
  await page.click('.m-me [aria-label="设置"]');
  await page.waitForTimeout(400);
};
const back = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await page.click('[aria-label="返回"] >> nth=-1');
    await page.waitForTimeout(350);
  }
};
const ask = async (value) => {
  await page.waitForSelector('.m-alert input.dlg-input');
  await page.fill('.m-alert input.dlg-input', value);
  await page.click('.m-alert-btns button.primary');
  await page.waitForTimeout(400);
};
const sheetPick = async (label) => {
  await page.waitForSelector('.m-bsheet .lo-opt');
  await page.click(`.m-bsheet .lo-opt:has-text(${JSON.stringify(label)})`);
  await page.waitForTimeout(500);
};
const noHScroll = async (what) => check(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.page, .m-page, .plg')].every((e) => e.scrollWidth <= e.clientWidth + 1)), `${what}: no sideways scroll at 390 px`);
const work = async () => (await api('/works')).value.find((w) => w.title === '长夜');
const full = async () => (await api(`/work?id=${(await work()).id}`)).value;

await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(300);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
check((await page.textContent('.m-row:has-text("设定集")')).includes('还没有作品'), 'settings: 还没有作品');
await page.click('.m-row:has-text("设定集")');
await page.waitForTimeout(700);
check((await page.textContent('.lo-empty')).includes('不会前后矛盾'), 'works: the empty state explains');
await shot('01-empty');

// a work, two characters
await page.click('.lo-empty .plg-btn.pri');
await ask('长夜');
check(await page.isVisible('.lo-title:has-text("《长夜》")'), 'new work opens');
check((await page.textContent('.lo-tl-ch')).includes('开写前') && (await page.textContent('.lo-tl-sub')).includes('现在写到这里'), 'timeline: 开写前, 现在写到这里');
check(await page.isVisible('.lo-guide:has-text("三步开始")') && !(await page.isVisible('.lo-guide-s.done')), 'new work: the 三步开始 guide, nothing ticked');
await shot('01b-guide');
await page.click('.lo-card.add');
await page.waitForTimeout(500);
const nameIn = '.lo-who.edit input';
await page.fill(nameIn, 'x'.repeat(30));
check((await page.inputValue(nameIn)).length === 20 && (await page.textContent('.lo-who.edit .lo-count')).includes('20 / 20'), 'limits: 名字 stops at 20, counted');
await page.fill(nameIn, '沈砚');
check((await page.textContent('.lo-who.edit .lo-av')).trim() === '沈', 'the avatar follows the name');
await page.fill('.lo-tag-in', '阿砚');
await page.keyboard.press('Enter');
await page.fill('.lo-field:has-text("一句话简介") input', '落魄琴师，嘴冷心热。');
await page.click('.lo-sw:has-text("主要人物") [role="switch"]');
await shot('02-character-new');
await page.click('.lo-savebar .plg-btn.pri');
check(await toastHas('已添加沈砚'), 'character added, on to their page');
await page.waitForSelector('.lo-who:not(.edit)');
let w = await full();
check(w.characters[0]?.name === '沈砚' && w.characters[0].aliases.includes('阿砚') && w.characters[0].tier === 'main', 'in the work: name, alias, 主要');
// a change from chapter 11: the written-up-to chapter follows
await page.click('.lo-add:has-text("记一条变化")');
await page.waitForSelector('.m-bsheet .lo-sheetform');
await page.fill('.m-bsheet [aria-label="从第几章"]', '11');
await page.click('.m-bsheet .lo-chips button:text-is("持有")');
check(await page.isVisible('.m-bsheet .lo-ops.two button[aria-checked="true"]:has-text("多了这个")'), 'record: 持有 is a list, asks 多了这个 / 没了这个');
await page.click('.m-bsheet .lo-chips button:text-is("伤势")');
check(!(await page.isVisible('.m-bsheet .lo-ops')) && (await page.textContent('.m-bsheet')).includes('现在是什么'), 'record: 伤势 is one value, no choice of ways (those are under 高级)');
await page.fill('.m-bsheet input[placeholder="青州城外"]', '左臂刀伤');
await page.click('.m-bsheet .lo-more:has-text("原文")');
await page.fill('.m-bsheet input[placeholder^="正文里"]', '刀锋擦过他的左臂');
await page.screenshot({ path: join(shots, `${scheme}-02b-record.png`) });
await page.click('.m-bsheet .plg-btn.pri');
check(await toastHas('现在写到第 11 章'), 'a change from a later chapter: 现在写到第 11 章');
await page.waitForTimeout(500);
check((await page.textContent('.lo-panel')).includes('左臂刀伤') && (await page.textContent('.lo-panel .lo-tl-ch')).includes('第 11 章'), 'the panel: 第 11 章时 伤势 左臂刀伤');
check((await page.textContent('.lo-story')).includes('刀锋擦过他的左臂'), '经历 with the original line');
// looking back on their timeline: the injury isn't there yet, the step goes faint
await page.click('.lo-panel [aria-label="往前一章"]');
await page.waitForTimeout(300);
check(!(await page.textContent('.lo-panel .lo-chiprow, .lo-panel .lo-chip-empty')).includes('左臂刀伤') && (await page.isVisible('.lo-step-ch.future')), 'at chapter 10: no injury yet, chapter 11 faint in 经历');
await page.click('.lo-step-node:has-text("第 11 章")');
await page.waitForTimeout(300);
check((await page.textContent('.lo-panel')).includes('左臂刀伤'), 'tapping 第 11 章 in 经历 goes there');
await shot('03-character');
await back();
await page.waitForTimeout(400);
check(await page.isVisible('.lo-guide-s.done:has-text("加一个人物")') && !(await page.isVisible('.lo-guide-s.done:has-text("加一条设定")')), 'guide: 加一个人物 ticked, 加一条设定 not yet');
await page.click('.lo-card.add');
await page.waitForTimeout(400);
await page.fill(nameIn, '顾长风');
await page.fill('[aria-label="第几章登场"]', '15');
await page.click('.lo-savebar .plg-btn.pri');
await toastHas('已添加顾长风');
await page.waitForSelector('.lo-who:not(.edit)');
await back();
let t = await page.textContent('.lo-grid');
check(t.includes('沈砚') && t.includes('主要') && t.includes('左臂刀伤'), 'people: 沈砚 主要, with his state at chapter 11');
check(t.includes('顾长风') && t.includes('第 15 章登场') && t.includes('还没写简介') && (await page.isVisible('.lo-card.later:has-text("顾长风")')), 'people: 顾长风 faint, 第 15 章登场, 还没写简介');
// an entry
await page.click('.lo-tabs button:text-is("设定")');
await page.click('.lo-entry.add');
await page.waitForTimeout(400);
await page.fill('.lo-field:has-text("标题") input', '北境');
await page.fill('.lo-field:has-text("关键词") .lo-tag-in', '北境、边关');
await page.fill('.lo-field:has-text("内容") textarea', '长'.repeat(650));
check(await page.isVisible('.plg-note.warn:has-text("超过 600 字")'), 'entry: over 600 warns');
await page.click('.lo-sw:has-text("常驻") [role="switch"]');
await page.click('.plg-btn.pri:has-text("添加设定")');
check(await toastHas('已添加'), 'entry added');
await back();
t = await page.textContent('.lo-entries');
check(t.includes('北境') && t.includes('每轮都带') && t.includes('太长，只能查'), 'entries: 每轮都带, 太长，只能查');
// a relation
await page.click('.lo-tabs button:text-is("关系")');
await page.click('.plg-link:has-text("记一条关系")');
await page.waitForSelector('.m-bsheet .lo-sheetform');
await page.fill('.m-bsheet input[placeholder="互相试探，未表明身份"]', '生死之交');
await page.fill('.m-bsheet [aria-label="从第几章"]', '15');
await page.click('.m-bsheet .plg-btn.pri');
check(await toastHas('现在写到第 15 章'), 'relation recorded (written up to 15)');
await page.waitForTimeout(500);
check((await page.textContent('.lo-pair')).includes('生死之交'), 'relations at the chapter');
await shot('04-relations');
await noHScroll('work page');

// ---- a workspace uses 《长夜》: a conversation made in it shows 《长夜》 and the chapter bar
await back(2);
await settings();
await page.click('.m-row:has-text("工作区")');
await page.waitForTimeout(600);
await page.click('.ws .plg-text-btn:has-text("设定集")');
await sheetPick('《长夜》');
check(await toastHas('这个工作区改用《长夜》'), 'workspace → 《长夜》');
check((await page.textContent('.ws .ws-acts')).includes('设定集：《长夜》'), 'workspace row shows 《长夜》');
await page.click('.ws .plg-text-btn:has-text("在这里新建对话")');
await page.waitForTimeout(800);
const mirror = async () => host.setWorkspaces(await page.evaluate(() => window.__mockEngine.host.workspaces.map((x) => ({ id: x.workspaceId, sessionIds: [...x.sessionIds] }))));
await mirror();
const wsSession = await page.evaluate(() => window.__mockEngine.host.workspaces[0].sessionIds.at(-1));
// send something so the conversation lists and has a title
await page.fill('#input', '第十五章开头写什么');
await page.click('#sendBtn');
await page.waitForTimeout(2500);
await mirror();
await menuOf('第十五章');
check(await page.isVisible('.m-pop-row:has-text("设定集：《长夜》")'), 'its menu: 设定集：《长夜》');
await closeMenu();
await openChat('第十五章');
check(await page.isVisible('.lo-bar:has-text("《长夜》")') && (await page.textContent('.lo-bar')).includes('第 15 章'), 'chapter bar: 《长夜》 · 第 15 章 in the workspace’s conversation');
await shot('05-chapter-bar');
// another conversation: nothing
const other = await page.evaluate(() => [...window.__mockEngine.sessions.values()].find((s) => s.title === 'SSH 隧道是什么')?.id);
await menuOf('SSH 隧道是什么');
check(await page.isVisible('.m-pop-row:has-text("用设定集写这段对话")'), 'another conversation’s menu: 用设定集写这段对话');
check(!(await page.isVisible('.lo-bar')), 'another conversation: no chapter bar');
await page.click('.m-pop-row:has-text("用设定集写这段对话")');
await page.waitForSelector('.m-bsheet');
await page.waitForTimeout(500);
t = await page.textContent('.m-bsheet');
check(t.includes('《长夜》') && t.includes('不用设定集') && !t.includes('跟随'), 'with works already: the sheet lists them, 不用设定集, and no 跟随 when following gives nothing');
await page.screenshot({ path: join(shots, `${scheme}-05b-sheet.png`) });
await page.mouse.click(200, 80);
await page.waitForTimeout(400);

// the bar only shows; its sheet moves the chapter
await openChat('第十五章');
check(!(await page.isVisible('.lo-bar [aria-label="章节加一"]')), 'chapter bar: just 《书名》 · 第 N 章, no buttons');
await page.click('.lo-bar-t');
await page.waitForSelector('.m-bsheet [aria-label="章节加一"]');
check((await page.textContent('.m-bsheet')).includes('AI 记下变化时会自己把章节往前推'), 'its sheet says the AI moves the chapter');
await page.click('.m-bsheet [aria-label="章节加一"]');
await page.click('.m-bsheet [aria-label="章节加一"]');
await page.waitForTimeout(900);
check((await work()).chapter === 17, 'sheet ›› : 第 17 章, saved once the taps stop');
await page.click('.m-bsheet [aria-label="章节减一"]');
await page.waitForTimeout(900);
check((await work()).chapter === 16, '‹ : back to 16');
await page.mouse.click(200, 80);
await page.waitForTimeout(400);
check((await page.textContent('.lo-bar')).includes('第 16 章'), 'the bar follows: 第 16 章');

// this conversation off → 关, bar gone; back to following → restored
await menuOf('第十五章');
await page.click('.m-pop-row:has-text("设定集")');
await sheetPick('不用设定集');
check(await toastHas('这段对话不用设定集了'), 'conversation → 不用设定集');
await page.waitForTimeout(400);
check(!(await page.isVisible('.lo-bar')), 'off: the chapter bar goes');
await menuOf('第十五章');
check(await page.isVisible('.m-pop-row:has-text("用设定集写这段对话")'), 'its menu: 用设定集写这段对话');
await page.click('.m-pop-row:has-text("用设定集写这段对话")');
await sheetPick('跟随工作区');
await page.waitForTimeout(500);
check(await page.isVisible('.lo-bar:has-text("《长夜》")'), 'following the workspace again: bar back');

// ---- sorting out after a turn: a finished turn in this conversation reaches the plugin
const sidAuto = await page.evaluate(() => [...window.__mockEngine.sessions.values()].find((s) => s.title.includes('第十五章'))?.id);
const prose = '夜色渐深，沈砚策马进了北境军营，营火映着他疲惫的脸。伙夫苏九端着一碗热汤迎上来，低声说起这几日营里的传闻。'.repeat(8);
host.ctx.emit(
  'session/event',
  {
    id: sidAuto,
    header: {},
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
    deriveMessages: () => [
      { id: 'u-auto', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续写，沈砚到军营' }] },
      { id: 'a-auto', role: 'assistant', content: [{ type: 'text', text: prose }] },
    ],
  },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
);
await host.ctx.get('lore').idle();
await openChat('SSH 隧道是什么');
await openChat('第十五章');
await page.waitForTimeout(600);
t = await page.textContent('.lo-bar');
check(t.includes('刚记下 1 条') && t.includes('1 条待确认'), `chapter bar after a turn: 刚记下 1 条 · 1 条待确认 (${t.trim()})`);
await page.click('.lo-bar-t');
await page.waitForSelector('.m-bsheet .lo-pend');
t = await page.textContent('.m-bsheet');
check(t.includes('这一轮记下 1 条') && t.includes('沈砚·位置 = 北境军营'), 'sheet: what this turn recorded');
check(t.includes('新人物：苏九') && t.includes('原文：伙夫苏九端着一碗热汤'), 'sheet: 苏九 waits, with the quote');
check(t.includes('自动模式') && t.includes('先放进「待确认」'), 'sheet: 自动模式 switch, off by default');
await page.screenshot({ path: join(shots, `${scheme}-05c-auto-sheet.png`) });
await page.click('.m-bsheet .lo-pend .plg-btn.pri');
check(await toastHas('收下了：苏九'), '收下: 苏九 accepted');
await page.waitForTimeout(500);
check((await full()).characters.some((c) => c.name === '苏九' && c.tier === 'side'), '苏九 is in, as a side character');
await page.click('.m-bsheet [aria-label="自动模式"]');
check(await toastHas('自动模式'), '自动模式 on');
check((await full()).settings.autoAccept === true, 'saved in the work');
await page.click('.m-bsheet .lo-auto-seg button:text-is("每一轮")');
await page.waitForTimeout(400);
check((await full()).settings.autoRecord === 'every', '整理档位: 每一轮');
await page.click('.m-bsheet .plg-text-btn:has-text("撤销这一轮")');
await page.click('.m-alert-btns button.danger, .m-alert-btns button.primary');
check(await toastHas('撤销了'), '撤销这一轮');
await page.waitForTimeout(500);
let after = await full();
check(!after.characters.some((c) => c.name === '苏九') && !after.states.some((x) => x.value === '北境军营'), 'undone: 苏九 (accepted from that turn) and the move are gone');
// back to the defaults for the rest of the run
await api('/mutate', { action: 'settings', work: after.id, autoAccept: false, autoRecord: 'long' });
await page.mouse.click(200, 80);
await page.waitForTimeout(400);

// the work page follows the chapter; dragging back only looks; 「改成写到」 moves it
if (await page.$('.m-root.drawer')) await page.click('.m-stage-scrim');
await page.waitForTimeout(400);
await page.click('.lo-bar-t');
await sheetPick('打开《长夜》');
await page.waitForTimeout(600);
check((await page.textContent('.lo-hero .lo-tl-ch')).includes('第 16 章'), 'work page: the timeline is at 第 16 章');
await page.click('.lo-tabs button:text-is("人物")');
// drag the timeline back to near the start
const box = await page.locator('.lo-hero .lo-tl-track').boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
check((await page.textContent('.lo-hero .lo-tl-ch')).includes('开写前') && !(await page.textContent('.lo-grid')).includes('左臂刀伤'), 'dragged to the start: 开写前, no injury on the card');
check((await page.textContent('.lo-hero .lo-tl-sub')).includes('往回看') && (await work()).chapter === 16, 'dragging only looks: still written up to 16');
for (let i = 0; i < 11; i++) await page.click('.lo-hero [aria-label="往后一章"]');
await page.waitForTimeout(300);
check((await page.textContent('.lo-grid')).includes('左臂刀伤'), 'at chapter 11 the injury is on the card');
await shot('04b-scrub');
await page.click('.lo-tl-act.pri:has-text("改成写到第 11 章")');
await page.waitForTimeout(600);
check((await work()).chapter === 11 && (await page.textContent('.lo-hero .lo-tl-sub')).includes('现在写到这里'), '改成写到第 11 章: saved');

// ---- importing
// the PNG card with a world book: report first, then in, then undone
await page.click('[aria-label="作品的更多操作"]');
await sheetPick('导入到这部作品');
check(await page.isVisible('.lo-steps li.on:has-text("选文件")') && (await page.textContent('.lo-drop')).includes('导入到《长夜》'), 'import step 1: 选文件, into 《长夜》');
let chooser = page.waitForEvent('filechooser');
await page.click('.lo-drop');
await (await chooser).setFiles(files.png);
await page.waitForSelector('.lo-report');
await page.waitForTimeout(400);
t = await page.textContent('.lo-report');
check(t.includes('林晚') && t.includes('跳过了') && /first_mes|开场白/.test(t), `PNG card report, with what's skipped (${t.split('\n')[0]})`);
await shot('06-import-report');
check((await page.textContent('.lo-counts')).replace(/\s/g, '').includes('1个人物1条设定'), 'step 2: the counts');
await page.click('.lo-savebar .plg-btn.pri');
await page.waitForSelector('.lo-done');
w = await full();
check(w.characters.some((c) => c.name === '林晚') && w.lore.some((e) => e.keys.includes('青州')), 'imported: 林晚 and 青州 are in');
check((await page.textContent('.lo-report')).length > 0, 'the result report shows');
await page.click('.plg-btn:has-text("撤销这次导入")');
await page.click('.m-alert-btns button.danger');
check(await toastHas('删掉 1 个人物'), 'undo: says what went');
w = await full();
check(!w.characters.some((c) => c.name === '林晚') && !w.lore.some((e) => e.keys.includes('青州')), 'undone: 林晚 and 青州 gone');

// a card with the same name as 沈砚: merge
const importJson = async (file, choice) => {
  chooser = page.waitForEvent('filechooser');
  await page.click('.lo-drop, .lo-file .plg-text-btn');
  await (await chooser).setFiles(file);
  await page.waitForSelector('.lo-report');
  await page.waitForTimeout(500);
  if (choice) {
    check(await page.isVisible('.plg-sec:has-text("「沈砚」") .lo-choice'), `same name: asks (${choice})`);
    await page.click(`.lo-choice .lo-optcard:has-text(${JSON.stringify(choice)})`);
  }
  await page.click('.lo-savebar .plg-btn.pri');
  await page.waitForSelector('.lo-done');
};
const openImport = async () => {
  await settings();
  await page.click('.m-row:has-text("设定集")');
  await page.waitForTimeout(600);
  await page.click('.lo-work:has-text("长夜")');
  await page.waitForTimeout(600);
  await page.click('[aria-label="作品的更多操作"]');
  await sheetPick('导入到这部作品');
};
await openImport();
await importJson(files.same, '合并');
w = await full();
const shen = w.characters.filter((c) => c.name.startsWith('沈砚'));
check(shen.length === 1 && shen[0].card.summary === '落魄琴师，嘴冷心热。' && /嘴冷心热/.test(shen[0].card.personality ?? ''), 'merge: one 沈砚, his summary kept, the empty 性格 filled');
// the same file again: already imported
await openImport();
chooser = page.waitForEvent('filechooser');
await page.click('.lo-drop');
await (await chooser).setFiles(files.same);
await page.waitForSelector('.lo-warn');
check((await page.textContent('.lo-warn')).includes('已经导入过这部作品') && (await page.isDisabled('.lo-savebar .plg-btn.pri')), 'the same file again: 已经导入过, 导入 waits for 仍然导入');
await page.click('.lo-warn [role="switch"]');
check(!(await page.isDisabled('.lo-savebar .plg-btn.pri')), '仍然导入 lets it through');
// another version: new
chooser = page.waitForEvent('filechooser');
await page.click('.lo-file .plg-text-btn');
await (await chooser).setFiles(files.same2);
await page.waitForSelector('.lo-choice');
await page.waitForTimeout(300);
await page.click('.lo-choice .lo-optcard:has-text("另建")');
await page.click('.lo-savebar .plg-btn.pri');
await page.waitForSelector('.lo-done');
w = await full();
check(w.characters.some((c) => c.name === '沈砚（导入）'), 'new: 沈砚（导入）');
// and a third: skip → only its entries
await openImport();
const before = (await full()).characters.length;
await importJson(files.same3, '跳过');
w = await full();
check(w.characters.length === before && w.lore.some((e) => e.keys.includes('琴馆')), 'skip: no new character, its entries in');
await back();

// 更多: the import records, undo one
await page.click('.lo-tabs button:text-is("导入与设置")');
check((await page.textContent('.plg-sec:has-text("导入记录")')).includes('已撤销'), '更多: records, the undone one says 已撤销');
await shot('07-more');

// ---- new conversations by default; DS Bot conversations
await back();
check(!(await page.isVisible('.plg-row:has-text("所有新对话默认用")')), 'works page: the default is tucked under 高级');
await page.click('.lo-adv > summary');
await page.click('.plg-row:has-text("所有新对话默认用")');
await sheetPick('《长夜》');
check(await toastHas('新对话默认用《长夜》'), 'default → 《长夜》');
await page.waitForTimeout(400);
check((await page.textContent('.plg-row:has-text("所有新对话默认用")')).includes('《长夜》'), 'works page shows the default (高级 stays open while one is set)');
// the frontend syncs DS Bot conversations itself; here one is marked by hand
await api('/binding', { action: 'set-bots', sessionIds: [other] });
await home();
await menuOf('SSH 隧道是什么');
check(!(await page.isVisible('.m-pop-row:has-text("设定集")')), 'DS Bot conversation: no 设定集 line in its menu');
await closeMenu();

// ---- delete the work: asked twice; the workspace and conversations fall back
if (await page.$('.m-root.drawer')) await page.click('.m-stage-scrim');
await settings();
await page.click('.m-row:has-text("设定集")');
await page.waitForTimeout(600);
await page.click('.lo-work:has-text("长夜")');
await page.waitForTimeout(600);
await page.click('[aria-label="作品的更多操作"]');
await sheetPick('删除作品');
check((await page.textContent('.m-alert')).includes('建议先导出'), 'delete asks, suggesting an export first');
await page.click('.m-alert-btns button.danger');
check(await toastHas('已删除《长夜》'), 'deleted');
await page.waitForTimeout(500);
const binds = (await api('/binding')).value;
check(binds.default === 'off' && !Object.values(binds.workspaces).length, 'after deleting: the workspace follows the default again, the default is 关');
check(await page.isVisible('.lo-empty'), 'works: empty again');
check((await page.textContent('.lo-empty')).includes('用设定集写这段对话'), 'works: the empty state points at the one-tap start');
await noHScroll('works');

// ---- one tap from a conversation when there are no works yet
await api('/binding', { action: 'set-bots', sessionIds: [] });
await home();
await menuOf('第十五章');
await page.click('.m-pop-row:has-text("用设定集写这段对话")');
await page.waitForSelector('.m-alert input.dlg-input');
check((await page.inputValue('.m-alert input.dlg-input')).includes('第十五章'), 'no works: named after the conversation by default');
await page.click('.m-alert-btns button.primary');
check(await toastHas('先加几个人物'), 'one tap: started, says what to do next');
await page.waitForTimeout(800);
check(await page.isVisible('.lo-title') && (await page.isVisible('.lo-guide-s.done:has-text("在对话里用它")')), 'the new work opens with 在对话里用它 already ticked');
check((await page.getAttribute('.lo-tabs button:text-is("人物")', 'aria-selected')) === 'true', 'a newly opened work starts on 人物');
await shot('08-one-tap-guide');
const started = (await api('/works')).value[0];
const sid15 = await page.evaluate(() => [...window.__mockEngine.sessions.values()].find((s) => s.title.includes('第十五章'))?.id);
check(started && (await api(`/binding?sessionId=${sid15}`)).value.work === started.id, 'the conversation uses it');
await page.click('.plg-text-btn:has-text("不再显示")');
check(!(await page.isVisible('.lo-guide')), 'guide: 不再显示 hides it');
await shot('09-one-tap');

await ctx.close();
await browser.close();
await host.stop();
console.log(errors.length ? `\n${errors.length} problem(s):\n` + errors.join('\n') : '\nall good');
process.exit(errors.length ? 1 : 0);
