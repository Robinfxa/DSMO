#!/usr/bin/env node
// Builds market/index.json from market/plugins/*.json (pinned entries) and
// the package sources under plugins/. v1 lists official plugins only (Q8).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest, tierOf } from './rules.mjs';
import { inlineSkills } from './skills.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const market = join(here, '..');
const root = join(market, '..');
const policy = JSON.parse(readFileSync(join(market, 'policy.json'), 'utf8'));
const out = [];
let bad = false;
for (const f of readdirSync(join(market, 'plugins')).filter((x) => x.endsWith('.json')).sort()) {
  const entry = JSON.parse(readFileSync(join(market, 'plugins', f), 'utf8'));
  const dir = join(root, entry.source);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.name !== entry.package || pkg.version !== entry.version) { console.error(`✗ ${f}: 固定的版本 ${entry.package}@${entry.version} 和源码 ${pkg.name}@${pkg.version} 不一致`); bad = true; continue; }
  if (!policy.official.includes(pkg.name) && policy.officialOnly) { console.error(`✗ ${f}: v1 只收官方插件`); bad = true; continue; }
  const manifest = { ...pkg.apiDemo, id: pkg.name, version: pkg.version, license: pkg.license, official: policy.official.includes(pkg.name) };
  for (const [id, p] of Object.entries(manifest.panels || {})) {
    const file = join(dir, p.entry);
    if (!existsSync(file)) { console.error(`✗ ${pkg.name}: 面板 ${id} 的 ${p.entry} 不存在`); bad = true; continue; }
    manifest.panels[id] = { title: p.title, html: readFileSync(file, 'utf8') };
  }
  if (manifest.skills) manifest.skills = inlineSkills(manifest.skills, dir);
  const { errors } = checkManifest(manifest);
  if (errors.length) { bad = true; errors.forEach((x) => console.error(`✗ ${pkg.name}: ${x}`)); continue; }
  const integrity = 'sha256-' + createHash('sha256').update(JSON.stringify(manifest)).digest('base64');
  out.push({ tier: tierOf(manifest), integrity, manifest });
}
if (bad) process.exit(1);
writeFileSync(join(market, 'index.json'), JSON.stringify({ v: 1, plugins: out }, null, 2) + '\n');
console.log(`market/index.json: ${out.length} 个插件`);
