// 陪伴 (MaiDSH) against the real plugins: e2e/maidsh-host.mjs runs maidsh/*/lib under cordis with a
// scripted model and serves the prototype from the same origin. Covers 设置 › 陪伴 › TA 的状态 and
// its five tabs, learning (estimate, duplicate, progress, undo), 让 TA 深度学习这段对话 from a
// conversation's 更多 (the engine can't read the prototype's conversations, so the page sends the
// messages itself), initiative pause / resume, and a plugin that isn't installed or isn't running.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { startMaidshHost } from './maidsh-host.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'shots', 'companion');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};

const host = await startMaidshHost();
const origin = new URL(host.url).origin;
const api = async (p, body) =>
  (await fetch(new URL(p, host.url), body ? { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) } : {})).json();
const settled = async () => {
  for (let i = 0; i < 40; i++) {
    const v = (await api('/api/maidsh/jobs')).value;
    if (v.every((j) => j.status !== 'running' && j.status !== 'queued')) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
};

// TA has been talking a while: a mood, a few warm turns, and something learned
const svc = (n) => host.ctx.get(n);
svc('companionMood').feel('开心', 0.8, 'mood');
for (let i = 0; i < 4; i++) svc('companionBond').interact('开心', 0.9, 'bond');
svc('companionBond').interact('委屈', 0.6, 'bond');
await api('/api/maidsh/learn', { textType: 'aboutme', title: '自我介绍', text: '我叫小林，在多伦多读计算机。喜欢下雨天在家看书。' });
await settled();

const ALL = ['core', 'mood', 'bond', 'memory', 'expression', 'initiative'];
// installed at the market's versions (an older one would read as 「有新版本」)
const VERSIONS = Object.fromEntries(JSON.parse(readFileSync(join(here, '..', '..', 'market', 'index.json'), 'utf8')).plugins.map((p) => [p.manifest.id, p.manifest.version]));
const seed = () => ([list, versions]) =>
  localStorage.setItem('api-demo:plugins', JSON.stringify(list.map((m) => ({ id: `@api-demo/maidsh-${m}`, enabled: true, version: versions[`@api-demo/maidsh-${m}`] ?? '1.0.0', setupDone: true }))));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
await ctx.addInitScript(seed(), [ALL, VERSIONS]);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`), fullPage: true });
const toastIs = (text) =>
  page.waitForSelector(`.toast:text-is(${JSON.stringify(text)})`, { timeout: 4000 }).then(
    () => true,
    () => false,
  );
const toastHas = (text) =>
  page.waitForSelector(`.toast:has-text(${JSON.stringify(text)})`, { timeout: 4000 }).then(
    () => true,
    () => false,
  );
const tab = async (t) => {
  await page.click(`.cp-tabs button:text-is("${t}")`);
  await page.waitForTimeout(500);
};
const body = () => page.textContent('.cp');

await page.goto(`${host.url}#plain`);
await page.waitForTimeout(1200);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
check(await page.isVisible('.m-row:has-text("TA 的状态")'), '设置 › 陪伴 has 「TA 的状态」');
await page.click('.m-row:has-text("TA 的状态")');
await page.waitForTimeout(800);

// 总览
let t = await body();
check(t.includes('开心') && t.includes('心情'), `总览: mood label (${/心情.{0,12}/.exec(t)?.[0]})`);
check(t.includes('和你的关系') && (await page.$$('.cp-level')).length === 6, '总览: bond with six levels');
check(!/好感 [+-]?\d/.test(t), '总览: no 好感 number until 详情');
check((await page.$$('.cp-chg.up')).length >= 1 && (await page.$$('.cp-chg.down')).length === 1, '总览: recent changes, up and down');
await page.click('.cp-card:has-text("和你的关系") .plg-text-btn:text-is("详情")');
check(/好感 \+\d+/.test(await body()), '总览: 详情 shows the number');
check(t.includes('记得 2 件事、1 段经历'), '总览: memory summary');
await shot('1-overview');

// 记忆
await page.click('.cp-sum:has-text("记忆")');
await page.waitForTimeout(600);
t = await body();
check(t.includes('身份') && t.includes('在多伦多读计算机') && t.includes('喜好和雷点'), '记忆: facts grouped');
check(t.includes('导入的') && t.includes('记得清楚'), '记忆: source and clarity');
check(t.includes('2026-03-02') && t.includes('第一次聊到深夜') && t.includes('感动'), '记忆: the episode with its feeling');
await page.click('.plg-text-btn:text-is("记一件事")');
await page.fill('.cp-add input', '不吃香菜');
await page.click('.cp-add .cp-chips button:text-is("喜好和雷点")');
await page.click('.cp-add .plg-btn.pri');
check(await toastIs('记下了'), '记忆: add');
check((await api('/api/maidsh-memory/list')).value.facts.some((f) => f.text.includes('香菜') && f.cat === 'pref' && f.source === 'user'), '记忆: in the plugin, as 你加的 / pref');
await page.click('.cp-mem-row:has-text("不吃香菜")');
await page.fill('.cp-mem.open textarea', '不吃香菜和葱');
await page.click('.cp-mem.open .plg-btn.pri');
check(await toastIs('已改好'), '记忆: edit');
check((await body()).includes('不吃香菜和葱'), '记忆: the edit shows');
await page.click('.cp-mem-row:has-text("第一次聊到深夜")');
await page.click('.cp-mem.open [role="switch"]');
check(await toastIs('钉住了'), '记忆: pin an episode');
await page.click('.cp-mem.open .plg-btn.danger');
await page.waitForTimeout(250);
check((await page.textContent('.m-alert')).includes('删掉这条记忆'), '记忆: delete asks first');
await page.click('.m-alert-btns button >> nth=-1');
check(await toastIs('已删除'), '记忆: deleted');
check(!(await api('/api/maidsh-memory/list')).value.episodes.length, '记忆: gone in the plugin');
await page.click('.plg-shelf-h:has-text("印象") .plg-text-btn');
await page.fill('.cp input[maxlength="30"]', '爱看书的夜猫子');
await page.click('.plg-sec:has-text("印象") .plg-btn.pri');
check(await toastIs('已改好'), '记忆: edit the impression');
check((await api('/api/maidsh-memory/list')).value.profile.short === '爱看书的夜猫子', '记忆: impression saved');
await shot('2-memory');

// 学习与导入: estimate, start, progress → done, duplicate, undo
await tab('学习与导入');
await page.click('[role="radio"]:has-text("聊天记录")');
await page.fill('.cp-learn-text', '我：今天被老板夸了\nTA：真棒\n我：那还用说\n我：小狗勾饿了');
await page.click('.plg-btn.pri:text-is("先估算一下")');
await page.waitForSelector('.cp-est');
check(/大约调用模型 \d+ 次、\d+ token、\d+ 分钟，用的是你当前的默认模型/.test(await page.textContent('.cp-est')), '学习: estimate');
await page.click('.plg-btn.pri:text-is("开始学习")');
check(await toastIs('开始学了，可以离开这一页'), '学习: started');
await settled();
await page.waitForTimeout(3300);
t = await page.textContent('.plg-sec:has-text("学习记录")');
check(t.includes('学完了'), `学习: progress reaches done (${t.slice(0, 60)})`);
await page.fill('.cp-learn-text', '我：今天被老板夸了\nTA：真棒\n我：那还用说\n我：小狗勾饿了');
await page.click('[role="radio"]:has-text("聊天记录")');
await page.click('.plg-btn.pri:text-is("先估算一下")');
await page.waitForSelector('.cp-est');
check((await page.textContent('.cp-est')).includes('这份内容已经学过了'), '学习: duplicate noticed in the estimate');
await page.click('.plg-btn.pri:text-is("开始学习")');
await page.waitForTimeout(300);
check((await page.textContent('.m-alert')).includes('这份内容已经学过了'), '学习: duplicate asks before learning again');
await page.click('.m-alert-btns button >> nth=0');
await shot('3-learn');

// 表达 (what the chat log taught)
await tab('表达');
t = await body();
check(t.includes('还不熟的时候，TA 只听得懂你的黑话'), '表达: the rule up top');
check(t.includes('被夸的时候 → 「那还用说」') && t.includes('俏皮'), '表达: 说法 with tone');
check(t.includes('小狗勾：撒娇时的自称'), '表达: 黑话');
await page.click('.plg-shelf-h:has-text("黑话") .plg-text-btn');
await page.fill('.cp-add input >> nth=0', '摸鱼');
await page.fill('.cp-add input >> nth=1', '上班偷懒');
await page.click('.cp-add .plg-btn.pri');
check(await toastIs('记住了'), '表达: teach a 黑话');
check((await api('/api/maidsh-expression/list')).value.items.some((x) => x.say === '摸鱼' && x.means === '上班偷懒'), '表达: in the plugin');
await shot('4-expression');

// undo the chat-log job: what it taught goes
await tab('学习与导入');
await page.click('.cp-job:has-text("聊天记录") .plg-text-btn.danger');
await page.waitForTimeout(250);
await page.click('.m-alert-btns button >> nth=-1');
check(await toastIs('撤销了'), '学习: undo');
await page.waitForTimeout(300);
check(!(await api('/api/maidsh-expression/list')).value.items.some((x) => x.say === '小狗勾'), '学习: undo removed what it taught');
check((await page.textContent('.cp-job:has-text("聊天记录")')).includes('已撤销'), '学习: shows 已撤销');

// 主动
await tab('主动');
t = await body();
check(t.includes('今天') && t.includes('0 / 3 次') && t.includes('23:30–08:00'), '主动: today / quiet hours');
await page.click('.cp-pause .plg-btn:text-is("8 小时")');
check(await toastIs('8 小时内 TA 不会主动来找你'), '主动: pause 8 h');
const next = (await api('/api/maidsh-initiative/state')).value.nextAt;
check(Math.abs(next - Date.now() - 8 * 3600_000) < 60_000, '主动: the plugin moved the next time');
check((await body()).includes('大约 ' + new Date(next).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })), '主动: shows the new time');
check((await body()).includes('手机上只有打开 DSMO 时 TA 才能主动'), '主动: the foot note');
await shot('5-initiative');

