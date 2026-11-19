// 可能冲突: 人设库 and 长期记忆 against DS Bot (the prototype has a Bot team). The card on the
// plugin page, the question before installing, the fix (no persona in Bot conversations, sent
// to a stand-in for the persona package), the mark in 已安装, and the note on DS Bot.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'conflicts');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
await ctx.addInitScript(() => {
  // the persona package: records what it is asked; enough of status for the 人设 page
  const calls = (window.__personaCalls = []);
  const state = { mode: 'global', current: null, sessions: {} };
  window.__personaState = state;
  const real = window.fetch.bind(window);
  const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const snapshot = () => ({
    current: state.current,
    currentName: null,
    globalOff: state.current === null,
    mode: state.mode,
    personas: [{ id: 'dafeiyu', name: '大肥鱼', source: 'builtin', builtin: true, enabled: true, current: false, chars: 10 }],
  });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!/\/api\/dsh-persona-dafeiyu\//.test(url)) return real(input, init);
    if (/status/.test(url)) return json({ ok: true, value: snapshot() });
    const b = JSON.parse(init.body);
    calls.push(b);
    if (b.action === 'set-mode') state.mode = b.mode;
    if (b.action === 'set-session-persona') {
      if (b.none) state.sessions[b.sessionId] = 'none';
      else delete state.sessions[b.sessionId];
    }
    if (b.action === 'set-current') state.current = b.id;
    return json({ ok: true, value: snapshot() });
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const toastIs = (text) =>
  page.waitForSelector(`.toast:text-is(${JSON.stringify(text)})`, { timeout: 3000 }).then(
    () => true,
    () => false,
  );
const back = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await page.click('[aria-label="返回"] >> nth=-1');
    await page.waitForTimeout(400);
  }
};
const drawer = async (entry) => {
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click(`.m-frow:has-text("${entry}")`);
  await page.waitForTimeout(700);
};

await page.goto(`${base}#plain`);
await page.waitForTimeout(1500);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('[aria-label="高级模式"]');
await back();
await drawer('插件');

// 人设库: the card before installing, the question when installing
await page.click('.plg-row:has-text("人设库")');
await page.waitForTimeout(500);
check((await page.textContent('.plg-clash')).includes('和「DS Bot」') && (await page.textContent('.plg-clash')).includes('盖过 Bot 自己的设定'), '人设库 page: 可能冲突 with DS Bot');
check((await page.textContent('.plg-clash')).includes('装好后，可以在「人设」里'), 'before installing: says where the fix will be');
await page.locator('.plg-clash').scrollIntoViewIfNeeded();
await shot('01-persona-card');
await page.click('.plg-btn.pri.wide:has-text("安装")');
await page.waitForTimeout(300);
check((await page.textContent('.m-alert')).includes('可能和「DS Bot」冲突'), 'installing asks first');
await shot('02-persona-ask');
await page.click('.m-alert-btns button:has-text("仍然安装")');
check(await toastIs('已安装「人设库」'), 'installed after 仍然安装');
await page.waitForTimeout(400);

// the fix, from the card
await page.click('.plg-clash-fix');
check(await toastIs('Bot 的对话里不再用人设'), 'fix applied');
const st = await page.evaluate(() => window.__personaState);
const none = Object.values(st.sessions).filter((v) => v === 'none').length;
check(st.mode === 'session' && none >= 2, `the package: session mode, ${none} Bot conversations without a persona`);
check(!(await page.isVisible('.plg-clash')), 'the clash is gone from the card');
await back();

// 长期记忆: can only be explained
await page.click('.plg-row:has-text("长期记忆") .plg-get');
await page.waitForTimeout(300);
check((await page.textContent('.m-alert')).includes('不能只对某些对话关掉'), '长期记忆: asks, and says why there is no fix');
await page.click('.m-alert-btns button:has-text("仍然安装")');
check(await toastIs('已安装「长期记忆」'), 'installed');
await page.click('.plg-seg button:has-text("已安装")');
await page.waitForTimeout(400);
check(await page.isVisible('.plg-row:has-text("长期记忆") .tm-badge.warn'), '已安装: 长期记忆 marked 可能冲突');
check(!(await page.isVisible('.plg-row:has-text("人设库") .tm-badge.warn')), '已安装: 人设库 not marked once fixed');
await shot('03-installed');
await back();

// DS Bot: the note
await drawer('DS Bot');
await page.waitForTimeout(400);
const note = (await page.textContent('.plg-note.warn').catch(() => '')) ?? '';
check(note.includes('「长期记忆」开着') && !note.includes('「人设库」开着'), 'DS Bot: notes 长期记忆; 人设库 is fixed');
await shot('04-dsbot');

// 人设: switch it back off; DS Bot notes it again
await page.reload();
await page.waitForTimeout(1500);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('.m-row:has-text("人设")');
await page.waitForTimeout(700);
const sw = page.locator('[role="switch"][aria-label="Bot 的对话里不用人设"]');
check((await sw.getAttribute('aria-checked')) === 'true', '人设 page: the switch shows it is on (kept across a reload)');
await shot('05-persona-switch');
await sw.click();
check(await toastIs('Bot 的对话也会用人设'), 'switched off');
const after = await page.evaluate(() => window.__personaState);
check(Object.keys(after.sessions).length === 0, 'the Bot conversations fall back to the global persona');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('conflicts e2e ok', scheme);
