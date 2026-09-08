// 起動と配線。状態は Game、表示は ui/ の各部品、エンジンは usi/。
// ここには「誰が誰を呼ぶか」だけを書く。

import { Fuseki } from './rules/fuseki.ts';
import { Game, rebuild, squareText, colorName, type Mode, type ViewState } from './state/game.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { Board } from './ui/board.ts';
import { TenbinGraph, type EvalPoint } from './ui/graph.ts';
import { KifuList } from './ui/kifu.ts';
import { AnalysisPanel } from './ui/analysis.ts';
import { UsiConsole } from './ui/console.ts';
import { EngineDialog } from './ui/engines.ts';
import { isTauri } from './usi/engine.ts';
import type { Role as OpsRole } from 'shogiops/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const settings: Settings = await loadSettings();
  applyTheme(settings.theme);

  const fuseki = await Fuseki.load(new URL('/wasm/fuseki.mjs', location.href).href);
  let game = new Game(fuseki, 'tenbin');
  /** 表示している局面。null は最新。数値は「何手目まで」 */
  let cursor: number | null = null;
  const evals = new Map<number, EvalPoint>();
  const marks = new Map<string, string>();

  const status = $('status');
  const consoleEl = $('console');
  const usiConsole = new UsiConsole(consoleEl);

  const engineDialog = new EngineDialog($('dialogs'), {
    settings: () => settings,
    save: () => saveSettings(settings),
    onChanged: () => analysis.refreshEngineList(),
  });

  const analysis = new AnalysisPanel($('analysis'), {
    settings: () => settings,
    onEvaluation: (ply, pSente, lines) => {
      evals.set(ply, { ply, p: pSente });
      paintGraph(pSente);
      marks.clear();
      for (const l of lines.slice(0, 3)) {
        const mv = l.pv[0];
        if (!mv) continue;
        const to = mv.slice(2, 4);
        if (!marks.has(to)) marks.set(to, String(l.multipv));
      }
      paintBoard();
    },
    onLog: (_name, dir, text) => usiConsole.append(dir, text),
    openEngineSettings: () => engineDialog.open(),
    pvText: (usis) => viewGame().japanesePv(usis),
  });
  usiConsole.onSend = (line) => analysis.sendRaw(line);

  const graph = new TenbinGraph($('graph'));
  const kifu = new KifuList($('kifu'), {
    onSeek: (c) => {
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
  });

  function usiRole(role: OpsRole): string {
    return { pawn: 'P', lance: 'L', knight: 'N', silver: 'S', gold: 'G', bishop: 'B', rook: 'R', king: 'K' }[role as string] ?? '?';
  }

  /** 表示中の局面の Game。過去を見ているときは一時的に作る（読み筋の符号化に使う） */
  function viewGame(): Game {
    if (cursor === null) return game;
    const g = rebuild(fuseki, game.mode, game.tokens().slice(0, cursor));
    // wasm を最新に戻す
    game.viewAt(game.moves.length);
    return g;
  }

  function currentView(): ViewState {
    return cursor === null ? game.view() : game.viewAt(cursor);
  }

  function tryApply(token: string): void {
    try {
      game.apply(token);
      paintAll();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  }

  function newGame(mode: Mode): void {
    void analysis.stop();
    game = new Game(fuseki, mode);
    cursor = null;
    evals.clear();
    board.clearSelection();
    paintAll();
  }

  /** 表示中の局面から指し直す（以降の手は消える） */
  function branchHere(): void {
    if (cursor === null) return;
    const tokens = game.tokens().slice(0, cursor);
    game = rebuild(fuseki, game.mode, tokens);
    cursor = null;
    for (const k of [...evals.keys()]) if (k > game.nextPly - 1) evals.delete(k);
    board.clearSelection();
    paintAll();
  }

  function undo(): void {
    if (game.moves.length === 0) return;
    cursor = null;
    game = rebuild(fuseki, game.mode, game.tokens().slice(0, -1));
    for (const k of [...evals.keys()]) if (k > game.nextPly - 1) evals.delete(k);
    board.clearSelection();
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

  let lastView: ViewState | null = null;

  function paintGraph(current: number | null): void {
    const v = lastView ?? currentView();
    const cur = current ?? evals.get(v.ply)?.p ?? null;
    graph.render({ points: [...evals.values()], ply: v.ply, current: cur });
  }

  function paintBoard(): void {
    const v = lastView ?? currentView();
    const live = cursor === null;
    board.render(v.snapshot, {
      interactive: live && v.phase !== 'over' && v.phase !== 'choose',
      phase: v.phase,
      dropSquares: (role) => (live ? game.dropSquares(role) : new Set()),
      moveDests: (from) => (live ? game.moveDests(from) : new Set()),
      marks,
    });
  }

  function paintAll(): void {
    const v = currentView();
    lastView = v;
    marks.clear();
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
    title.textContent = game.mode === 'tenbin' ? '天秤将棋' : '布石将棋';
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

  // ツールバー
  const toolbar = $('toolbar');
  toolbar.innerHTML = `
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>天秤将棋</span></div>
    <div class="tools">
      <button type="button" data-act="new-tenbin">${ICON.play}<span>新しい対局</span></button>
      <button type="button" data-act="new-fuseki">${ICON.grid}<span>布石将棋</span></button>
      <button type="button" data-act="undo">${ICON.undo}<span>待った</span></button>
      <button type="button" data-act="resign">${ICON.flag}<span>投了</span></button>
    </div>
    <div class="tools right">
      <button type="button" data-act="console" aria-pressed="false">${ICON.terminal}<span>USI ログ</span></button>
      <button type="button" data-act="engines">${ICON.sliders}<span>エンジン</span></button>
      <button type="button" data-act="theme">${ICON.theme}<span>テーマ</span></button>
    </div>`;
  toolbar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'new-tenbin':
        if (game.moves.length === 0 || confirm('いまの対局を捨てて新しく始めますか')) newGame('tenbin');
        break;
      case 'new-fuseki':
        if (game.moves.length === 0 || confirm('いまの対局を捨てて布石将棋を始めますか')) newGame('fuseki');
        break;
      case 'undo':
        undo();
        break;
      case 'resign':
        if (cursor === null && game.phase !== 'over' && confirm(`${colorName(game.turn)}が投了しますか`)) tryApply('resign');
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
    if (document.querySelector('dialog[open]')) return;
    const map: Record<string, 'first' | 'prev' | 'next' | 'last'> = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last' };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    kifu.seek(d);
  });

  window.addEventListener('beforeunload', () => {
    void analysis.shutdown();
  });

  paintAll();
  if (!isTauri()) {
    usiConsole.append('sys', 'ブラウザのプレビューです。盤と棋譜は動きますが、エンジンは Tauri のアプリ内でだけ起動できます。');
  }
}

function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const ICON = {
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg>',
  grid: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M3.5 3.5h13v13h-13zM3.5 8h13M3.5 12h13M8 3.5v13M12 3.5v13"/></svg>',
  undo: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M8 5 4 9l4 4M4 9h8a4 4 0 0 1 0 8h-2"/></svg>',
  flag: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M5 17V3.5M5 4h10l-2.5 3.5L15 11H5"/></svg>',
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
