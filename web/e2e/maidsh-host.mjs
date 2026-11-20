// A stand-in DSH for the 陪伴 e2e: the real MaiDSH plugins (maidsh/*/lib/index.mjs) under the
// cordis they are written against, with the DSH services they use played here — webServer
// (their /api/maidsh* routes), systemPrompt, llm (a scripted model) — and the prototype page
// served from the same origin, so the plugins' own loopback / same-origin checks pass as in the app.
//
//   const host = await startMaidshHost({ modules: ['core', 'mood', 'bond', 'memory', 'expression', 'initiative'] });
//   host.url  → http://127.0.0.1:<port>/index.html
//   host.ctx  → the cordis context (services: companionMood, companionBond, …)
//   await host.stop();

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const dist = path.join(here, '..', 'dist-proto');
const { Context } = await import(pathToFileURL(path.join(repo, 'maidsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

/** The scripted model: a learning chunk (core/lib/batch.mjs: one JSON object keyed by aspect id) or a turn's analysis. */
function scriptedModel(system, user) {
  if (/读一份材料/.test(system))
    return JSON.stringify({
      memory: {
        facts: [
          { text: '喜欢下雨天在家看书', cat: 'pref', kw: ['下雨', '看书'] },
          { text: '在多伦多读计算机', cat: 'identity', kw: ['多伦多', '计算机'] },
        ],
        episodes: [{ at: '2026-03-02', title: '第一次聊到深夜', summary: '聊了很多以前的事', salience: 6, feeling: '感动', kw: ['深夜'] }],
      },
      expression: {
        learn: /那还用说/.test(user) ? [{ when: '被夸的时候', say: '那还用说', tone: 'playful' }] : [],
        slang: /小狗勾/.test(user) ? [{ word: '小狗勾', means: '撒娇时的自称' }] : [],
      },
    });
  return JSON.stringify({ feeling: { label: '开心', intensity: 0.8 } });
}

export async function startMaidshHost({ modules = ['core', 'mood', 'bond', 'memory', 'expression', 'initiative'], model = scriptedModel } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maidsh-e2e-'));
  process.env.DSH_HOME = dataRoot;
  const routes = new Map();
  const ctx = new Context();
  ctx.provide('webServer', {
    register({ path: p, handler }) {
      routes.set(p, handler);
      return () => routes.delete(p);
    },
  });
  ctx.provide('systemPrompt', {
    context: () => () => {},
    section: () => () => {},
  });
  ctx.provide('llm', {
    stream: async function* ({ system, messages }) {
      const user = (messages ?? []).map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join('\n');
      yield { type: 'text-delta', text: model(system ?? '', user) };
      yield { type: 'finish', reason: { kind: 'completed' } };
    },
  });
  // the route a learning job uses when no turn has run yet (DSH: the agent's default model)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) });

  for (const m of modules) {
    const mod = await import(pathToFileURL(path.join(repo, 'maidsh', m, 'lib', 'index.mjs')).href);
    ctx.plugin(mod, { dataDir: path.join(dataRoot, m) });
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const handler = routes.get(u.pathname);
    if (handler) return void Promise.resolve(handler(req, res)).catch((e) => ((res.statusCode = 500), res.end(String(e))));
    if (u.pathname.startsWith('/api/')) {
      res.statusCode = 404;
      return res.end('{"ok":false,"error":"not found"}');
    }
    const file = path.join(dist, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
    if (!file.startsWith(dist) || !fs.existsSync(file)) return void ((res.statusCode = 404), res.end());
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // let every plugin's ctx.inject([...]) settle
  await new Promise((r) => setTimeout(r, 300));
  return {
    url: `http://127.0.0.1:${port}/index.html`,
    ctx,
    routes,
    async stop() {
      server.close();
      ctx.registry?.dispose?.();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

// node e2e/maidsh-host.mjs: start it and print what answers
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = await startMaidshHost();
  console.log('routes:', [...host.routes.keys()].join(' '));
  for (const p of ['/api/maidsh/state', '/api/maidsh-memory/list', '/api/maidsh-expression/list', '/api/maidsh-initiative/state', '/api/maidsh/jobs']) {
    const r = await fetch(new URL(p, host.url));
    console.log(p, r.status, (await r.text()).slice(0, 400));
  }
  await host.stop();
  process.exit(0);
}
