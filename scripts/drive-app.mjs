// 動いている Tauri アプリを WebKitGTK のリモートインスペクタ経由で操作する煙テスト。
//   WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9222 npm run tauri dev   # 別の端末で
//   node scripts/drive-app.mjs <画像の出力先>
// エンジンは設定に登録済みのものを使う（41手目でやねうら王などが起動する）。
// 新しい WebKit は Target ドメイン越しに命令を包む（Target.sendMessageToTarget）。
import WebSocket from 'ws';
import fs from 'node:fs';
const OUT = process.argv[2] ?? '.';
const ws = new WebSocket('ws://127.0.0.1:9222/socket/1/1/WebPage');
let id = 0; const pending = new Map(); let targetId = null; const waiters = [];
const raw = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: ++id, method: 'Target.sendMessageToTarget', params: { targetId, message: JSON.stringify({ id: i, method, params }) } })); });
ws.on('message', (m) => {
  const d = JSON.parse(m);
  if (d.method === 'Target.targetCreated') { targetId = d.params.targetInfo.targetId; for (const w of waiters) w(); return; }
  if (d.method === 'Target.dispatchMessageFromTarget') { const inner = JSON.parse(d.params.message); if (inner.id && pending.has(inner.id)) { const p = pending.get(inner.id); pending.delete(inner.id); inner.error ? p.rej(new Error(JSON.stringify(inner.error))) : p.res(inner.result); } return; }
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
});
await new Promise((r) => ws.on('open', r));
await new Promise((r, j) => { if (targetId) return r(); waiters.push(r); setTimeout(() => j(new Error('targetCreated が来ない')), 5000); });
console.log('target:', targetId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.wasThrown) throw new Error(JSON.stringify(r.result)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { try { const r = await call('Page.snapshotRect', { x: 0, y: 0, width: 1360, height: 860, coordinateSystem: 'Viewport' }); fs.writeFileSync(name, Buffer.from(r.dataURL.split(',')[1], 'base64')); console.log('shot', name); } catch (e) { console.log('snapshot failed:', e.message.slice(0, 200)); } };

console.log('tauri?', await ev('"__TAURI_INTERNALS__" in window'), '|', await ev('document.getElementById("status").textContent'));
console.log('engine select:', await ev('[...document.querySelectorAll(".engine-select option")].map(o=>o.textContent).join(",")'));
await shot(`${OUT}/app-start.png`);
// 両玉→選択→布石38手
const step = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing '+${JSON.stringify(sel)}; e.click(); return 'ok'})()`);
console.log(await step('.stand.sente .slot[data-role="king"]'), await step('.cell[data-sq="5i"]'));
console.log(await step('.stand.gote .slot[data-role="king"]'), await step('.cell[data-sq="5a"]'));
console.log(await ev('(()=>{const b=[...document.querySelectorAll(".choose button")][0]; b.click(); return "chose"})()'));
for (let i = 0; i < 38; i++) {
  const r = await ev(`(()=>{const t=document.getElementById("status").textContent.includes("先手")?"sente":"gote"; const h=document.querySelector(".stand."+t+" .slot:not(:disabled)"); if(!h) return "no hand"; h.click(); const d=document.querySelector(".cell.dest"); if(!d) return "no dest"; d.click(); return "ok"})()`);
  if (r !== 'ok') { console.log('step', i, r); break; }
}
console.log('status:', await ev('document.getElementById("status").textContent'));
await shot(`${OUT}/app-41.png`);
// 検討開始
console.log(await step('[data-act="toggle"]'));
for (let t = 0; t < 40; t++) { await sleep(500); const rows = await ev('document.querySelectorAll(".cand").length'); if (rows >= 3) break; }
console.log('stats:', await ev('document.querySelector(".engine-name").textContent + " | " + document.querySelector(".engine-stats").textContent'));
console.log('rows:', await ev('[...document.querySelectorAll(".cand")].map(r=>r.textContent.replace(/\s+/g," ").trim()).join("\\n")'));
console.log('notice:', await ev('document.querySelector(".analysis-notice").hidden ? "" : document.querySelector(".analysis-notice").textContent'));
console.log('graph current:', await ev('document.querySelector(".tenbin .pan-label.sente").textContent'));
await sleep(1500);
await shot(`${OUT}/app-analysis.png`);
console.log(await step('[data-act="toggle"]'));
await sleep(800);
console.log('log tail:', await ev('[...document.querySelectorAll(".console-body span")].slice(-4).map(s=>s.textContent.trim()).join(" || ")'));
ws.close();
