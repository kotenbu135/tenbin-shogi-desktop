// 起動と配線。状態は Game、表示は ui/ の各部品、エンジンは usi/。
// ここには「誰が誰を呼ぶか」だけを書く。

import { invoke } from '@tauri-apps/api/core';
import { Fuseki } from './rules/fuseki.ts';
import { Game, rebuild, squareText, colorName, type Mode, type ViewState, type Color } from './state/game.ts';
import { Clock, type TimeControl } from './state/clock.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { Board, type Shape } from './ui/board.ts';
import { TenbinGraph, type EvalPoint } from './ui/graph.ts';
import { KifuList } from './ui/kifu.ts';
import { AnalysisPanel } from './ui/analysis.ts';
import { UsiConsole } from './ui/console.ts';
import { EngineDialog } from './ui/engines.ts';
import { NewGameDialog } from './ui/newgame.ts';
import { PositionEditor } from './ui/editor.ts';
import { isTauri } from './usi/engine.ts';
import { parseKif, writeKif, writeNormalOnlyKif } from './kif/tenbin-kif.ts';
import type { Role as OpsRole } from 'shogiops/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Meta {
  sente: string;
  gote: string;
  timeControl: TimeControl | null;
  startedAt: Date;
}

async function main(): Promise<void> {
  const settings: Settings = await loadSettings();
  applyTheme(settings.theme);

  const fuseki = await Fuseki.load(new URL('/wasm/fuseki.mjs', location.href).href);
  let game = new Game(fuseki, 'tenbin');
  let meta: Meta = { sente: '', gote: '', timeControl: null, startedAt: new Date() };
  let clock = new Clock(null);
  /** 表示している局面。null は最新。数値は「何手目まで」 */
  let cursor: number | null = null;
  const evals = new Map<number, EvalPoint>();
  let shapes: Shape[] = [];
  let editor: PositionEditor | null = null;

  const status = $('status');
  const consoleEl = $('console');
  const graphEl = $('graph');
  const editorEl = $('editor');
  const usiConsole = new UsiConsole(consoleEl);

  const engineDialog = new EngineDialog($('dialogs'), {
    settings: () => settings,
    save: () => saveSettings(settings),
    onChanged: () => analysis.refreshEngineList(),
  });
  const newGameDialog = new NewGameDialog($('dialogs'));

  const analysis = new AnalysisPanel($('analysis'), {
    settings: () => settings,
    onEvaluation: (ply, pSente, lines) => {
      evals.set(ply, { ply, p: pSente });
      paintGraph(pSente);
      shapes = [];
      for (const l of lines.slice(0, 3)) {
        const mv = l.pv[0];
        if (!mv || mv.length < 4) continue;
        const to = mv.slice(2, 4);
        if (shapes.some((s) => s.to === to)) continue;
        shapes.push(mv[1] === '*' ? { to, rank: l.multipv } : { from: mv.slice(0, 2), to, rank: l.multipv });
      }
      paintBoard();
    },
    onLog: (_name, dir, text) => usiConsole.append(dir, text),
    openEngineSettings: () => engineDialog.open(),
    pvText: (usis) => viewGame().japanesePv(usis),
  });
  usiConsole.onSend = (line) => analysis.sendRaw(line);

  const graph = new TenbinGraph(graphEl);
  const kifu = new KifuList($('kifu'), {
    onSeek: (c) => {
      if (editor) return;
      cursor = c;
      board.clearSelection();
      paintAll();
    },
  });
  const board = new Board($('board'), {
    onDrop: (role, sq) => tryApply(`${usiRole(role)}*${sq}`),
    onMove: (from, to) => {
      const { can, forced } = game.promotion(from, to);
      let promote = false;
      if (forced) promote = true;
      else if (can) promote = confirm(`${squareText(to)}へ 成りますか？（キャンセルで不成）`);
      tryApply(`${from}${to}${promote ? '+' : ''}`);
    },
    onEditSquare: (sq) => editor?.handleSquare(sq),
    onEditHand: (color, role) => editor?.handleHand(color, role),
  });

  function usiRole(role: OpsRole): string {
    return { pawn: 'P', lance: 'L', knight: 'N', silver: 'S', gold: 'G', bishop: 'B', rook: 'R', king: 'K' }[role as string] ?? '?';
  }

  /** 表示中の局面の Game。過去を見ているときは一時的に作る（読み筋の符号化に使う） */
  function viewGame(): Game {
    if (cursor === null) return game;
    const g = rebuild(fuseki, game.mode, game.tokens().slice(0, cursor), { startSfen: game.normalStartSfen ?? undefined });
    game.viewAt(game.moves.length); // wasm を最新に戻す
    return g;
  }

  function currentView(): ViewState {
    return cursor === null ? game.view() : game.viewAt(cursor);
  }

  // ---- 時計 ----
  function attachClock(c: Clock): void {
    clock.stop();
    clock = c;
    clock.onTick = () => board.updateClocks(clockViews());
    clock.onTimeout = (loser) => {
      if (game.phase === 'over' || game.turn !== loser) return;
      tryApply('timeout');
      say(`${colorName(loser)}の時間切れ`);
    };
  }

  function clockViews(): Record<Color, ReturnType<Clock['view']>> {
    return { sente: clock.view('sente'), gote: clock.view('gote') };
  }

  // ---- 対局の操作 ----
  function tryApply(token: string): void {
    if (cursor !== null || editor) return;
    try {
      const rec = game.apply(token);
      if (game.phase === 'over') {
        clock.stop();
      } else {
        const t = clock.press(game.turn);
        if (t) rec.time = t;
      }
      if (token !== 'timeout' && rec.time === undefined && clock.enabled === false) {
        // 時間を計らない対局でも、指した時刻から経過秒だけは残せるが、ここでは残さない
      }
      paintAll();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  }

  function startGame(mode: Mode, m: Partial<Meta> = {}, startSfen?: string): void {
    void analysis.stop();
    game = new Game(fuseki, mode, startSfen);
    meta = { sente: m.sente ?? '', gote: m.gote ?? '', timeControl: m.timeControl ?? null, startedAt: new Date() };
    attachClock(new Clock(meta.timeControl));
    if (clock.enabled) clock.start(game.turn);
    cursor = null;
    evals.clear();
    shapes = [];
    board.clearSelection();
    paintAll();
  }

  async function newGame(): Promise<void> {
    if (game.moves.length > 0 && game.phase !== 'over' && !confirm('いまの対局を捨てて新しく始めますか')) return;
    const c = await newGameDialog.open();
    if (!c) return;
    startGame(c.mode, { sente: c.sente, gote: c.gote, timeControl: c.timeControl });
  }

  /** 表示中の局面から指し直す（以降の手は消える） */
  function branchHere(): void {
    if (cursor === null) return;
    const tokens = game.tokens().slice(0, cursor);
    const times = game.times().slice(0, cursor);
    game = rebuild(fuseki, game.mode, tokens, { startSfen: game.normalStartSfen ?? undefined, times });
    cursor = null;
    for (const k of [...evals.keys()]) if (k > game.nextPly - 1) evals.delete(k);
    board.clearSelection();
    if (clock.enabled) clock.start(game.turn);
    paintAll();
  }

  function undo(): void {
    if (game.moves.length === 0 || editor) return;
    cursor = null;
    const tokens = game.tokens().slice(0, -1);
    const times = game.times().slice(0, -1);
    game = rebuild(fuseki, game.mode, tokens, { startSfen: game.normalStartSfen ?? undefined, times });
    for (const k of [...evals.keys()]) if (k > game.nextPly - 1) evals.delete(k);
    board.clearSelection();
    if (clock.enabled) clock.start(game.turn);
    paintAll();
  }

  function say(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function phaseText(v: ViewState): string {
    const turn = colorName(v.turn);
    const next = v.ply + 1;
    switch (v.phase) {
      case 'kings':
        return next === 1 ? '玉を置く役が、先手陣に先手玉を置きます' : '続けて、後手陣に後手玉を置きます';
      case 'choose':
        return '選ぶ役が、先手を持つか後手を持つかを決めます';
      case 'fuseki':
        return `布石 ${next}手目 · ${turn}が置きます（残り ${41 - next}手）`;
      case 'normal':
        return `本将棋 ${next}手目 · ${turn}番`;
      case 'over': {
        const o = v.over!;
        const w = o.winner === null ? '引き分け' : `${colorName(o.winner)}の勝ち`;
        return `終局 · ${w}（${o.reason}）`;
      }
    }
  }

  // ---- 描画 ----
  let lastView: ViewState | null = null;

  function paintGraph(current: number | null): void {
    const v = lastView ?? currentView();
    const cur = current ?? evals.get(v.ply)?.p ?? null;
    graph.render({ points: [...evals.values()], ply: v.ply, current: cur });
  }

  function names(): Partial<Record<Color, string>> {
    return { sente: meta.sente || undefined, gote: meta.gote || undefined };
  }

  function paintBoard(): void {
    if (editor) {
      board.render(editor.snapshot(), {
        interactive: false,
        phase: 'normal',
        dropSquares: () => new Set(),
        moveDests: () => new Set(),
        edit: { selected: editor.selectedSquare() },
        names: names(),
      });
      return;
    }
    const v = lastView ?? currentView();
    const live = cursor === null;
    board.render(v.snapshot, {
      interactive: live && v.phase !== 'over' && v.phase !== 'choose',
      phase: v.phase,
      dropSquares: (role) => (live ? game.dropSquares(role) : new Set()),
      moveDests: (from) => (live ? game.moveDests(from) : new Set()),
      shapes,
      names: names(),
      clocks: live ? clockViews() : { sente: null, gote: null },
    });
  }

  function paintAll(): void {
    if (editor) {
      paintBoard();
      return;
    }
    const v = currentView();
    lastView = v;
    shapes = [];
    paintBoard();
    kifu.render(game.moves, cursor, cursor === null ? undefined : `${v.ply}手目の局面を表示中`);
    paintSide(v);
    paintGraph(null);
    say(cursor === null ? phaseText(v) : `${phaseText(v)} · 過去の局面（→ か End で最新へ）`);
    void analysis.setTarget({ positionCmd: v.positionCmd, phase: v.phase, turn: v.turn, ply: v.ply });
  }

  function paintSide(v: ViewState): void {
    const el = $('players');
    el.replaceChildren();
    const title = document.createElement('div');
    title.className = 'game-title';
    title.textContent = game.mode === 'tenbin' ? '天秤将棋' : game.mode === 'fuseki' ? '布石将棋' : '本将棋（任意の局面から）';
    el.appendChild(title);
    if (cursor !== null) {
      const p = document.createElement('div');
      p.className = 'branch';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'この局面から指し直す';
      b.addEventListener('click', () => {
        if (confirm(`${v.ply}手目以降の ${game.moves.length - cursor!} 手を消して、ここから指し直しますか`)) branchHere();
      });
      p.appendChild(b);
      el.appendChild(p);
      return;
    }
    if (v.phase === 'choose') {
      const p = document.createElement('div');
      p.className = 'choose';
      p.innerHTML = `<p>両玉が置かれました。選ぶ役はどちらを持ちますか。</p>`;
      for (const c of ['sente', 'gote'] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = c === 'sente' ? 'primary' : '';
        b.textContent = c === 'sente' ? '☗ 先手を持つ' : '☖ 後手を持つ';
        b.addEventListener('click', () => tryApply(`choose:${c}`));
        p.appendChild(b);
      }
      el.appendChild(p);
    } else if (game.mode === 'tenbin' && game.chosenColor) {
      const p = document.createElement('div');
      p.className = 'chosen';
      p.textContent = `選ぶ役は${colorName(game.chosenColor)}を持ちました`;
      el.appendChild(p);
    }
  }

  // ---- 局面編集 ----
  function enterEditor(): void {
    if (editor) return;
    void analysis.stop();
    const v = currentView();
    editor = new PositionEditor(editorEl, {
      onChange: () => paintBoard(),
      onStart: (sfen) => {
        exitEditor();
        startGame('position', { sente: meta.sente, gote: meta.gote, timeControl: null }, sfen);
      },
      onCancel: () => {
        exitEditor();
        paintAll();
      },
    });
    if (v.phase === 'normal' || v.phase === 'over') editor.loadSnapshot(v.snapshot);
    else editor.loadSfen('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1');
    graphEl.hidden = true;
    editorEl.hidden = false;
    document.body.classList.add('editing');
    say('局面編集中。駒を置いて「この局面から本将棋を始める」を押します');
    paintBoard();
  }

  function exitEditor(): void {
    editor = null;
    editorEl.hidden = true;
    editorEl.innerHTML = '';
    graphEl.hidden = false;
    document.body.classList.remove('editing');
  }

  // ---- KIF ----
  async function saveKif(normalOnly: boolean): Promise<void> {
    const text = normalOnly ? writeNormalOnlyKif(game, meta) : writeKif(game, meta);
    if (text === null) {
      say('本将棋がまだ始まっていないので、本将棋だけの棋譜は作れません', true);
      return;
    }
    if (!isTauri()) {
      say('棋譜の保存は Tauri のアプリ内でだけできます', true);
      console.log(text);
      return;
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `${game.mode === 'fuseki' ? 'fuseki' : game.mode === 'position' ? 'shogi' : 'tenbin'}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${normalOnly ? '-honshogi' : ''}.kif`;
    const path = await save({ defaultPath: name, filters: [{ name: 'KIF 棋譜', extensions: ['kif', 'kifu'] }] });
    if (!path) return;
    await invoke('write_text_file', { path, text });
    say(`保存しました: ${path}`);
  }

  async function openKif(): Promise<void> {
    if (!isTauri()) {
      say('棋譜を開くのは Tauri のアプリ内でだけできます', true);
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'KIF 棋譜', extensions: ['kif', 'kifu', 'txt'] }] });
    if (typeof path !== 'string') return;
    try {
      const text = await invoke<string>('read_text_file', { path });
      loadKifText(text);
      say(`開きました: ${path}`);
    } catch (e) {
      say(`棋譜を読めない: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  function loadKifText(text: string): void {
    const k = parseKif(text);
    void analysis.stop();
    if (editor) exitEditor();
    game = rebuild(fuseki, k.mode, k.tokens, { startSfen: k.startSfen, times: k.times });
    meta = { sente: k.sente ?? '', gote: k.gote ?? '', timeControl: k.timeControl, startedAt: new Date() };
    attachClock(new Clock(k.timeControl));
    cursor = null;
    evals.clear();
    shapes = [];
    board.clearSelection();
    paintAll();
  }

  // ---- ツールバー ----
  const toolbar = $('toolbar');
  toolbar.innerHTML = `
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>天秤将棋</span></div>
    <div class="tools">
      <button type="button" data-act="new">${ICON.play}<span>新しい対局</span></button>
      <button type="button" data-act="undo">${ICON.undo}<span>待った</span></button>
      <button type="button" data-act="resign">${ICON.flag}<span>投了</span></button>
      <button type="button" data-act="flip">${ICON.flip}<span>盤面反転</span></button>
      <button type="button" data-act="edit">${ICON.edit}<span>局面編集</span></button>
      <button type="button" data-act="open">${ICON.open}<span>開く</span></button>
      <button type="button" data-act="save">${ICON.save}<span>保存</span></button>
    </div>
    <div class="tools right">
      <button type="button" data-act="console" aria-pressed="false">${ICON.terminal}<span>USI ログ</span></button>
      <button type="button" data-act="engines">${ICON.sliders}<span>エンジン</span></button>
      <button type="button" data-act="theme">${ICON.theme}<span>テーマ</span></button>
    </div>`;
  const saveMenu = document.createElement('dialog');
  saveMenu.className = 'save-dialog';
  saveMenu.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-head"><h2>棋譜を保存</h2></div>
      <button type="button" data-save="all" class="save-choice"><strong>対局全体（布石を含む）</strong><span>このアプリで開ける KIF。布石の手と先後の選択も残る</span></button>
      <button type="button" data-save="normal" class="save-choice"><strong>本将棋の部分だけ</strong><span>41手目の局面図から始まる普通の KIF。将棋所や ShogiHome で開ける</span></button>
      <div class="dialog-actions"><button type="submit">やめる</button></div>
    </form>`;
  $('dialogs').appendChild(saveMenu);
  saveMenu.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-save]');
    if (!b) return;
    saveMenu.close();
    void saveKif(b.dataset.save === 'normal');
  });

  toolbar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'new':
        if (editor) exitEditor();
        void newGame();
        break;
      case 'undo':
        undo();
        break;
      case 'resign':
        if (cursor === null && !editor && game.phase !== 'over' && confirm(`${colorName(game.turn)}が投了しますか`)) tryApply('resign');
        break;
      case 'flip':
        board.setOrientation(board.currentOrientation === 'sente' ? 'gote' : 'sente');
        break;
      case 'edit':
        if (editor) {
          exitEditor();
          paintAll();
        } else {
          enterEditor();
        }
        break;
      case 'open':
        void openKif();
        break;
      case 'save':
        saveMenu.showModal();
        break;
      case 'console':
        consoleEl.hidden = !consoleEl.hidden;
        b.setAttribute('aria-pressed', String(!consoleEl.hidden));
        break;
      case 'engines':
        engineDialog.open();
        break;
      case 'theme': {
        const order: Settings['theme'][] = ['system', 'light', 'dark'];
        settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length]!;
        applyTheme(settings.theme);
        void saveSettings(settings);
        break;
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (document.querySelector('dialog[open]') || editor) return;
    const map: Record<string, 'first' | 'prev' | 'next' | 'last'> = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last' };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    kifu.seek(d);
  });

  window.addEventListener('beforeunload', () => {
    void analysis.shutdown();
  });

  // 動作確認のスクリプト（scripts/*.mjs）から使う入口。利用者の操作には使わない
  (window as unknown as { tenbin: unknown }).tenbin = {
    kif: (normalOnly = false) => (normalOnly ? writeNormalOnlyKif(game, meta) : writeKif(game, meta)),
    load: (text: string) => loadKifText(text),
    start: (mode: Mode, tc: TimeControl | null = null, sfen?: string) => startGame(mode, { timeControl: tc }, sfen),
    game: () => game,
  };

  paintAll();
  if (!isTauri()) {
    usiConsole.append('sys', 'ブラウザのプレビューです。盤と棋譜は動きますが、エンジンや棋譜のファイルは Tauri のアプリ内でだけ扱えます。');
  }
}

