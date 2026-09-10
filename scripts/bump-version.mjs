// 版を上げる。`node scripts/bump-version.mjs 0.4.1`
//
// 版は 5 つのファイルに散っていて（package.json / package-lock.json の 2 行 /
// tauri.conf.json / src-tauri/Cargo.toml / Cargo.lock）、手で直すと必ずどれかを落とす。
// 落とすと、インストーラの版と自動更新の latest.json の版が食い違う。
//
// 直したあとに全部が同じ版になっているかを数え直し、1 つでも古いままなら落とす。

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('使い方: node scripts/bump-version.mjs <x.y.z>');
  process.exit(1);
}

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const write = (rel, s) => writeFileSync(path.join(ROOT, rel), s);

/** その 1 箇所だけを置き換える。当たらなければ落とす（黙って素通りさせない） */
function sub(rel, re, make) {
  const before = read(rel);
  const m = re.exec(before);
  if (!m) throw new Error(`${rel}: 版の行が見つからない（${re}）`);
  const after = before.replace(re, make);
  write(rel, after);
  return m[0];
}

const cur = JSON.parse(read('package.json')).version;
if (cur === next) {
  console.error(`もう ${next} になっている`);
  process.exit(1);
}

// package.json と package-lock.json（根と自分自身の 2 行）
sub('package.json', /("version":\s*")[\d.]+(")/, (_, a, b) => a + next + b);
{
  const lock = JSON.parse(read('package-lock.json'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  write('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
}
sub('src-tauri/tauri.conf.json', /("version":\s*")[\d.]+(")/, (_, a, b) => a + next + b);
sub('src-tauri/Cargo.toml', /(name = "tenbin-shogi-gui"\nversion = ")[\d.]+(")/, (_, a, b) => a + next + b);
sub('Cargo.lock', /(name = "tenbin-shogi-gui"\nversion = ")[\d.]+(")/, (_, a, b) => a + next + b);

// 数え直し。どこかに古い版が残っていないか
const checks = [
  ['package.json', JSON.parse(read('package.json')).version],
  ['package-lock.json (根)', JSON.parse(read('package-lock.json')).version],
  ['package-lock.json (自分自身)', JSON.parse(read('package-lock.json')).packages['']?.version],
  ['src-tauri/tauri.conf.json', JSON.parse(read('src-tauri/tauri.conf.json')).version],
  ['src-tauri/Cargo.toml', /version = "([\d.]+)"/.exec(read('src-tauri/Cargo.toml').split('[lib]')[0])?.[1]],
  ['Cargo.lock', /name = "tenbin-shogi-gui"\nversion = "([\d.]+)"/.exec(read('Cargo.lock'))?.[1]],
];
let bad = 0;
for (const [where, got] of checks) {
  const ok = got === next;
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✖'} ${where}: ${got}`);
}
if (bad) {
  console.error(`${bad} 箇所が ${next} になっていない`);
  process.exit(1);
}
console.log(`\n${cur} → ${next}。CHANGELOG.md に変更点を書いてから、tag を打つ。`);
