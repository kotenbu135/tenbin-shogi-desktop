// ブラウザのプレビューで、対局の枠（エンジンの読みを検討パネルに出す）・対局中のグラフ・終局後の検討・
// 棋譜解析・グラフを押して局面へ移る・名札の折り返し、を通す煙テスト。
//   node scripts/smoke-review.mjs <画像の出力先>
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
await page.waitForFunction(() => window.tenbin?.builtin?.(), { timeout: 30000 });
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const status = () => page.$eval('#status', (e) => e.textContent);
const click = async (sel) => { const h = await page.$(sel); if (!h) throw new Error('見つからない: ' + sel); await h.click(); };

// 1. 名札: 時計つきで手番でない側の名前が 1 行に収まる（縦に折れない）
await ev(() => window.tenbin.start('tenbin', { mainSec: 60, byoyomiSec: 10 }));
const plates = await ev(() => [...document.querySelectorAll('.plate')].map((p) => {
  const n = p.querySelector('.plate-name').getBoundingClientRect();
  const c = p.querySelector('.plate-clock')?.getBoundingClientRect();
  return `${p.querySelector('.plate-name').textContent}: 名前の高さ ${Math.round(n.height)}px, 時計 ${c ? Math.round(c.top - n.top) + 'px 下' : '無し'}`;
}));
console.log('名札:', plates.join(' | '));
const stands = await ev(() => { const f = document.querySelector('.stand.far').getBoundingClientRect(); const n = document.querySelector('.stand.near').getBoundingClientRect(); const b = document.querySelector('.board').getBoundingClientRect(); return `奥の駒台 top=${Math.round(f.top - b.top)} 手前の駒台 bottom=${Math.round(b.bottom - n.bottom)}`; });
console.log('駒台の位置（盤との差）:', stands);

// 2. 内蔵同士の対局: 対局の枠に読みが出て、グラフに「対局」の系列が乗る
const t0 = Date.now();
await ev(() => window.tenbin.play({
  mode: 'tenbin',
  seats: [{ type: 'engine', normalId: '', fusekiId: 'builtin', level: 4, secPerMove: 1 }, { type: 'engine', normalId: '', fusekiId: 'builtin', level: 4, secPerMove: 1 }],
  names: ['甲', '乙'],
  timeControl: null,
}));
await page.waitForFunction(() => document.querySelectorAll('.analysis-slot.player').length >= 1 && window.tenbin.game().moves.length >= 10, { timeout: 60000 });
console.log('対局の枠:', await ev(() => [...document.querySelectorAll('.analysis-slot.player')].map((s) => `${s.querySelector('.player-label').textContent} / ${s.querySelector('.engine-name').textContent} / ${s.querySelectorAll('.cand').length}候補`).join(' || ')));
console.log('グラフ（途中）:', await ev(() => `対局 ${window.tenbin.evals().filter((e) => e.source === 'play').length} 点 / 検討 ${window.tenbin.evals().filter((e) => e.source === 'analysis').length} 点`), '| 天秤の図:', await ev(() => !!document.querySelector('#graph .scale')));
await page.screenshot({ path: `${OUT}/review-play.png` });
await page.waitForFunction(() => window.tenbin.game().moves.length >= 41, { timeout: 120000 });
console.log('布石まで:', await status(), '|', ((Date.now() - t0) / 1000).toFixed(1), '秒 | 対局の点:', await ev(() => window.tenbin.evals().filter((e) => e.source === 'play').length));

// 3. 本将棋を人が投了 → 終局後も検討できる（内蔵は本将棋を評価しないので、40 手目の局面に戻って検討）
await click('button[data-act="resign"]');
console.log('終局:', await status(), '| 右上:', await ev(() => document.querySelector('.result')?.textContent));
await click('button[data-act="toggle"]');
await new Promise((r) => setTimeout(r, 800));
console.log('終局局面の検討（本将棋のエンジン無し）:', await ev(() => document.querySelector('.user-slots .analysis-notice')?.textContent));
// 投了の行と 41 手目の局面を戻り、40 手目（布石の最後）の局面へ。内蔵の評価で検討できる
await ev(() => document.querySelector('.kifu-nav [data-seek="prev"]').click());
await ev(() => document.querySelector('.kifu-nav [data-seek="prev"]').click());
await page.waitForFunction(() => document.querySelectorAll('.user-slots .cand').length > 0, { timeout: 20000 });
console.log('布石の最後の局面の検討:', await ev(() => document.querySelector('.user-slots .engine-stats').textContent), '|', await ev(() => [...document.querySelectorAll('.user-slots .cand')].slice(0, 2).map((c) => c.querySelector('.move').textContent + ' ' + c.querySelector('.num').textContent + ' ' + c.querySelector('.cp').textContent).join(' | ')));
await click('button[data-act="toggle"]');
await page.screenshot({ path: `${OUT}/review-over.png` });

// 4. 棋譜解析（内蔵で 41 局面）
const t1 = Date.now();
const n = await ev(() => window.tenbin.kifuAnalysis({ fromIndex: 0, secPerMove: 0.5 }));
console.log('棋譜解析:', n, '局面 |', ((Date.now() - t1) / 1000).toFixed(1), '秒 | 検討の点:', await ev(() => window.tenbin.evals().filter((e) => e.source === 'analysis').length), '| 凡例:', await ev(() => document.querySelector('#graph .legend')?.textContent));
await page.screenshot({ path: `${OUT}/review-kifu.png` });

// 5. グラフを押して局面へ移る
const g = await page.$('#graph svg');
const box = await g.boundingBox();
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height / 2);
console.log('グラフを押した:', await status());
// 過去の局面を見たあと最新へ戻っても、wasm の手番が棋譜と合っている（rebuild の後始末）
await page.keyboard.press('End');
console.log('最新へ戻った:', await status(), '| 手番の整合:', await ev(() => { const g = window.tenbin.game(); const last = g.moves.filter((m) => m.color).at(-1); return `最後に指した ${last.color} → 手番 ${g.turn}`; }));

console.log('errors:', errors.length ? errors : 'なし');
await browser.close();
