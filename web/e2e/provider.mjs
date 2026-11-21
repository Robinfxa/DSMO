// 模型提供方 › 添加提供方, the reported case: a Chinese name (芯云), a bare domain without /v1, an
// OpenAI-compatible key. 获取模型列表 must work (the domain answers 404, /v1 is tried and filled in),
// show what came back, and 添加 must write what dsh-Go accepts: namespace llm-pi-ai, a route id
// custom-…, the key as a credential named by apiKeyEnv, models as objects. Failures say why on the page.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = 'file://' + join(here, '..', 'dist-proto', 'index.html');
const shots = join(here, 'shots', 'provider');
mkdirSync(shots, { recursive: true });
const errors = [];
const scheme = process.argv[2] || 'dark';
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) errors.push(what);
};
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/404|Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: join(shots, `${scheme}-${n}.png`) });
const calls = [];

await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);
// watch what the page asks the engine
await page.evaluate(() => {
  const e = window.__mockEngine;
  const call = e.rpc.call;
  window.__calls = [];
  e.rpc.call = (endpoint, args) => (window.__calls.push([endpoint, JSON.parse(JSON.stringify(args ?? {}))]), call(endpoint, args));
});
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(300);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(300);
await page.click('[aria-label="高级模式"]');
await page.waitForTimeout(300);
await page.click('.m-row:has-text("模型提供方")');
await page.waitForTimeout(500);
await page.click('.plg-link:has-text("添加提供方")');
await page.waitForTimeout(400);

// 添加 before any model: says why, on the page
await page.fill('input[placeholder="例如 芯云"]', '芯云');
await page.fill('input[placeholder="https://api.example.com/v1"]', 'https://xinyuntoken.com');
await page.fill('input[placeholder="只保存在主机上"]', ' sk-xinyun-123 ');
await page.click('.plg-btn.pri:has-text("添加")');
await page.waitForTimeout(300);
check((await page.textContent('.prov-problem').catch(() => '')).includes('至少选一个模型'), 'adding without a model says why');

// 获取模型列表: the bare domain 404s, /v1 works and is filled in
await page.click('.plg-link:has-text("获取模型列表")');
await page.waitForSelector('.plg-row .mono', { timeout: 5000 }).catch(() => {});
await shot('1-fetched');
const ids = await page.$$eval('.plg-row-t.mono', (e) => e.map((x) => x.textContent));
check(ids.join() === 'model-large,model-small,model-coder', `models listed: ${ids.join(' ')}`);
check((await page.inputValue('input[type="url"]')) === 'https://xinyuntoken.com/v1', 'address completed with /v1');
check((await page.textContent('.pg-body')).includes('地址已补全为 https://xinyuntoken.com/v1'), 'says it completed the address');
const disc = (await page.evaluate(() => window.__calls)).filter(([e]) => e === 'llm/discoverModels');
check(disc.length === 2 && disc.every(([, a]) => a.settingsNs === 'llm-pi-ai') && disc[1][1].request.baseURL === 'https://xinyuntoken.com/v1' && disc[1][1].request.apiKey === 'sk-xinyun-123', 'asked llm-pi-ai, then with /v1, with the trimmed key');

// a model by hand too
await page.click('.plg-link:has-text("手动添加模型")');
await page.waitForSelector('.m-alert input.dlg-input');
await page.fill('.m-alert input.dlg-input', 'deepseek-v4');
await page.click('.m-alert-btns button.primary');
await page.waitForTimeout(300);
check((await page.getAttribute('[role="switch"][aria-label="deepseek-v4"]', 'aria-checked')) === 'true', 'a model added by hand is picked');
await page.click('[role="switch"][aria-label="model-coder"]');
await page.waitForTimeout(100);
await shot('2-picked');

await page.click('.plg-btn.pri:has-text("添加")');
await page.waitForTimeout(800);
await shot('3-list');
check(await page.isVisible('.plg-row:has-text("芯云")'), 'listed as 芯云');
const st = await page.evaluate(() => {
  const h = window.__mockEngine.host;
  return { providers: h.settings.get('llm-pi-ai').value.providers, creds: window.__mockEngine.credentials };
});
const route = Object.keys(st.providers)[0];
const prof = st.providers[route];
check(route === 'custom-xinyuntoken', `route id dsh-Go accepts: ${route}`);
check(prof.displayName === '芯云' && prof.api === 'openai-completions' && prof.baseURL === 'https://xinyuntoken.com/v1', 'profile: name, protocol, address');
check(prof.apiKeyEnv === 'CUSTOM_XINYUNTOKEN_API_KEY' && !('apiKey' in prof) && st.creds.CUSTOM_XINYUNTOKEN_API_KEY === 'sk-xinyun-123', 'key stored as a credential, named by apiKeyEnv');
check(JSON.stringify(prof.models.map((m) => m.id)) === JSON.stringify(['model-large', 'model-small', 'deepseek-v4']) && prof.models[0].name === 'Model Large' && prof.models[0].contextWindow === 131072, `models as objects: ${JSON.stringify(prof.models)}`);

// its detail page has 测试连接 too
await page.click('.plg-row:has-text("芯云")');
await page.waitForTimeout(600);
await page.click('.prov-test .plg-row:has-text("网络连通") .plg-btn');
await page.waitForTimeout(800);
check((await page.textContent('.prov-test .plg-row:has-text("网络连通") .plg-row-s')).startsWith('通 · '), 'detail page: 网络连通');
await shot('4b-detail-test');
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(400);

