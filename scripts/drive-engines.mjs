// 動いている Tauri アプリで、エンジンの登録（申告の読み取り）→ 対局（内蔵の布石 + 本将棋はエンジン）→
// 41 手目以降の複数エンジンの検討を通す。
//   WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9222 npm run tauri dev   # 別の端末で
//   node scripts/drive-engines.mjs <画像の出力先> <エンジンの実行ファイル>
import WebSocket from 'ws';
import fs from 'node:fs';
const OUT = process.argv[2] ?? '.';
const ENGINE = process.argv[3] ?? '/mnt/e/shogi/水匠5/Suisho5-AVX2.exe';
const ws = new WebSocket('ws://127.0.0.1:9222/socket/1/1/WebPage');
let id = 0; const pending = new Map(); let targetId = null; const waiters = [];
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: ++id, method: 'Target.sendMessageToTarget', params: { targetId, message: JSON.stringify({ id: i, method, params }) } })); });
ws.on('message', (m) => {
  const d = JSON.parse(m);
  if (d.method === 'Target.targetCreated') { targetId = d.params.targetInfo.targetId; for (const w of waiters) w(); return; }
  if (d.method === 'Target.dispatchMessageFromTarget') { const inner = JSON.parse(d.params.message); if (inner.id && pending.has(inner.id)) { const p = pending.get(inner.id); pending.delete(inner.id); inner.error ? p.rej(new Error(JSON.stringify(inner.error))) : p.res(inner.result); } return; }
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
});
await new Promise((r) => ws.on('open', r));
await new Promise((r, j) => { if (targetId) return r(); waiters.push(r); setTimeout(() => j(new Error('targetCreated が来ない')), 5000); });
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.wasThrown) throw new Error(JSON.stringify(r.result)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Runtime.evaluate は Promise を待てないので、結果を window に置いて取りに行く
const evAsync = async (body, timeoutMs = 60000) => {
  await ev(`window.__r = undefined; (async () => { ${body} })().then((v) => { window.__r = JSON.stringify(v ?? null); }, (e) => { window.__r = 'ERR ' + (e && e.stack || e); }); 0`);
  for (let t = 0; t < timeoutMs / 250; t++) { await sleep(250); const r = await ev('window.__r'); if (r !== undefined && r !== null) { if (String(r).startsWith('ERR')) throw new Error(r); return JSON.parse(r); } }
  throw new Error('timeout: ' + body.slice(0, 60));
};
const shot = async (name) => { try { const r = await call('Page.snapshotRect', { x: 0, y: 0, width: 1360, height: 860, coordinateSystem: 'Viewport' }); fs.writeFileSync(name, Buffer.from(r.dataURL.split(',')[1], 'base64')); console.log('shot', name); } catch (e) { console.log('snapshot failed:', e.message.slice(0, 200)); } };
const status = () => ev('document.getElementById("status").textContent');
const step = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing '+${JSON.stringify(sel)}; e.click(); return 'ok'})()`);

for (let t = 0; t < 120; t++) { if (await ev('!!(window.tenbin && window.tenbin.builtin && window.tenbin.builtin())')) break; await sleep(500); }
console.log('内蔵:', await ev('(()=>{const b=window.tenbin.builtin(); return b ? b.manifest.generation : "なし"})()'));
console.log('登録済み:', await ev('window.tenbin.settings.engines.map(e=>`${e.name}[${e.kind}] opts=${JSON.stringify(e.options)} eval=${e.eval.scale}/${e.eval.offsetCp}`).join(" ; ")'));

// 1. 申告を読んで登録（エンジン画面の「実行ファイルを選んで追加」がすること）
const probe = await evAsync(`const r = await window.tenbin.probe({ path: ${JSON.stringify(ENGINE)} }); return { idName: r.idName, idAuthor: r.idAuthor, n: r.options.length, names: r.options.map(o=>o.name).slice(0, 12) };`);
console.log('申告:', JSON.stringify(probe));
const reg = await evAsync(`
  const m = await import('/src/usi/evalscale.ts');
  const r = await window.tenbin.probe({ path: ${JSON.stringify(ENGINE)} });
  const recipe = m.recipeFor(r.idName);
  const s = window.tenbin.settings;
  let cfg = s.engines.find(e => e.path === ${JSON.stringify(ENGINE)});
  if (!cfg) { cfg = { id: 'e' + Math.random().toString(36).slice(2, 10), name: '', path: ${JSON.stringify(ENGINE)}, kind: 'normal', options: {}, eval: { scale: 600, offsetCp: 0 } }; s.engines.push(cfg); }
  cfg.idName = r.idName; cfg.idAuthor = r.idAuthor; cfg.declared = r.options;
  cfg.name = recipe ? recipe.name : r.idName; if (recipe) cfg.eval = { ...recipe.eval };
  cfg.options = { Threads: '4', USI_Hash: '256' };
  s.normalEngineId = cfg.id;
  await window.tenbin.save(); window.tenbin.refresh();
  return { name: cfg.name, eval: cfg.eval, id: cfg.id };`);
console.log('登録:', JSON.stringify(reg));

// 2. 対局: 布石は内蔵（レベル 5 と 3）、本将棋は両方このエンジン（1 手 1 秒）
if (!process.env.SKIP_PLAY) {
await evAsync(`window.tenbin.play({ mode: 'tenbin', seats: [
  { type: 'engine', normalId: ${JSON.stringify(reg.id)}, fusekiId: 'builtin', level: 5, secPerMove: 1 },
  { type: 'engine', normalId: ${JSON.stringify(reg.id)}, fusekiId: 'builtin', level: 3, secPerMove: 1 }], names: ['甲', '乙'], timeControl: null }); return 1;`);
const t0 = Date.now();
let n = 0;
for (let t = 0; t < 180; t++) { await sleep(1000); n = await ev('window.tenbin.game().moves.length'); if (n >= 47 || (await ev('window.tenbin.game().phase')) === 'over') break; }
console.log('対局:', await status(), '| 手数', n, '|', ((Date.now() - t0) / 1000).toFixed(1), '秒 | 思考表示:', await ev('[...document.querySelectorAll(".analysis-slot.player")].map((s) => s.querySelector(".player-label").textContent + " / " + s.querySelector(".engine-name").textContent + " / " + s.querySelectorAll(".cand").length + "候補 / " + (s.querySelector(".cand .c-pv")?.textContent || "").slice(0, 40)).join(" || ")'), '| 対局の点:', await ev('window.tenbin.evals().filter((e) => e.source === "sente" || e.source === "gote").length'));
console.log('棋譜の末尾:', await ev('[...document.querySelectorAll(".kifu-move")].slice(-4).map(e=>e.textContent.replace(/\\s+/g," ").trim()).join(" / ")'));
await shot(`${OUT}/play-engine.png`);
}

// 3. 検討: 自動の枠（41 手目以降 → 既定のエンジン）と 2 枠目（もう 1 本）
await evAsync(`window.tenbin.start('tenbin'); return 1;`);   // 対局を止めて空の盤へ（進行役は abort される）
await sleep(500);
await evAsync(`
  const b = window.tenbin.builtin();
  const g = window.tenbin.game();
  // 内蔵に 40 手置かせる（検討の対象を作る）
  while (g.phase !== 'normal' && g.phase !== 'over') {
    const toks = g.tokens().filter(t => !t.startsWith('choose:'));
    if (g.phase === 'choose') { g.apply('choose:' + b.choose(toks[0].slice(2), toks[1].slice(2))); continue; }
    g.apply(await b.pickMove(toks, { temperature: 0.4, search: 1, tenbin: true }));
  }
  return g.moves.length;`);
await ev('window.tenbin.load(window.tenbin.kif()); 0');   // 表示を作り直す
console.log('局面:', await status());
console.log(await step('[data-act="toggle"]'));
for (let t = 0; t < 60; t++) { await sleep(500); if ((await ev('document.querySelectorAll(".analysis-slot .cand").length')) >= 3) break; }
console.log('枠1:', await ev('(()=>{const s=document.querySelector(".analysis-slot"); return s.querySelector(".engine-name").textContent + " | " + s.querySelector(".engine-stats").textContent + " | " + [...s.querySelectorAll(".cand")].slice(0,3).map(c=>c.querySelector(".c-pv .move").textContent+" "+c.querySelector(".c-score").textContent+" "+c.querySelector(".c-p .num").textContent).join(" / ")})()'));
const other = await ev('(window.tenbin.settings.engines.find(e => e.kind === "normal" && e.id !== ' + JSON.stringify(reg.id) + ') || {}).id || ""');
if (other) {
  console.log(await step('[data-act="add"]'));
  await ev(`(()=>{const s=document.querySelectorAll(".analysis-slot select")[1]; s.value=${JSON.stringify(other)}; s.dispatchEvent(new Event("change")); return 1})()`);
  for (let t = 0; t < 60; t++) { await sleep(500); if ((await ev('document.querySelectorAll(".analysis-slot")[1]?.querySelectorAll(".cand").length')) >= 3) break; }
  console.log('枠2:', await ev('(()=>{const s=document.querySelectorAll(".analysis-slot")[1]; return s.querySelector(".engine-name").textContent + " | " + s.querySelector(".engine-stats").textContent + " | notice=" + s.querySelector(".analysis-notice").textContent + " | " + [...s.querySelectorAll(".cand")].slice(0,3).map(c=>c.querySelector(".c-pv .move").textContent+" "+c.querySelector(".c-score").textContent+" "+c.querySelector(".c-p .num").textContent).join(" / ")})()'));
}
await sleep(1500);
await shot(`${OUT}/analysis-two-engines.png`);
// 40 手目へ戻ると自動の枠は内蔵に切り替わる
await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); 0');
await sleep(3000);
console.log('局面:', await status());
console.log('40手目の枠1:', await ev('(()=>{const s=document.querySelector(".analysis-slot"); return s.querySelector(".engine-name").textContent + " | " + s.querySelector(".engine-stats").textContent + " | cands=" + s.querySelectorAll(".cand").length})()'));
console.log(await step('[data-act="toggle"]'));
await sleep(800);
console.log('log tail:', await ev('[...document.querySelectorAll(".console-body span")].slice(-3).map(s=>s.textContent.trim().slice(0,120)).join(" || ")'));
ws.close();
