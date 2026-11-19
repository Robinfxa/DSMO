// Skill folders in a plugin package → inline text files: what the App writes
// to the engine's ~/.dsh/skills/<name>/. Shared by check.mjs and build-index.mjs.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function inlineSkills(skills, dir) {
  return (skills || []).map((sk) => {
    if (sk.files) return sk;
    const root = join(dir, sk.dir || `skills/${sk.name}`);
    const files = {};
    const walk = (d, rel, depth) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) { if (depth < 3) walk(join(d, ent.name), r, depth + 1); }
        else files[r] = readFileSync(join(d, ent.name), 'utf8');
      }
    };
    if (existsSync(root)) walk(root, '', 0);
    return { name: sk.name, files };
  });
}