// 让 TA 深度学习这段对话: from a conversation's 更多
for (let i = 0; i < 4 && (await page.isVisible('[aria-label="返回"] >> nth=-1')); i++) {
  await page.click('[aria-label="返回"] >> nth=-1');
  await page.waitForTimeout(400);
}
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-item .m-item-t >> nth=0');
await page.waitForTimeout(700);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-item.on [aria-label="更多"]');
await page.waitForTimeout(300);
check(await page.isVisible('.m-pop-row:has-text("让 TA 深度学习这段对话")'), 'chat 更多: 让 TA 深度学习这段对话');
const jobsBefore = (await api('/api/maidsh/jobs')).value.length;
await page.click('.m-pop-row:has-text("让 TA 深度学习这段对话")');
await page.waitForSelector('.m-alert', { timeout: 4000 });
check(/大约调用模型 \d+ 次/.test(await page.textContent('.m-alert')), 'deep learn: asks with the estimate');
await page.click('.m-alert-btns button >> nth=-1');
check(await toastHas('TA 正在细读这段对话'), 'deep learn: started');
const jobsAfter = await settled();
check(jobsAfter.length === jobsBefore + 1 && jobsAfter.some((j) => j.textType === 'session' && j.status === 'done'), 'deep learn: the engine got the messages and learned them');
await page.click('.toast button');
await page.waitForTimeout(600);
check(await page.isVisible('.cp-tabs button[aria-selected="true"]:text-is("学习与导入")'), 'deep learn: 看进度 opens 学习与导入');
await shot('6-deep-learn');