// 账号管理 shows the providers and which one is in use
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(400);
await page.click('[aria-label="打开边栏"]', { timeout: 1500 }).catch(() => {});
await page.waitForTimeout(300);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(400);
await page.click('.m-row:has-text("账号管理")');
await page.waitForTimeout(800);
const provRows = async () => page.$$eval('.m-prov .m-row-t', (e) => e.map((x) => x.textContent));
check(JSON.stringify(await provRows()) === JSON.stringify(['芯云']), `only connected providers listed (DeepSeek isn't signed in here): ${(await provRows()).join(' ')}`);
// switch: 芯云 has several models, so pick one
await page.click('.m-prov:has-text("芯云")');
await page.waitForTimeout(300);
await page.click('.m-pop-row:has-text("model-small")');
await page.waitForTimeout(800);
check(await page.isVisible('.m-prov.on:has-text("芯云") .m-row-check'), '芯云 ticked as in use');
check((await page.textContent('.m-prov.on .m-row-v')) === 'model-small', `shows the model: ${await page.textContent('.m-prov.on .m-row-v')}`);
const dm = await page.evaluate(() => window.__mockEngine.host.defaultModel());
check(dm.provider === 'custom-xinyuntoken' && dm.model === 'model-small', `new chats' default on the engine: ${JSON.stringify(dm)}`);
await shot('5-account');
// 测试连接 for the one in use
check((await page.textContent('.m-group-h:has-text("测试连接")')).includes('芯云 · model-small'), 'the test is for what is in use');
await page.click('.m-row:has-text("网络连通")');
await page.waitForSelector('.m-probe-res', { timeout: 5000 });
check((await page.textContent('.m-probe-res >> nth=0')).startsWith('通 · ') && (await page.textContent('.m-probe-res >> nth=0')).includes('列出 3 个模型'), `network: ${await page.textContent('.m-probe-res >> nth=0')}`);
const before = await page.evaluate(() => [...window.__mockEngine.sessions.keys()].length);
await page.click('.m-row:has-text("真实小额测试")');
await page.waitForSelector('.m-alert');
check((await page.textContent('.m-alert')).includes('按正常价格计费'), 'asks first: it costs a little');
await page.click('.m-alert-btns button:has-text("发送")');
await page.waitForSelector('.m-probe-res >> nth=1', { timeout: 80000 });
const res = await page.textContent('.m-probe-res >> nth=1');
check(res.startsWith('成功 · ') && res.includes('回复「OK」') && res.includes('token'), `real test: ${res}`);
const probeSid = await page.evaluate(() => [...window.__mockEngine.sessions.keys()].at(-1));
const after = await page.evaluate(() => [...window.__mockEngine.sessions.keys()].length);
const model = await page.evaluate((id) => window.__mockEngine.sessions.get(id)?.model, probeSid);
check(after === before + 1 && model?.provider === 'custom-xinyuntoken' && model?.model === 'model-small', `it really asked 芯云 · model-small: ${JSON.stringify(model)}`);
await page.waitForTimeout(500);
await shot('5b-account-tested');
check(await page.evaluate((id) => window.__mockEngine.sessions.get(id)?.archived === true, probeSid), 'the test conversation is deleted afterwards');
await page.click('[aria-label="返回"] >> nth=-1');
await page.waitForTimeout(300);
await page.click('[aria-label="返回"] >> nth=-1').catch(() => {});
await page.waitForTimeout(300);
await page.click('[aria-label="打开边栏"]', { timeout: 1500 }).catch(() => {});
await page.waitForTimeout(400);
check(!(await page.textContent('.m-drawer')).includes('连通性测试'), 'and never shows in the sidebar');
await page.keyboard.press('Escape');
// the catalog has it now: pick one of its models in the picker, and 账号管理 says so
const picked = await page.evaluate(async () => {
  const c = await window.__mockEngine.rpc.call('session/modelCatalog', {});
  return c.groups.find((g) => g.id === 'custom-xinyuntoken')?.models.map((m) => m.id).join();
});
check(picked === 'model-large,model-small,deepseek-v4', `the model catalog lists 芯云's models: ${picked}`);
await page.goto('about:blank');
await page.goto(`${base}#plain`);
await page.waitForTimeout(1200);

// a bad address says why instead of doing nothing
await page.click('[aria-label="打开边栏"]');
await page.waitForTimeout(300);
await page.click('.m-me [aria-label="设置"]');
await page.waitForTimeout(300);
await page.click('.m-row:has-text("模型提供方")');
await page.waitForTimeout(500);
await page.click('.plg-link:has-text("添加提供方")');
await page.waitForTimeout(400);
await page.fill('input[placeholder="https://api.example.com/v1"]', 'xinyuntoken.com');
await page.fill('input[placeholder="只保存在主机上"]', 'sk-1');
await page.click('.plg-link:has-text("获取模型列表")');
await page.waitForTimeout(300);
check((await page.textContent('.prov-problem').catch(() => '')).includes('https://'), 'no scheme: says to start with https://');
await shot('4-bad-url');

await browser.close();
if (errors.length) {
  console.error('\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nprovider ok');
