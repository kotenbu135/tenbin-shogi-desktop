// ブラウザのプレビュー（npm run preview）で「両玉→選択→布石40手→本将棋の1手」を通す煙テスト。
//   node scripts/smoke-preview.mjs <画像の出力先>
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
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await page.evaluate(() => document.querySelector('.setup-dialog')?.close());
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('玉'), { timeout: 10000 });

const status = () => page.$eval('#status', (e) => e.textContent);
const click = async (sel) => {
  const h = await page.$(sel);
  if (!h) throw new Error('見つからない: ' + sel);
  await h.click();
};
const firstDest = async () => {
  const h = await page.$('.cell.dest');
  if (!h) throw new Error('dest が無い');
  return h;
};

console.log('0:', await status());
await click('.stand-pieces[data-color="sente"] .slot[data-role="king"]');
const nDestK = await page.$$eval('.cell.dest', (a) => a.length);
console.log('先手玉の置ける数:', nDestK);
await click('.cell[data-sq="5i"]');
console.log('1:', await status());
await click('.stand-pieces[data-color="gote"] .slot[data-role="king"]');
await click('.cell[data-sq="5a"]');
console.log('2:', await status());
await page.screenshot({ path: `${OUT}/shot-choose.png` });
await page.$$eval('.choose button', (bs) => bs.find((b) => b.textContent.includes('先手'))?.click());
console.log('3:', await status());

// 布石 38 手: 手番側の駒台の先頭の駒を、最初の置ける場所へ
for (let i = 0; i < 38; i++) {
  const turn = await page.$eval('#status', (e) => (e.textContent.includes('先手') ? 'sente' : 'gote'));
  const hand = await page.$(`.stand-pieces[data-color="${turn}"] .slot:not(:disabled)`);
  if (!hand) throw new Error(`${turn} の駒台に押せる駒が無い (i=${i})`);
  await hand.click();
  const d = await firstDest();
  await d.click();
  if (i === 10) await page.screenshot({ path: `${OUT}/shot-fuseki.png` });
}
console.log('40手後:', await status());
const kifuCount = await page.$$eval('.kifu-move', (a) => a.length);
console.log('棋譜の行数:', kifuCount);
await page.screenshot({ path: `${OUT}/shot-normal.png` });

// 本将棋: 動かせる先手の駒を探して1手
if ((await status()).includes('本将棋')) {
  const cells = await page.$$('.cell');
  let moved = false;
  for (const c of cells) {
    const has = await c.$('.piece.sente');
    if (!has) continue;
    await c.click();
    const d = await page.$('.cell.dest');
    if (d) {
      page.once('dialog', (dlg) => dlg.dismiss());
      await d.click();
      moved = true;
      break;
    }
  }
  console.log('本将棋の1手:', moved, await status());
}
// 待った
await page.$$eval('button[data-act="undo"]', (bs) => bs[0].click());
console.log('待った後:', await status(), '行数', await page.$$eval('.kifu-move', (a) => a.length));
await page.screenshot({ path: `${OUT}/shot-after-undo.png` });

// ダークテーマ
await page.$$eval('button[data-act="theme"]', (bs) => { bs[0].click(); bs[0].click(); });
await page.screenshot({ path: `${OUT}/shot-dark.png` });
// エンジン設定ダイアログ
await page.$$eval('button[data-act="engines"]', (bs) => bs[0].click());
await page.$$eval('[data-act="add"]', (bs) => bs[0].click());
await page.screenshot({ path: `${OUT}/shot-engine-form.png` });

console.log('errors:', errors.length ? errors : 'なし');
await browser.close();
