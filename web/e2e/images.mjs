// Images the person sends: a thumbnail in their bubble, still there once the
// conversation is opened again (read back from the log with session/attachment),
// and the whole picture on tap.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'img');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'light';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};

// a 320×200 PNG: a blue-to-orange gradient
function png(w, h) {
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    out.writeUInt32BE(crc(t), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = 40 + (200 * x) / w;
      raw[i + 1] = 110;
      raw[i + 2] = 230 - (180 * x) / w;
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const file = join(shots, 'photo.png');
writeFileSync(file, png(320, 200));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
await page.click('[aria-label="添加附件"]');
await page.waitForTimeout(350);
const chooser = page.waitForEvent('filechooser');
await page.click('.m-tile:has-text("相册")');
await (await chooser).setFiles(file);
await page.waitForTimeout(400);
await page.fill('#input', '这张图是什么颜色？');
await page.click('#sendBtn');
await page.waitForSelector('.msg.user .u-img img', { timeout: 5000 });
check(await page.isVisible('.msg.user .u-img img'), 'thumbnail in the bubble');
check((await page.textContent('.msg.user .bubble')).includes('这张图是什么颜色'), 'text kept beside it');
await page.waitForTimeout(2500);
await shot('01-sent');

// open another conversation, then this one again: the image comes back from the log
const title = await page.evaluate(() => document.querySelector('.m-title, .m-head-t')?.textContent ?? '');
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(450);
await page.click('.m-item:not(.on) >> nth=0');
await page.waitForTimeout(800);
check(!(await page.isVisible('.msg.user .u-img')), 'switched away');
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(450);
await page.click('.m-item >> nth=0');
await page.waitForSelector('.msg.user .u-img img', { timeout: 5000 }).catch(() => {});
check(await page.isVisible('.msg.user .u-img img'), 'thumbnail again after reopening' + (title ? ` (${title})` : ''));
const size = await page.$eval('.msg.user .u-img img', (i) => [i.naturalWidth, i.naturalHeight]);
check(size[0] === 320 && size[1] === 200, `the picture itself (${size.join('×')})`);
await shot('02-reopened');

await page.click('.msg.user .u-img');
await page.waitForTimeout(400);
check(await page.isVisible('.overlay[data-kind="image"] img'), 'tap shows the whole picture');
await shot('03-viewer');
await page.click('.img-view');
await page.waitForTimeout(400);
check(!(await page.isVisible('.overlay[data-kind="image"]')), 'tap again closes it');

await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('images e2e ok', scheme);
