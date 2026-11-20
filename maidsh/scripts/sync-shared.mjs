// 把 shared/ 下的共用文件复制进每个包的 lib/shared/（每个包要能单独装）。
// 改 shared/ 后跑一次：node scripts/sync-shared.mjs；--check 只检查是否一致（测试和 CI 用）。
import { copyFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['core', 'mood', 'bond'];
const check = process.argv.includes('--check');
const files = readdirSync(join(root, 'shared')).filter((f) => f.endsWith('.mjs'));
let stale = [];
for (const p of PACKAGES) {
  const dir = join(root, p, 'lib', 'shared');
  for (const f of files) {
    const src = join(root, 'shared', f);
    const dst = join(dir, f);
    const same = existsSync(dst) && readFileSync(dst, 'utf8') === readFileSync(src, 'utf8');
    if (same) continue;
    if (check) stale.push(`${p}/lib/shared/${f}`);
    else {
      mkdirSync(dir, { recursive: true });
      copyFileSync(src, dst);
    }
  }
}
if (stale.length) {
  console.error(`共用文件没同步：${stale.join('、')}。跑 node scripts/sync-shared.mjs`);
  process.exit(1);
}
