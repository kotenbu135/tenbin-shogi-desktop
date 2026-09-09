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
// はじめての起動（設定が空）では、はじめの案内が出る
await page.evaluate(() => localStorage.removeItem('settings'));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.tenbin?.builtin?.(), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 400));
console.log('はじめての起動:', await page.evaluate(() => {
  const d = document.querySelector('.setup-dialog');
  if (!d?.open) return '案内が出ない';
  const body = d.querySelector('.setup-body').getBoundingClientRect().height;
  const acts = [...d.querySelectorAll('button[data-act]')].map((b) => b.dataset.act).join(',');
  const theme = document.documentElement.getAttribute('data-theme');
  d.close();
  return `案内が出た · 高さ ${Math.round(body)}px（1 画面に収まる） · 操作 ${acts} · テーマ ${theme}`;
}));
// 古い形の設定（タブ 1 枚を覚えるだけ）から読み直せるか。実機の settings.json はこの形で残っている
await page.evaluate(() => localStorage.setItem('settings', JSON.stringify({ seenSetup: true, layout: { recordWidth: 300, bottomHeight: 250, tab: 'winrate' } })));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.tenbin?.builtin?.(), { timeout: 30000 });
const ev = (fn, ...args) => page.evaluate(fn, ...args);
const status = () => page.$eval('#status', (e) => e.textContent);
const click = async (sel) => { const h = await page.$(sel); if (!h) throw new Error('見つからない: ' + sel); await h.click(); };
const tab = async (id) => { await click(`.tab[data-tab="${id}"]`); await new Promise((r) => setTimeout(r, 150)); };
const panes = () => ev(() => [...document.querySelectorAll('.pane')].map((p) => [...p.querySelectorAll('.tab')].map((t) => t.textContent + (t.getAttribute('aria-selected') === 'true' ? '*' : '')).join('・')).join(' | '));
const playPoints = () => ev(() => window.tenbin.evals().filter((e) => e.source === 'sente' || e.source === 'gote').length);

// 0. 割りつけ: 上に盤と棋譜、下は 2 欄（検討｜グラフ）。古い設定からの引き継ぎもここで見る
console.log('割りつけ:', await ev(() => {
  const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? `${Math.round(b.width)}x${Math.round(b.height)}` : '無し'; };
  return `盤 ${r('.board-col')} / 棋譜 ${r('.record-pane')} / 下の欄 ${document.querySelectorAll('.pane').length} 枠`;
}));
console.log('欄とタブ（古い設定から）:', await panes(), '| 候補手とグラフが同時に見える:', await ev(() => {
  const vis = (s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.clientWidth > 0; };
  return vis('#play') && (vis('#graph-score') || vis('#graph-winrate'));
}));

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
console.log('候補手の欄:', await ev(() => [...document.querySelectorAll('.play-slots .analysis-slot')].map((s) => `${s.querySelector('.player-label').textContent} / ${s.querySelector('.engine-name').textContent} / ${s.querySelectorAll('.cand').length}候補`).join(' || ')), '| 左右:', await ev(() => getComputedStyle(document.querySelector('.play-slots')).gridTemplateColumns));
console.log('グラフ（途中）:', `対局 ${await playPoints()} 点 / 検討 ${await ev(() => window.tenbin.evals().filter((e) => e.source === 'analysis').length)} 点`, '| 天秤の図:', await ev(() => !!document.querySelector('.graph .scale')));
await page.screenshot({ path: `${OUT}/review-play.png` });
await page.waitForFunction(() => window.tenbin.game().moves.length >= 41, { timeout: 120000 });
console.log('布石まで:', await status(), '|', ((Date.now() - t0) / 1000).toFixed(1), '秒 | 対局の点:', await playPoints());

// 3. 本将棋を人が投了 → 終局後も検討できる（内蔵は本将棋を評価しないので、40 手目の局面に戻って検討）
await click('button[data-act="resign"]');
await tab('analysis');
console.log('終局:', await status(), '| 右上:', await ev(() => document.querySelector('.result')?.textContent));
await click('button[data-act="toggle"]');
await new Promise((r) => setTimeout(r, 800));
console.log('終局局面の検討（本将棋のエンジン無し）:', await ev(() => document.querySelector('.user-slots .analysis-notice')?.textContent));
// 投了の行と 41 手目の局面を戻り、40 手目（布石の最後）の局面へ。内蔵の評価で検討できる
await ev(() => document.querySelector('.kifu-nav [data-seek="prev"]').click());
await ev(() => document.querySelector('.kifu-nav [data-seek="prev"]').click());
await page.waitForFunction(() => document.querySelectorAll('.user-slots .cand').length > 0, { timeout: 20000 });
console.log('布石の最後の局面の検討:', await ev(() => document.querySelector('.user-slots .engine-stats').textContent), '|', await ev(() => [...document.querySelectorAll('.user-slots .cand')].slice(0, 2).map((c) => `${c.querySelector('.c-pv .move').textContent} ${c.querySelector('.c-score').textContent} ${c.querySelector('.c-p .num').textContent}`).join(' | ')));
await click('button[data-act="toggle"]');
await page.screenshot({ path: `${OUT}/review-over.png` });

