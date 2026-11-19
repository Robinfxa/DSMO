// 设置 › 陪伴 › 人设 (plugin 人设库) against a stand-in for dsh-persona-dafeiyu's loopback API
// that follows its rules (unique names, samples can't be removed or renamed, removing the one
// in use falls back to the default): choose, details, new (long text, the 20 000 limit), edit, copy, delete.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'persona');
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
  localStorage.setItem('api-demo:plugins', JSON.stringify([{ id: '@api-demo/persona-library', enabled: true, version: '1.0.0', setupDone: true }]));
  const builtins = [
    { id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼\n\n一条话很多的鱼。', description: '话痨的鱼' },
    { id: 'acha', name: '阿茶', text: '# 人设：阿茶\n\n温柔的茶馆老板。', description: '温柔的茶馆老板' },
  ];
  const store = { current: null, personas: [], n: 0 };
  window.__persona = store;
  const catalog = () => [...builtins.map((b) => ({ ...b, source: 'builtin', builtin: true })), ...store.personas.map((p) => ({ ...p, source: 'imported', builtin: false }))];
  const snapshot = () => {
    const cur = catalog().find((p) => p.id === store.current);
    return {
      current: cur?.id ?? null,
      currentName: cur?.name ?? null,
      globalOff: store.current === null,
      personas: catalog().map((p) => ({
        id: p.id,
        name: p.name,
        source: p.source,
        builtin: p.builtin,
        enabled: true,
        current: p.id === store.current,
        chars: p.text.length,
        ...(p.description ? { description: p.description } : {}),
      })),
    };
  };
  const nameOk = (name, except) => {
    const t = String(name ?? '').trim();
    if (!t) return '名字不能为空';
    if (t.length > 60) return '名字不能超过 60 个字符';
    if (catalog().some((p) => p.id !== except && p.name.trim().toLowerCase() === t.toLowerCase())) return `已经有叫「${t}」的人设了`;
    return null;
  };
  const mutate = (b) => {
    const find = (id) => catalog().find((p) => p.id === id);
    switch (b.action) {
      case 'set-current':
        if (b.id === null) store.current = null;
        else if (!find(b.id)) return `找不到人设「${b.id}」`;
        else store.current = b.id;
        return null;
      case 'import': {
        const text = String(b.text ?? '').trim();
        if (!text) return '人设正文不能为空';
        if (text.length > 64000) return '人设正文不能超过 64000 个字符';
        const bad = nameOk(b.name);
        if (bad) return bad;
        store.personas.push({ id: `imported-${++store.n}`, name: b.name.trim(), text });
        return null;
      }
      case 'rename': {
        const p = store.personas.find((x) => x.id === b.id);
        if (!p) return '只有导入的人设可以重命名';
        const bad = nameOk(b.name, b.id);
        if (bad) return bad;
        p.name = b.name.trim();
        return null;
      }
      case 'remove': {
        if (!store.personas.some((x) => x.id === b.id)) return '内置人设不可删除';
        store.personas = store.personas.filter((x) => x.id !== b.id);
        if (store.current === b.id) store.current = 'dafeiyu';
        return null;
      }
    }
    return '未知操作';
  };
  const real = window.fetch.bind(window);
  const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const m = /\/api\/dsh-persona-dafeiyu\/(status|persona|mutate)(\?id=(.*))?$/.exec(url);
    if (!m) return real(input, init);
    if (m[1] === 'status') return json({ ok: true, value: snapshot() });
    if (m[1] === 'persona') {
      const p = catalog().find((x) => x.id === decodeURIComponent(m[3] ?? ''));
      return json(p ? { ok: true, value: { id: p.id, name: p.name, text: p.text } } : { ok: false, error: '找不到' });
    }
    const err = mutate(JSON.parse(init.body));
    return json(err ? { ok: false, error: err } : { ok: true, value: snapshot() });
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const toast = async () => (await page.waitForSelector('.toast', { timeout: 3000 }).catch(() => null)) && page.textContent('.toast');
/** The toast that says exactly this (an earlier one may still be showing). */
const toastIs = (text) =>
  page.waitForSelector(`.toast:text-is(${JSON.stringify(text)})`, { timeout: 3000 }).then(
    () => true,
    () => false,
  );
const checked = () => page.$eval('.plg-row[aria-checked="true"] .plg-row-t', (e) => e.childNodes[0].textContent.trim());
const rows = () => page.$$eval('.plg-row[role="radio"] .plg-row-t', (e) => e.map((x) => x.childNodes[0].textContent.trim()));
const store = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__persona)));

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(400);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('.m-row:has-text("人设")');
await page.waitForTimeout(700);
check((await checked()) === '不启用人设', 'starts with none in use');
check(JSON.stringify(await rows()) === JSON.stringify(['不启用人设', '大肥鱼', '阿茶']), 'lists the samples');
await shot('01-list');

