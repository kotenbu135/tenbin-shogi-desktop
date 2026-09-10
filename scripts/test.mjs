// テストを走らせる。
//
// `node --test 'src/**/*.test.ts'` を直に書かないのは、**一致が 0 件でも終了コードが 0** で、
// CI が「何も検査していないのに緑」になるため（0.4.0 まではシェルの glob 頼みで、
// sh に globstar が無いので `src/*/*.test.ts` に落ちていた＝深い場所のテストは黙って走らなかった）。
// ここで自分で数え、0 なら落とす。

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'src');

async function collect(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collect(p)));
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = (await collect(ROOT)).sort();
if (files.length === 0) {
  console.error('テストファイルが 1 つも無い（src/**/*.test.ts）。glob か置き場所を疑う。');
  process.exit(1);
}
console.log(`${files.length} 本のテストファイル`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