// 4. 棋譜解析（内蔵で 41 局面）
const t1 = Date.now();
const n = await ev(() => window.tenbin.kifuAnalysis({ fromIndex: 0, secPerMove: 0.5 }));
console.log('棋譜解析:', n, '局面 |', ((Date.now() - t1) / 1000).toFixed(1), '秒 | 検討の点:', await ev(() => window.tenbin.evals().filter((e) => e.source === 'analysis').length));
await page.screenshot({ path: `${OUT}/review-kifu.png` });

// 5. グラフの 2 タブ。期待勝率（0〜100%）と評価値（±2000）で系列が描かれる
await tab('winrate');
const winrate = await ev(() => ({
  points: document.querySelectorAll('#graph-winrate .pt').length,
  sente: document.querySelectorAll('#graph-winrate .pt.sente').length,
  gote: document.querySelectorAll('#graph-winrate .pt.gote').length,
  analysis: document.querySelectorAll('#graph-winrate .pt.analysis').length,
  axis: [...document.querySelectorAll('#graph-winrate .axis')].slice(0, 3).map((t) => t.textContent).join(' '),
}));
console.log('期待勝率のグラフ:', JSON.stringify(winrate), '| 凡例:', await ev(() => document.querySelector('#graph-winrate .legend')?.textContent));
await page.screenshot({ path: `${OUT}/review-winrate.png` });
await tab('score');
const score = await ev(() => ({
  points: document.querySelectorAll('#graph-score .pt').length,
  approx: document.querySelectorAll('#graph-score .pt.approx').length,
  axis: [...document.querySelectorAll('#graph-score .axis')].slice(0, 5).map((t) => t.textContent).join(' '),
}));
console.log('評価値のグラフ:', JSON.stringify(score), '| 凡例:', await ev(() => document.querySelector('#graph-score .legend')?.textContent));
await page.screenshot({ path: `${OUT}/review-score.png` });

// 6. グラフを押して局面へ移る
const g = await page.$('#graph-score svg');
const box = await g.boundingBox();
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height / 2);
console.log('グラフを押した:', await status());
// 過去の局面を見たあと最新へ戻っても、wasm の手番が棋譜と合っている（rebuild の後始末）
await page.keyboard.press('End');
console.log('最新へ戻った:', await status(), '| 手番の整合:', await ev(() => { const g = window.tenbin.game(); const last = g.moves.filter((m) => m.color).at(-1); return `最後に指した ${last.color} → 手番 ${g.turn}`; }));

// 7. 配置の窓: ひな形（1 欄 / 3 欄 / 2 欄）とタブの移動。検討の枠は欄の幅で列数が変わる
await tab('analysis');
await click('.analysis-head [data-act="add"]');
await click('.analysis-head [data-act="add"]');
await new Promise((r) => setTimeout(r, 200));
const slotCols = () => ev(() => {
  const cols = getComputedStyle(document.querySelector('.user-slots')).gridTemplateColumns.split(' ').length;
  const pv = document.querySelector('.user-slots .c-pv')?.getBoundingClientRect().width ?? 0;
  return `${document.querySelectorAll('.user-slots .analysis-slot').length} 枠 / ${cols} 列 / 読み筋の幅 ${Math.round(pv)}px`;
});
console.log('2 欄のとき:', await slotCols());
// 配置の窓は「はじめに」から開く（ツールバーの配置ボタンは外した）
const openLayout = async () => { await click('button[data-act="setup"]'); await click('.setup-dialog [data-act="layout"]'); await new Promise((r) => setTimeout(r, 150)); };
const closeLayout = async () => { await ev(() => document.querySelector('.layout-dialog')?.close()); await new Promise((r) => setTimeout(r, 150)); };
await openLayout();
await click('.layout-dialog [data-preset="1"]');
await closeLayout();
await tab('analysis');
console.log('1 欄にした:', await panes(), '|', await slotCols());
await openLayout();
await click('.layout-dialog [data-preset="3"]');
await closeLayout();
console.log('3 欄にした:', await panes(), '| 欄の数', await ev(() => document.querySelectorAll('.pane').length));
await page.screenshot({ path: `${OUT}/review-panes.png` });
await openLayout();
await click('.layout-dialog [data-move="winrate:-1"]');
console.log('期待勝率を左へ:', await panes());
await click('.layout-dialog [data-act="reset"]');
console.log('初期に戻した:', await panes());
await closeLayout();
// タブを掴んで運ぶ（ポインタ操作。HTML5 の drag は button では始まらない版がある）
const dragTab = async (id, to) => {
  const b = await (await page.$(`.tab[data-tab="${id}"]`)).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));
};
const bottom = await (await page.$('#bottom')).boundingBox();
await dragTab('winrate', { x: bottom.x + 200, y: bottom.y + bottom.height / 2 });
console.log('期待勝率を左の欄へ掴んで運んだ:', await panes());
await dragTab('winrate', { x: bottom.x + bottom.width - 8, y: bottom.y + bottom.height / 2 });
console.log('右の端へ落として新しい欄:', await panes(), '| 欄の数', await ev(() => document.querySelectorAll('.pane').length));
await click('button[data-act="setup"]');
await click('.setup-dialog [data-act="layout"]');
await click('.layout-dialog [data-act="reset"]');
await ev(() => document.querySelector('.layout-dialog').close());
await tab('analysis');
for (const b of await page.$$('.user-slots .aslot-remove')) { await b.click(); await new Promise((r) => setTimeout(r, 80)); }

