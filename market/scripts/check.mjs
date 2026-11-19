#!/usr/bin/env node
// Usage: node market/scripts/check.mjs <plugin-dir>...   (exit 1 on any error)
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkManifest, tierOf } from './rules.mjs';
import { inlineSkills } from './skills.mjs';

let failed = false;
for (const dir of process.argv.slice(2)) {
  const pkgPath = join(resolve(dir), 'package.json');
  if (!existsSync(pkgPath)) { console.error(`✗ ${dir}: 没有 package.json`); failed = true; continue; }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const m = { ...pkg.apiDemo, id: pkg.name, version: pkg.version };
  if (m.skills) m.skills = inlineSkills(m.skills, resolve(dir));
  const panelHtml = {};
  for (const [id, p] of Object.entries(m.panels || {})) {
    const f = p.entry && join(resolve(dir), p.entry);
    if (f && existsSync(f)) panelHtml[id] = readFileSync(f, 'utf8');
  }
  if (pkg.license === undefined) console.warn(`! ${pkg.name}: 没有写 license`);
  const { errors, warn } = checkManifest(m, { panelHtml });
  for (const w of warn) console.warn(`! ${pkg.name}: ${w}`);
  if (errors.length) { failed = true; for (const x of errors) console.error(`✗ ${pkg.name}: ${x}`); }
  else console.log(`✓ ${pkg.name}@${pkg.version}  第 ${tierOf(m)} 级`);
}
process.exit(failed ? 1 : 0);
