// 自定义背景: the plugin's panel picks a photo (the host shrinks it, the panel only sees the thumbnail),
// the chat stage shows it under a veil, the sliders change the veil and blur, 移除 clears it, and
// turning the plugin off takes it away. Also 设置 › 外观 › 聊天背景, which shows only with the plugin on.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { openFeats } from './feats.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'shots', 'background');
mkdirSync(shots, { recursive: true });
// served over http, not file://: localStorage under file:// now and then comes back empty after a reload
const dist = join(here, '..', 'dist-proto');
const server = http.createServer((req, res) => {
  try {
    const body = readFileSync(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html').replace(/\.\./g, '')));
    res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;
const errors = [];
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};

// a big photo-like picture, so shrinking has work to do (ASCII name: the file chooser drops others)
const photo = join(shots, 'beach.png');
execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
w, h = 2400, 3200
im = Image.new('RGB', (w, h))
d = ImageDraw.Draw(im)
for y in range(h):
    t = y / h
    d.line([(0, y), (w, y)], fill=(int(40 + 200 * t), int(120 + 80 * (1 - t)), int(220 - 120 * t)))
d.ellipse([w * 0.55, h * 0.12, w * 0.85, h * 0.12 + w * 0.3], fill=(255, 214, 120))
im.save(${JSON.stringify(photo)})
`]);

const ID = '@api-demo/custom-background';
const VERSION = JSON.parse(readFileSync(join(here, '..', '..', 'market', 'index.json'), 'utf8')).plugins.find((p) => p.manifest.id === ID).manifest.version;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
  await ctx.addInitScript(
    ([id, version]) => {
      if (window !== window.top || localStorage.getItem('api-demo:plugins')) return; // not inside the sandboxed panel
      localStorage.setItem('api-demo:plugins', JSON.stringify([{ id, enabled: true, version, setupDone: true }]));
      localStorage.setItem('api-demo:prefs', JSON.stringify({ advanced: true }));
    },
    [ID, VERSION],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
  const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
  await page.goto(url);
  await page.waitForTimeout(900);
  check(!(await page.isVisible('.app-bg')), `${scheme}: no background before one is picked`);

  // the panel from the sidebar's 功能
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await openFeats(page);
  await page.click('.m-frow:has-text("聊天背景")');
  await page.waitForTimeout(900);
  const frame = page.frameLocator('iframe.plugin-frame');
  check(await frame.locator('#empty').isVisible() && !(await frame.locator('#chat').isVisible()), `${scheme}: panel starts empty`);
  await shot('1-panel-empty');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('#pick').click()]);
  await chooser.setFiles(photo);
  await frame.locator('#ctl:not([hidden])').waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  await shot('2-panel-picked');
  check((await frame.locator('#pick').textContent()) === '换一张' && !(await frame.locator('#empty').isVisible()), `${scheme}: button reads 换一张, empty note gone`);
  const thumb = await frame.locator('#img').evaluate((e) => e.style.backgroundImage);
  check(thumb.startsWith('url("data:image/jpeg'), `${scheme}: panel sees a jpeg thumbnail`);

  // what's stored: shrunk, within the native per-value limit
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.includes('bg.')).map(([k, v]) => [k, v.length]));
  const image = stored.find(([k]) => k.endsWith('bg.image'));
  check(!!image && image[1] < 1024 * 1024, `${scheme}: stored image fits the storage limit (${image?.[1]} chars)`);

  // the chat stage
  await page.click('.p-close');
  await page.waitForTimeout(500);
  check(await page.isVisible('.m-stage > .app-bg'), `${scheme}: background layer on the chat stage`);
  check(await page.evaluate(() => document.body.classList.contains('has-bg')), `${scheme}: body.has-bg`);
  const dim0 = await page.$eval('.app-bg', (e) => e.style.getPropertyValue('--bg-dim'));
  check(dim0 === '0.45', `${scheme}: default veil 45% (${dim0})`);
  await page.fill('#chatInput, textarea', '你好');
  await page.waitForTimeout(100);
  await page.click('#sendBtn');
  await page.waitForTimeout(1800);
  await shot('3-chat');
  // protected areas stay above it
  const below = await page.evaluate(() => {
    const bg = document.querySelector('.app-bg');
    const top = document.elementFromPoint(180, 760);
    return !!top && !bg.contains(top);
  });
  check(below, `${scheme}: composer is above the background`);

  // sliders, through 设置 › 外观 this time
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-side-foot .m-me, [aria-label="设置"]');
  await page.waitForTimeout(400);
  await page.click('.m-row:has-text("外观")');
  await page.waitForTimeout(400);
  check(await page.isVisible('.m-row:has-text("聊天背景") .m-row-v:text-is("已设置")'), `${scheme}: 外观 shows 聊天背景 · 已设置`);
  await shot('4-appearance');
  await page.click('.m-row:has-text("聊天背景")');
  await page.waitForTimeout(900);
  await frame.locator('#ctl:not([hidden])').waitFor({ timeout: 8000 });
  await frame.locator('#dim').fill('70');
  await frame.locator('#blur').fill('8');
  await page.waitForTimeout(600);
  const [dim, blur] = await page.$eval('.app-bg', (e) => [e.style.getPropertyValue('--bg-dim'), e.style.getPropertyValue('--bg-blur')]);
  check(dim === '0.7' && blur === '8px', `${scheme}: sliders reach the stage (${dim}, ${blur})`);
  await page.click('.p-close');
  await page.waitForTimeout(400);
  await shot('5-chat-dim-blur');

  // 移除
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await openFeats(page);
  await page.click('.m-frow:has-text("聊天背景")');
  await page.waitForTimeout(900);
  await frame.locator('#clear:not([hidden])').waitFor({ timeout: 8000 });
  await frame.locator('#clear').click();
  await page.waitForTimeout(500);
  check(await frame.locator('#empty').isVisible(), `${scheme}: panel empty after 移除`);
  await page.click('.p-close');
  await page.waitForTimeout(400);
  check(!(await page.isVisible('.app-bg')), `${scheme}: background gone after 移除`);

  // pick again, then turn the plugin off: gone, and 外观 no longer offers it
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await openFeats(page);
  await page.click('.m-frow:has-text("聊天背景")');
  await page.waitForTimeout(900);
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('#pick').click()]);
  await ch2.setFiles(photo);
  await frame.locator('#ctl:not([hidden])').waitFor({ timeout: 8000 });
  await page.click('.p-close');
  await page.waitForTimeout(400);
  check(await page.isVisible('.app-bg'), `${scheme}: picked again`);
  await page.reload();
  await page.waitForTimeout(1200);
  check(await page.isVisible('.m-stage > .app-bg'), `${scheme}: still there after a reload`);
  // off through 插件 › 已安装 (the app owns the stored list, so not by hand)
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await openFeats(page);
  await page.click('.m-frow:has-text("插件")');
  await page.waitForTimeout(600);
  await page.click('.plg-seg button:has-text("已安装")');
  await page.waitForTimeout(300);
  await page.click('[aria-label="启用自定义背景"]');
  await page.waitForTimeout(400);
  await page.click('[aria-label="返回"] >> nth=-1');
  await page.waitForTimeout(500);
  check(!(await page.isVisible('.app-bg')), `${scheme}: plugin off → no background`);
  await page.click('[aria-label="打开边栏"]');
  await page.waitForTimeout(400);
  await page.click('.m-side-foot .m-me, [aria-label="设置"]');
  await page.waitForTimeout(400);
  await page.click('.m-row:has-text("外观")');
  await page.waitForTimeout(400);
  check(!(await page.isVisible('.m-row:has-text("聊天背景")')), `${scheme}: 外观 plain again`);
  await ctx.close();
}

// desktop: the same layer under the main column
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  await ctx.addInitScript(([id, version]) => {
    if (window !== window.top) return;
    localStorage.setItem('api-demo:plugins', JSON.stringify([{ id, enabled: true, version, setupDone: true }]));
    localStorage.setItem('api-demo:prefs', JSON.stringify({ advanced: true }));
  }, [ID, VERSION]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForTimeout(900);
  await openFeats(page);
  await page.click('.row:has-text("聊天背景")');
  await page.waitForTimeout(900);
  const frame = page.frameLocator('iframe.plugin-frame');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('#pick').click()]);
  await chooser.setFiles(photo);
  await frame.locator('#ctl:not([hidden])').waitFor({ timeout: 8000 });
  await page.click('.p-close');
  await page.waitForTimeout(500);
  check(await page.isVisible('main.main > .app-bg'), 'desktop: background under the main column');
  const sider = await page.evaluate(() => getComputedStyle(document.querySelector('.sider, aside')).backgroundColor);
  check(sider !== 'rgba(0, 0, 0, 0)', `desktop: sidebar keeps its own background (${sider})`);
  await page.screenshot({ path: join(shots, 'desktop.png') });
  await ctx.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error('\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nbackground ok');
