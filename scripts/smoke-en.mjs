// 英語表示の煙テスト。
//   node scripts/smoke-en.mjs
// 見るのは 3 つ。(1) 英語にしたとき画面に日本語が残っていないか（窓も開いて見る）、
// (2) KIF は英語表示でも日本語のままか（将棋所・ShogiHome で開ける書式）、
// (3) ツールバーのボタンで言葉を切り替えると、読み込み直して覚えているか。
import puppeteer from 'puppeteer-core';

const URL = 'http://localhost:4173/';
const JA = /[ぁ-んァ-ヶ一-龠]/;
// 英語でもわざと日本語のまま出すもの。Windows の一覧に出る名前（tauri.conf.json の
// productName）とエンジンの製品名は訳せないので、数える前に取り除く
const KEEP_JA = ['天秤将棋GUI', 'やねうら王', '水匠5', 'ふかうら王', '布石エンジン'];
const strip = (s) => KEEP_JA.reduce((a, w) => a.split(w).join(''), s);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// confirm / alert は自動で承諾する（窓を開くだけで止まらないように）
page.on('dialog', (d) => void d.accept());

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('settings') ?? '{}');
  s.lang = 'en';
  s.seenSetup = true;
  localStorage.setItem('settings', JSON.stringify(s));
});
await page.goto(URL, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1500));

// 天秤将棋を人対人で始めて、玉2枚・選択・布石を少し進める
await page.evaluate(() => window.tenbin.start('tenbin'));
await new Promise((r) => setTimeout(r, 400));
const moved = await page.evaluate(() => {
  const g = window.tenbin.game();
  const drops = g.legalDrops().slice(0, 1);
  return drops.length;
});
await page.evaluate(() => {
  const g = window.tenbin.game();
  const one = () => g.legalDrops()[0]?.usi;
  for (let i = 0; i < 6; i++) {
    const u = one();
    if (!u) break;
    if (g.phase === 'choose') g.apply('choose:sente');
    else g.apply(u);
  }
});
// 記録から読み直して画面を描き直す（Game を直に触っただけでは描き直されない）
await page.evaluate(() => window.tenbin.load(window.tenbin.kif()));
await new Promise((r) => setTimeout(r, 500));

const grab = async () => await page.evaluate(() => document.body.innerText);

const found = {};
found.main = (await grab()).split('\n').map((s) => strip(s.trim())).filter((s) => JA.test(s));

// 窓をひとつずつ開いて見る
const openAndScan = async (name, fn) => {
  await page.evaluate(fn);
  await new Promise((r) => setTimeout(r, 500));
  found[name] = (await grab()).split('\n').map((s) => strip(s.trim())).filter((s) => JA.test(s));
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await new Promise((r) => setTimeout(r, 200));
};
await openAndScan('newgame', () => document.querySelector('[data-act="new"]').click());
await openAndScan('engines', () => document.querySelector('[data-act="engines"]').click());
await openAndScan('setup', () => document.querySelector('[data-act="setup"]').click());
await openAndScan('save', () => document.querySelector('[data-act="save"]').click());
await openAndScan('editor', () => document.querySelector('[data-act="edit"]').click());
await page.evaluate(() => document.querySelector('[data-act="edit"]')?.click());
await new Promise((r) => setTimeout(r, 300));

const kif = await page.evaluate(() => window.tenbin.kif());
const toolbar = await page.evaluate(() => document.getElementById('toolbar').innerText.replace(/\n/g, ' | '));
const status = await page.evaluate(() => document.getElementById('status').textContent);
const kifuList = await page.evaluate(() => document.querySelector('.kifu-list')?.innerText.replace(/\n/g, ' / '));
const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab')].map((b) => b.textContent).join(' | '));
const htmlLang = await page.evaluate(() => document.documentElement.lang);
const title = await page.evaluate(() => document.title);

// 日本語で開き直して、ボタンで英語へ戻す
await page.evaluate(() => localStorage.setItem('settings', JSON.stringify({ lang: 'ja', seenSetup: true })));
await page.goto(URL, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));
const jaToolbar = await page.evaluate(() => document.getElementById('toolbar').innerText.replace(/\n/g, ' | '));
await page.evaluate(() => document.querySelector('[data-act="lang"]').click());
await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const switched = {
  ja: jaToolbar,
  en: await page.evaluate(() => document.getElementById('toolbar').innerText.replace(/\n/g, ' | ')),
  saved: await page.evaluate(() => JSON.parse(localStorage.getItem('settings')).lang),
};

const jaLeft = Object.values(found).flat();
console.log(JSON.stringify({ found, toolbar, status, kifuList, tabs, htmlLang, title, kifHead: kif.split('\n').slice(0, 8), switched }, null, 1));
console.log('日本語の残り:', jaLeft.length === 0 ? 'なし' : jaLeft.join(' / '));
console.log('errors:', errors.length ? errors.join(' / ') : 'なし');
await browser.close();
if (jaLeft.length || errors.length) process.exit(1);