// TA stopped after being ignored: 让 TA 继续主动
await page.route('**/api/maidsh-initiative/state', (r) =>
  r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { enabled: true, today: 3, perDay: 3, nextAt: 0, followups: [{ at: Date.now() + 3600_000, reason: '面试' }], ignored: 3, stopped: true, quiet: '23:30–08:00' } }) }),
);
await tab('主动');
t = await body();
check(t.includes('TA 等你先开口') && t.includes('来问问你面试的事'), '主动: stopped, with a follow-up');
await page.unroute('**/api/maidsh-initiative/state');
await page.click('.plg-btn.pri:text-is("让 TA 继续主动")');
check(await toastIs('TA 会继续主动来找你'), '主动: resume');
check(!(await body()).includes('TA 等你先开口'), '主动: no longer stopped');

// 记忆 not installed / installed but the engine not restarted
{
  const c2 = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, colorScheme: scheme });
  await c2.addInitScript(seed(), [['core', 'memory'], VERSIONS]);
  const p2 = await c2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  // this engine runs neither: 表达 isn't installed in DSMO, 记忆 is but the engine hasn't restarted
  await p2.route(/\/api\/maidsh-(memory|expression)\//, (r) => r.fulfill({ status: 404, body: '' }));
  await p2.goto(`${host.url}#plain`);
  await p2.waitForTimeout(1000);
  await p2.evaluate(() => (location.hash = '#plain'));
  await p2.click('[aria-label="打开边栏"]');
  await p2.waitForTimeout(400);
  await p2.click('.m-me [aria-label="设置"]');
  await p2.waitForTimeout(400);
  await p2.click('.m-row:has-text("TA 的状态")');
  await p2.waitForTimeout(700);
    await p2.click('.cp-tabs button:text-is("表达")');
  await p2.waitForTimeout(500);
  check((await p2.textContent('.cp')).includes('还没装「MaiDSH 表达」'), 'not installed: says so, with the market');
  await p2.click('.cp-tabs button:text-is("记忆")');
  await p2.waitForTimeout(500);
  check((await p2.textContent('.cp')).includes('MaiDSH 记忆装好了，重启引擎后生效'), 'installed, routes missing: restart the engine');
  await c2.close();
}

// desktop: the sider slot
{
  const c3 = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: scheme });
  await c3.addInitScript(seed(), [ALL, VERSIONS]);
  await c3.addInitScript(() => localStorage.setItem('api-demo:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('api-demo:prefs') || '{}'), advanced: true })));
  const p3 = await c3.newPage();
  p3.on('pageerror', (e) => errors.push(e.message));
  await p3.goto(`${host.url}#plain`);
  await p3.waitForTimeout(1200);
  const slot = await p3.$('.sider .row:has-text("陪伴")');
  check(!!slot, 'desktop: 陪伴 in the sider (from the core listing)');
  await slot?.click();
  await p3.waitForTimeout(800);
  check((await p3.textContent('.cp').catch(() => '')).includes('和你的关系'), 'desktop: it opens 陪伴');
  await p3.screenshot({ path: join(shots, `${scheme}-7-desktop.png`) });
  await c3.close();
}

await browser.close();
await host.stop();
console.log(errors.length ? `\n${errors.length} problem(s):\n` + errors.join('\n') : '\nall good');
process.exit(errors.length ? 1 : 0);
