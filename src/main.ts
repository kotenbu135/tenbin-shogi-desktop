// 起動と配線。状態は Game、表示は ui/ の各部品、エンジンは usi/。
// ここには「誰が誰を呼ぶか」だけを書く。

import { Fuseki } from './rules/fuseki.ts';
import { Game, rebuild, squareText, ROLE_KANJI, type Color, type Mode } from './state/game.ts';
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
    onEvaluation: (pSente, lines) => {
      evals.set(game.nextPly - 1, { ply: game.nextPly - 1, p: pSente });
      paintGraph(pSente);
      // 候補の先頭手の行き先に順位を載せる（上位3つ）
      marks.clear();
      for (const l of lines.slice(0, 3)) {
        const mv = l.pv[0];
        if (!mv) continue;
        const to = mv.includes('*') ? mv.slice(2, 4) : mv.slice(2, 4);
        if (!marks.has(to)) marks.set(to, String(l.multipv));
      }
      paintBoard();
    },
    onLog: (_name, dir, text) => usiConsole.append(dir, text),
    openEngineSettings: () => engineDialog.open(),
    moveText: (usi, color) => moveText(usi, color),
  });
  usiConsole.onSend = (line) => analysis.sendRaw(line);

  const graph = new TenbinGraph($('graph'));
  const kifu = new KifuList($('kifu'));
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

  function moveText(usi: string, color: Color): string {
    const mark = color === 'sente' ? '☗' : '☖';
    if (usi.includes('*')) {
      const role = { P: 'pawn', L: 'lance', N: 'knight', S: 'silver', G: 'gold', B: 'bishop', R: 'rook', K: 'king' }[usi[0]!] ?? '';
      return `${mark}${squareText(usi.slice(2, 4))}${ROLE_KANJI[role] ?? usi[0]}打`;
    }
    if (usi.length >= 4) {
      const to = usi.slice(2, 4);
      const snap = game.snapshot();
      const p = snap.pieces.get(usi.slice(0, 2));
      return `${mark}${squareText(to)}${p ? ROLE_KANJI[p.role] ?? '' : ''}${usi.endsWith('+') ? '成' : ''}（${usi.slice(0, 2)}）`;
    }
    return usi;
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
    evals.clear();
    board.clearSelection();
    paintAll();
  }

  function undo(): void {
    if (game.moves.length === 0) return;
    const tokens = game.undoTokens();
    game = rebuild(fuseki, game.mode, tokens);
    for (const k of [...evals.keys()]) if (k > game.nextPly - 1) evals.delete(k);
    board.clearSelection();
    paintAll();
  }

  function say(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function phaseText(): string {
    const turn = game.turn === 'sente' ? '先手' : '後手';
    switch (game.phase) {
      case 'kings':
        return game.nextPly === 1 ? '玉を置く役が、先手陣に先手玉を置きます' : '続けて、後手陣に後手玉を置きます';
      case 'choose':
        return '選ぶ役が、先手を持つか後手を持つかを決めます';
      case 'fuseki':
        return `布石 ${game.nextPly}手目 · ${turn}が置きます（残り ${41 - game.nextPly}手）`;
      case 'normal':
        return `本将棋 ${game.nextPly}手目 · ${turn}番`;
      case 'over': {
        const o = game.over!;
        const w = o.winner === null ? '引き分け' : `${o.winner === 'sente' ? '先手' : '後手'}の勝ち`;
        return `終局 · ${w}（${o.reason}）`;
      }
    }
  }

  function paintGraph(current: number | null): void {
    const ply = game.nextPly - 1;
    const cur = current ?? evals.get(ply)?.p ?? null;
    graph.render({ points: [...evals.values()], ply, current: cur });
  }

  function paintBoard(): void {
    board.render(game.snapshot(), {
      interactive: game.phase !== 'over' && game.phase !== 'choose',
      dropSquares: (role) => game.dropSquares(role),
      moveDests: (from) => game.moveDests(from),
      marks,
    });
  }

  function paintAll(): void {
    marks.clear();
    paintBoard();
    kifu.render(game.moves);
    paintPlayers();
    paintGraph(null);
    say(phaseText());
    void analysis.setTarget({
      positionCmd: game.positionCommand(),
      phase: game.phase,
      turn: game.turn,
      ply: game.nextPly - 1,
    });
  }

  function paintPlayers(): void {
    const el = $('players');
    el.replaceChildren();
    const title = document.createElement('div');
    title.className = 'game-title';
    title.textContent = game.mode === 'tenbin' ? '天秤将棋' : '布石将棋';
    el.appendChild(title);
    if (game.phase === 'choose') {
      const p = document.createElement('div');
      p.className = 'choose';
      p.innerHTML = `<p>両玉が置かれました。選ぶ役はどちらを持ちますか。</p>`;
      for (const c of ['sente', 'gote'] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = c === 'sente' ? 'primary' : '';
        b.textContent = c === 'sente' ? '先手を持つ' : '後手を持つ';
        b.addEventListener('click', () => tryApply(`choose:${c}`));
        p.appendChild(b);
      }
      el.appendChild(p);
    } else if (game.mode === 'tenbin' && game.chosenColor) {
      const p = document.createElement('div');
      p.className = 'chosen';
      p.textContent = `選ぶ役は${game.chosenColor === 'sente' ? '先手' : '後手'}を持ちました`;
      el.appendChild(p);
    }
  }

  // ツールバー
  const toolbar = $('toolbar');
  toolbar.innerHTML = `
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>天秤将棋</span></div>
    <div class="tools">
      <button type="button" data-act="new-tenbin">新しい対局</button>
      <button type="button" data-act="new-fuseki">布石将棋で始める</button>
      <button type="button" data-act="undo">待った</button>
      <button type="button" data-act="resign">投了</button>
    </div>
    <div class="tools right">
      <button type="button" data-act="console" aria-pressed="false">USI ログ</button>
      <button type="button" data-act="engines">エンジン</button>
      <button type="button" data-act="theme">テーマ</button>
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
        if (game.phase !== 'over' && confirm(`${game.turn === 'sente' ? '先手' : '後手'}が投了しますか`)) tryApply('resign');
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

main().catch((e) => {
  const s = document.getElementById('status');
  if (s) {
    s.textContent = `起動できない: ${e instanceof Error ? e.message : String(e)}`;
    s.classList.add('error');
  }
  console.error(e);
});
