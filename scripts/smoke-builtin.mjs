// ブラウザのプレビュー（npm run preview）で、内蔵の布石評価（onnxruntime-web）と対局の進行役を通す煙テスト。
//   node scripts/smoke-builtin.mjs <画像の出力先>
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2] ?? '.';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1360, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('玉'), { timeout: 10000 });
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const status = () => page.$eval('#status', (e) => e.textContent);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (sel) => { const h = await page.$(sel); if (!h) throw new Error('見つからない: ' + sel); await h.click(); };

// 1. 内蔵の評価が読めた
await page.waitForFunction(() => window.tenbin?.builtin?.(), { timeout: 30000 });
console.log('内蔵:', await ev(() => { const b = window.tenbin.builtin(); return `${b.manifest.generation} kings=${!!b.kings}`; }));

// 2. 天秤将棋の 1 手目を内蔵で検討（両玉の価値表）
await click('.tab[data-tab="analysis"]');
await click('button[data-act="toggle"]');
await page.waitForFunction(() => document.querySelectorAll('.analysis-slot .cand').length > 0, { timeout: 20000 });
console.log('1手目の候補:', await ev(() => [...document.querySelectorAll('.analysis-slot .cand')].slice(0, 3).map((c) => c.querySelector('.c-pv .move').textContent + ' ' + c.querySelector('.c-p .num').textContent).join(' | ')),
  '/ 出どころ:', await ev(() => document.querySelector('.analysis-slot .engine-stats').textContent));

// 3. 両玉を置いて選び、布石 3 手目を内蔵で検討（価値ネット）
await click('.stand-pieces[data-color="sente"] .slot[data-role="king"]'); await click('.cell[data-sq="5i"]');
await click('.stand-pieces[data-color="gote"] .slot[data-role="king"]'); await click('.cell[data-sq="5a"]');
await page.$$eval('.choose button', (bs) => bs[0].click());
try {
  await page.waitForFunction(() => document.querySelectorAll('.analysis-slot .cand').length >= 3 && document.querySelector('.analysis-slot .engine-stats').textContent.includes('価値ネット'), { timeout: 20000 });
} catch (e) {
  console.log('3手目の検討が来ない。枠の状態:', await ev(() => [...document.querySelectorAll('.analysis-slot')].map((s) => `${s.querySelector('.engine-name')?.textContent} | notice=${s.querySelector('.analysis-notice')?.textContent} | ${s.querySelector('.engine-stats')?.textContent} | cands=${s.querySelectorAll('.cand').length}`).join(' || ')));
  console.log('直接評価:', await ev(async () => { try { const r = await window.tenbin.builtin().evaluate(['K*5i', 'K*5a'], 'value', { tenbin: false }); return JSON.stringify(r).slice(0, 200); } catch (e) { return 'ERR ' + (e.stack || e.message); } }));
  console.log('status:', await status(), '| positionCmd:', await ev(() => window.tenbin.game().positionCommand()));
  throw e;
}
const t0 = Date.now();
console.log('3手目の候補:', await ev(() => [...document.querySelectorAll('.analysis-slot .cand')].slice(0, 3).map((c) => c.querySelector('.c-pv .move').textContent + ' ' + c.querySelector('.c-score').textContent + ' ' + c.querySelector('.c-p .num').textContent).join(' | ')));
// グラフは下の欄のタブ。開いてから読む
await ev(() => document.querySelector('.tab[data-tab="winrate"]').click());
await new Promise((r) => setTimeout(r, 150));
console.log('矢印/印:', await ev(() => document.querySelectorAll('svg.shapes .shape').length), '/ グラフ:', await ev(() => document.querySelector('#graph-winrate')?.textContent?.match(/\d+\.\d%/)?.[0]), '/ 点:', await ev(() => document.querySelectorAll('#graph-winrate .pt').length));
await ev(() => document.querySelector('.tab[data-tab="analysis"]').click());
await page.screenshot({ path: `${OUT}/builtin-analysis.png` });

// 4. 枠を足して内蔵を 2 本目に（同じ局面で 2 枠）
await click('button[data-act="add"]');
await ev(() => { const s = document.querySelectorAll('.analysis-slot select')[1]; s.value = 'builtin'; s.dispatchEvent(new Event('change')); });
await page.waitForFunction(() => document.querySelectorAll('.analysis-slot')[1]?.querySelectorAll('.cand').length > 0, { timeout: 20000 });
console.log('2枠目:', await ev(() => document.querySelectorAll('.analysis-slot')[1].querySelector('.engine-name').textContent));
await click('button[data-act="toggle"]');

// 5. 内蔵同士の天秤将棋（布石 40 手 + 選択まで自動。本将棋は人）
await ev(() => window.tenbin.play({
  mode: 'tenbin',
  seats: [{ type: 'engine', normalId: '', fusekiId: 'builtin', level: 5, secPerMove: 1 }, { type: 'engine', normalId: '', fusekiId: 'builtin', level: 3, secPerMove: 1 }],
  names: ['甲', '乙'],
  timeControl: null,
}));
await page.waitForFunction(() => window.tenbin.game().moves.length >= 41, { timeout: 120000 });
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log('自動対局:', await status(), '| 手数', await ev(() => window.tenbin.game().moves.length), '| 選択', await ev(() => window.tenbin.game().chosenColor), '|', sec, '秒');
console.log('名札:', await ev(() => [...document.querySelectorAll('.plate-name')].map((e) => e.textContent).join(' / ')));
await page.screenshot({ path: `${OUT}/builtin-play.png` });

// 6. エンジン登録の画面がプレビューでも開く
await click('button[data-act="engines"]');
console.log('登録画面:', await ev(() => document.querySelector('.engine-dialog h2')?.textContent), '|', await ev(() => document.querySelector('.engine-dialog .hint')?.textContent.slice(0, 40)));
await ev(() => document.querySelector('.engine-dialog [data-act="add"]').click());
console.log('追加の画面:', await ev(() => document.querySelector('.engine-dialog h2')?.textContent), '| 目盛り:', await ev(() => document.querySelector('.engine-dialog select[name="preset"]')?.value));
await page.screenshot({ path: `${OUT}/engine-form.png` });

console.log('errors:', errors.length ? errors : 'なし');
await browser.close();
