// The sidebar opens plain, like DeepSeek's: the feature entries (本机, 插件, 技能, DS Bot, plugins'
// own entries…) sit behind one 「功能」 row (ui/featFold.ts), so many plugins can't push the
// conversations or the settings row out of reach. Phone drawer and computer sidebar: folded on open,
// a tap unfolds the rows, every launch starts folded again; without advanced mode there's no row.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'shots', 'drawer');
mkdirSync(shots, { recursive: true });
const url = pathToFileURL(join(here, '..', 'dist-proto', 'index.html')).href;
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};

// every listing with its own sidebar entry, installed at the market's version
const index = JSON.parse(readFileSync(join(here, '..', '..', 'market', 'index.json'), 'utf8'));
const withSlots = index.plugins.map((p) => p.manifest).filter((m) => (m.slots ?? []).some((s) => s.slot === 'sider.features'));
const seed = ([list, advanced]) => {
  localStorage.setItem('api-demo:plugins', JSON.stringify(list.map(([id, version]) => ({ id, enabled: true, version, setupDone: true }))));
  localStorage.setItem('api-demo:prefs', JSON.stringify({ advanced }));
};
const many = withSlots.map((m) => [m.id, m.version]);
check(many.length >= 3, `${many.length} listings add a sidebar entry`);

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const inView = (page, sel) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return !!r && r.top >= 0 && r.bottom <= innerHeight && r.height > 0;
  }, sel);

// ---- phone, a short screen, every plugin with an entry
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 600 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(seed, [many, true]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '#plain');
  await page.waitForTimeout(1300);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(500);
  check((await page.$$('.m-feat .m-frow')).length === 1 && (await page.isVisible('.m-feat-fold:has-text("功能")')), 'phone: opens plain, one 「功能」 row');
  check(!(await page.isVisible('.m-frow:has-text("插件")')) && !(await page.isVisible('.m-frow:has-text("设定集")')), 'phone: the entries are folded away');
  check(await inView(page, '.m-drawer .m-item'), 'phone: the conversations right under it');
  check(await inView(page, '.m-me [aria-label="设置"]'), 'phone: 设置 in view');
  await page.screenshot({ path: join(shots, 'm-folded.png') });
  await page.click('.m-feat-fold');
  await page.waitForTimeout(300);
  check(await page.isVisible('.m-frow:has-text("本机")') && (await page.isVisible('.m-frow:has-text("设定集")')) && (await page.isVisible('.m-frow:has-text("全部功能")')), 'phone: a tap unfolds 本机, the tools and plugins’ entries');
  check(await inView(page, '.m-me [aria-label="设置"]'), 'phone: 设置 still in view unfolded');
  await page.screenshot({ path: join(shots, 'm-open.png') });
  await page.click('.m-frow:has-text("插件")');
  await page.waitForTimeout(600);
  check(await page.isVisible('.pg-title:text-is("插件")'), 'phone: a row opens its page');
  await page.reload();
  await page.waitForTimeout(1300);
  if (!(await page.$('.m-root.drawer'))) await page.click('[aria-label="打开边栏"]').catch(() => {});
  await page.waitForTimeout(500);
  check(!(await page.isVisible('.m-frow:has-text("插件")')), 'phone: folded again on the next launch');
  await ctx.close();
}

// ---- phone, without advanced mode: no 功能 row at all
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(seed, [many, false]);
  const page = await ctx.newPage();
  await page.goto(url + '#plain');
  await page.waitForTimeout(1300);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(500);
  check(!(await page.isVisible('.m-feat-fold')), 'phone, basic mode: no 功能 row');
  await ctx.close();
}

// ---- computer, a short window
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 560 } });
  await ctx.addInitScript(seed, [many, true]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '#plain');
  await page.waitForTimeout(1300);
  check((await page.isVisible('.sider .feat-fold:has-text("功能")')) && !(await page.isVisible('.sider .row:has-text("自动化任务")')), 'computer: opens plain, one 「功能」 row');
  check(await inView(page, '.sider .s-list .section .item, .sider .s-list .section .row'), 'computer: a conversation is in view');
  check(await inView(page, '.s-bottom [aria-label="设置"]'), 'computer: 设置 in view');
  await page.screenshot({ path: join(shots, 'd-folded.png') });
  await page.click('.feat-fold');
  await page.waitForTimeout(300);
  check(await page.isVisible('.sider .row:has-text("自动化任务")') && (await page.isVisible('.sider .row:has-text("设定集")')), 'computer: a click unfolds the rows');
  await page.click('.sider .row:has-text("技能")');
  await page.waitForTimeout(600);
  check(await page.isVisible('.pg-title:text-is("技能")'), 'computer: a row opens its page');
  await page.click('.feat-fold');
  await page.waitForTimeout(300);
  check(!(await page.isVisible('.sider .row:has-text("自动化任务")')), 'computer: and folds again');
  await ctx.close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n` + errors.join('\n') : '\nall good');
process.exit(errors.length ? 1 : 0);