function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const ICON = {
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg>',
  undo: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M8 5 4 9l4 4M4 9h8a4 4 0 0 1 0 8h-2"/></svg>',
  flag: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M5 17V3.5M5 4h10l-2.5 3.5L15 11H5"/></svg>',
  flip: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M4 7.5h11l-3-3M16 12.5H5l3 3"/></svg>',
  edit: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M3.5 3.5h13v13h-13zM3.5 8h13M3.5 12h13M8 3.5v13M12 3.5v13"/><path d="M13.5 13.5l3 3" /></svg>',
  open: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M3 5.5h5l1.5 2H17v9H3z"/></svg>',
  save: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M4 3.5h10l2.5 2.5v10.5h-12.5zM7 3.5v4h6v-4M6.5 16.5v-5h7v5"/></svg>',
  terminal: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M3.5 4.5h13v11h-13zM6.5 8l2.5 2-2.5 2M10.5 12h3"/></svg>',
  sliders: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M4 6h12M4 10h12M4 14h12"/><circle cx="7" cy="6" r="1.6" fill="currentColor"/><circle cx="13" cy="10" r="1.6" fill="currentColor"/><circle cx="9" cy="14" r="1.6" fill="currentColor"/></svg>',
  theme: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><circle cx="10" cy="10" r="5.5"/><path d="M10 4.5v11A5.5 5.5 0 0 0 10 4.5z" fill="currentColor"/></svg>',
};

main().catch((e) => {
  const s = document.getElementById('status');
  if (s) {
    s.textContent = `起動できない: ${e instanceof Error ? e.message : String(e)}`;
    s.classList.add('error');
  }
  console.error(e);
});