// choose with one tap
await page.click('.plg-row:has-text("阿茶")');
check(await toastIs('已启用「阿茶」'), 'tap a row to use it');
await page.waitForTimeout(300);
check((await checked()) === '阿茶' && (await store()).current === 'acha', 'check mark moves; the package agrees');

// details of a sample: read-only, copy to change
await page.click('[aria-label="阿茶的详情"]');
await page.waitForTimeout(500);
check((await page.textContent('.ps-text')).includes('温柔的茶馆老板'), 'details show the text');
check(!(await page.isVisible('.plg-btn.danger')) && (await page.isVisible('.plg-btn:has-text("复制一份来改")')), 'a sample can only be copied');
await page.click('.plg-btn:has-text("复制一份来改")');
await page.waitForTimeout(500);
check((await page.inputValue('.sk-field input')) === '阿茶（我的）', 'copy is named apart');
await page.fill('.ps-edit', (await page.inputValue('.ps-edit')) + '\n\n## 口头禅\n慢慢来。');
await page.click('.plg-btn.pri');
check(await toastIs('已启用「阿茶（我的）」'), 'copy saved and used');
await page.waitForTimeout(500);
check((await checked()) === '阿茶（我的）', 'back on the list, the copy in use');

// new: the 20 000 limit, then a long one that fits
await page.click('.plg-btn.wide:has-text("新建人设")');
await page.waitForTimeout(500);
check((await page.inputValue('.ps-edit')).includes('## 你是谁'), 'new starts from the template');
await page.fill('.ps-edit', '# 人设：长篇\n\n' + '很长的设定。'.repeat(3400));
await page.waitForTimeout(150);
check((await page.isDisabled('.plg-btn.pri')) && (await page.textContent('.ps-over')).includes('超出了'), 'over 20 000: says so, cannot save');
const long = '# 人设：长篇\n\n' + '很长的设定。'.repeat(3300);
await page.fill('.ps-edit', long);
await page.waitForTimeout(150);
check(!(await page.isDisabled('.plg-btn.pri')), `${long.length} characters can be saved`);
await shot('02-new');
await page.click('.plg-btn.pri');
check(await toastIs('已启用「长篇」'), 'named from its # 人设： line, saved and used');
await page.waitForTimeout(500);
const made = (await store()).personas.find((p) => p.name === '长篇');
check(made && made.text.length === long.trim().length, 'the whole text reached the package');

// edit the text of the one in use: still in use afterwards, same name, new text
await page.click('[aria-label="长篇的详情"]');
await page.waitForTimeout(500);
await page.click('.plg-btn:has-text("编辑")');
await page.waitForTimeout(500);
await page.fill('.ps-edit', '# 人设：长篇\n\n改短了。');
await page.click('.plg-btn.pri');
check(await toastIs('已保存'), 'edit saved');
await page.waitForTimeout(600);
check((await page.textContent('.ps-text')).includes('改短了'), 'details show the new text');
let st = await store();
const edited = st.personas.find((p) => p.name === '长篇');
check(edited && st.current === edited.id && st.personas.filter((p) => p.name.startsWith('长篇')).length === 1, 'still in use, one copy, no temporary name left');
await shot('03-edited');

// rename only
await page.click('.plg-btn:has-text("编辑")');
await page.waitForTimeout(500);
await page.fill('.sk-field input', '短篇');
await page.click('.plg-btn.pri');
check(await toastIs('已保存'), 'rename saved');
await page.waitForTimeout(500);
check((await page.textContent('.ps-name')).includes('短篇'), 'details show the new name');

// delete the one in use: falls back to the default, as the package does
await page.click('.plg-btn.danger');
await page.waitForTimeout(300);
await page.click('.m-alert-btns button >> nth=-1');
check(await toastIs('已删除'), 'deleted');
await page.waitForTimeout(500);
check(!(await rows()).includes('短篇') && (await checked()) === '大肥鱼', 'gone; the package fell back to its default');
await shot('04-after');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('persona e2e ok', scheme);
