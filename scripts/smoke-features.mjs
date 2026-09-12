// ブラウザのプレビュー（npm run preview）で、時計・盤面反転・KIF の往復・局面編集・任意局面を通す煙テスト。
//   node scripts/smoke-features.mjs <画像の出力先>
import { readFileSync } from 'node:fs';
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
// 画面の言葉は日本語で確かめる（既定は端末の言語なので、ここで固定する）
await page.evaluate(() => localStorage.setItem('settings', JSON.stringify({ lang: 'ja' })));
await page.reload({ waitUntil: 'networkidle0' });
await page.evaluate(() => document.querySelector('.setup-dialog')?.close());
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('玉'), { timeout: 10000 });
const status = () => page.$eval('#status', (e) => e.textContent);
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (sel) => { const h = await page.$(sel); if (!h) throw new Error('見つからない: ' + sel); await h.click(); };
const playFuseki = async (n) => {
  for (let i = 0; i < n; i++) {
    const turn = await page.$eval('#status', (e) => (e.textContent.includes('先手') ? 'sente' : 'gote'));
    const hand = await page.$(`.stand-pieces[data-color="${turn}"] .slot:not(:disabled)`);
    if (!hand) throw new Error(`${turn} の駒台に押せる駒が無い (i=${i})`);
    await hand.click();
    const d = await page.$('.cell.dest');
    if (!d) throw new Error('dest が無い');
    await d.click();
  }
};

// 1. 時計つきの対局
await ev(() => window.tenbin.start('tenbin', { mainSec: 60, byoyomiSec: 10 }));
await click('.stand-pieces[data-color="sente"] .slot[data-role="king"]'); await click('.cell[data-sq="5i"]');
await sleep(1200);
await click('.stand-pieces[data-color="gote"] .slot[data-role="king"]'); await click('.cell[data-sq="5a"]');
await page.$$eval('.choose button', (bs) => bs[0].click());
await playFuseki(4);
console.log('時計:', await ev(() => [...document.querySelectorAll('.plate-clock')].map((e) => e.textContent).join(' | ')));
console.log('消費時間の列:', await ev(() => [...document.querySelectorAll('.kifu-move .tm')].map((e) => e.textContent).filter(Boolean).slice(0, 3).join(' | ')));

// 2. 盤面反転
await click('button[data-act="flip"]');
console.log('反転後の筋:', await ev(() => [...document.querySelectorAll('.files span')].map((e) => e.textContent).join('')),
  '/ 段:', await ev(() => [...document.querySelectorAll('.ranks span')].map((e) => e.textContent).join('')),
  '/ 奥の駒台:', await ev(() => document.querySelector('.stand.far .stand-pieces').dataset.color));
await page.screenshot({ path: `${OUT}/feat-flipped.png` });
await click('button[data-act="flip"]');

// 3. KIF の往復（40手まで進めて本将棋も1手）
await playFuseki(34);
console.log('40手後:', await status());
const cells = await page.$$('.cell');
for (const c of cells) {
  const has = await c.$('.piece.sente');
  if (!has) continue;
  await c.click();
  const d = await page.$('.cell.dest');
  if (d) { await d.click(); break; }
}
const kif = await ev(() => window.tenbin.kif());
console.log('KIF 先頭:\n' + kif.split('\n').slice(0, 8).join('\n'));
console.log('KIF 末尾:\n' + kif.split('\n').slice(-4).join('\n'));
const before = await ev(() => window.tenbin.game().moves.length);
await ev((t) => window.tenbin.load(t), kif);
const after = await ev(() => window.tenbin.game().moves.length);
console.log('往復: 手数', before, '→', after, '| 状態:', await status());
const kif2 = await ev(() => window.tenbin.kif());
{
  const a = kif.split('\n').filter((l) => !l.startsWith('開始日時'));
  const b = kif2.split('\n').filter((l) => !l.startsWith('開始日時'));
  const i = a.findIndex((l, j) => l !== b[j]);
  console.log('往復で同一:', i < 0 && a.length === b.length, i >= 0 ? `| 違い ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}` : '');
}
const normalKif = await ev(() => window.tenbin.kif(true));
console.log('本将棋だけの KIF 先頭:\n' + normalKif.split('\n').slice(0, 6).join('\n'));
console.log('本将棋だけの KIF 末尾:', normalKif.split('\n').slice(-3).join(' / '));

// 3.5 tenbinshogi.com の棋譜（布石はヘッダタグ、本文は 41 手目からの本将棋）を貼る
const siteKif = readFileSync(new URL('../src/kif/fixtures/tenbinshogi-com.kif', import.meta.url), 'utf8');
await ev((t) => window.tenbin.load(t), siteKif);
console.log(
  'サイトの棋譜:',
  '手数', await ev(() => window.tenbin.game().moves.length),
  '| 1 手目', await ev(() => window.tenbin.game().moves[0]?.usi),
  '| 41 手目', await ev(() => window.tenbin.game().moves.find((m) => m.ply === 41)?.usi),
  '| 状態:', await status(),
);

// 4. 局面編集
await click('button[data-act="edit"]');
console.log('編集中:', await ev(() => !document.getElementById('editor').hidden), '|', await status());
await page.screenshot({ path: `${OUT}/feat-editor.png` });
await ev(() => [...document.querySelectorAll('.editor-actions button')].find((b) => b.textContent === '平手の初期配置').click());
await ev(() => document.querySelectorAll('.palette-row')[0].querySelectorAll('.palette-piece')[7].click()); // 先手の歩
await click('.cell[data-sq="5e"]');
console.log('５五に置いた:', await ev(() => document.querySelector('.cell[data-sq="5e"] .piece')?.dataset.code));
await ev(() => [...document.querySelectorAll('.editor-actions button')].find((b) => b.textContent.includes('この局面から')).click());
console.log('編集から開始:', await status(), '| 編集中:', await ev(() => !document.getElementById('editor').hidden));
console.log('SFEN:', await ev(() => window.tenbin.game().positionCommand()));

// 5. 任意局面からの本将棋を KIF に
await click('.cell[data-sq="7g"]'); await click('.cell[data-sq="7f"]');
const k3 = await ev(() => window.tenbin.kif(true));
console.log('任意局面 KIF:', k3.split('\n').filter((l) => /^\s*\d+ /.test(l)).join(' / '));
await ev((t) => window.tenbin.load(t), k3);
console.log('任意局面 KIF 読み込み:', await status());
await page.screenshot({ path: `${OUT}/feat-position.png` });

// 6. 玉を置く前に終わった対局も、保存して開き直せば天秤将棋のまま（平手にならない）
await ev(() => window.tenbin.start('tenbin', null));
await ev(() => window.tenbin.game().apply('resign'));
const k4 = await ev(() => window.tenbin.kif());
await ev((t) => window.tenbin.load(t), k4);
console.log(
  '玉を置く前の投了:',
  'モード', await ev(() => window.tenbin.game().mode),
  '| 手数', await ev(() => window.tenbin.game().moves.length),
  '| タグ', JSON.stringify(k4.split('\n').filter((l) => l.startsWith('天秤'))),
  '|', await status(),
);

console.log('errors:', errors.length ? errors : 'なし');
await browser.close();