// 8. 窓を小さくしても盤が潰れず、横に溢れない
await page.setViewport({ width: 1024, height: 680 });
await new Promise((r) => setTimeout(r, 300));
console.log('狭い窓:', await ev(() => {
  const b = document.querySelector('.board').getBoundingClientRect();
  const rec = document.querySelector('.record-pane').getBoundingClientRect();
  return `盤 ${Math.round(b.width)}x${Math.round(b.height)} / 棋譜の幅 ${Math.round(rec.width)} / 横の溢れ ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px / マス ${getComputedStyle(document.querySelector('.shogi')).getPropertyValue('--sq').trim()}`;
}));

// 9. 人が後手なら盤を自動で向ける・一時停止・エンジン同士なら盤に矢印
await page.setViewport({ width: 1360, height: 860 });
await new Promise((r) => setTimeout(r, 300));
const engine = { type: 'engine', normalId: '', fusekiId: 'builtin', level: 4, secPerMove: 0.4 };
await ev((e) => window.tenbin.play({ mode: 'fuseki', seats: [e, { type: 'human' }], names: ['甲', '乙'], timeControl: null }), engine);
await new Promise((r) => setTimeout(r, 900));
console.log('人が後手のとき:', await ev(() => `手前の駒台 ${document.querySelector('.stand.near .stand-pieces').dataset.color} / 候補手の欄 ${[...document.querySelectorAll('.play-slots .analysis-slot')].map((s) => `${s.querySelector('.player-label').textContent}=${s.querySelector('.engine-name').textContent}`).join(' | ')}`));
await click('button[data-act="flip"]');
await ev(() => window.tenbin.play({ mode: 'fuseki', seats: [{ type: 'human' }, { type: 'human' }], names: ['人', '人'], timeControl: null }));
await new Promise((r) => setTimeout(r, 300));
console.log('人同士に変えたら反転の固定は解ける:', await ev(() => document.querySelector('.stand.near .stand-pieces').dataset.color));

await ev((e) => window.tenbin.play({ mode: 'fuseki', seats: [e, e], names: ['甲', '乙'], timeControl: null }), engine);
await page.waitForFunction(() => window.tenbin.game().moves.length >= 3, { timeout: 30000 });
const arrows = await page.waitForFunction(() => document.querySelectorAll('svg.shapes .shape').length, { timeout: 15000, polling: 100 }).then((h) => h.jsonValue()).catch(() => 0);
console.log('エンジン同士の矢印:', arrows);
await click('button[data-act="pause"]');
await new Promise((r) => setTimeout(r, 300));
const atPause = await ev(() => window.tenbin.game().moves.length);
await new Promise((r) => setTimeout(r, 1500));
const afterPause = await ev(() => window.tenbin.game().moves.length);
console.log('一時停止:', await status(), '| 手数', atPause, '→', afterPause, '| 盤は触れない:', await ev(() => document.querySelector('.cell')?.disabled));
await click('button[data-act="pause"]');
await new Promise((r) => setTimeout(r, 1200));
console.log('再開:', await ev(() => window.tenbin.game().moves.length), '手目まで進んだ');
await ev(() => window.tenbin.start('tenbin'));

// 10. ふつうの本将棋を始められる。駒台は持ち駒だけ（布石のあいだは 20 枚ぶん全部出る）
await ev(() => window.tenbin.play({ mode: 'position', seats: [{ type: 'human' }, { type: 'human' }], names: ['先', '後'], timeControl: null }));
await new Promise((r) => setTimeout(r, 300));
console.log('本将棋:', await status(), '| 題:', await ev(() => document.querySelector('.game-title').textContent),
  '| 盤の駒', await ev(() => document.querySelectorAll('.cell .piece').length), '枚 | 駒台', await ev(() => document.querySelectorAll('.stand .slot').length), '枚');
await ev(() => window.tenbin.start('tenbin'));
await new Promise((r) => setTimeout(r, 200));
console.log('両玉のとき駒台に出る駒:', await ev(() => {
  const s = [...document.querySelectorAll('.stand.near .slot')];
  return `${s.length} 種 / 押せる ${s.filter((b) => !b.disabled).length} 種 / 薄い ${s.filter((b) => getComputedStyle(b).opacity !== '1').length} 種`;
}));

console.log('errors:', errors.length ? errors : 'なし');
await browser.close();
