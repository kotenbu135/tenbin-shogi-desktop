// 起動と配線。状態は Game、表示は ui/ の各部品、エンジンは usi/。
// ここには「誰が誰を呼ぶか」だけを書く。

import { invoke } from '@tauri-apps/api/core';
import { Fuseki } from './rules/fuseki.ts';
import { Game, rebuild, squareText, colorName, colorMark, type Mode, type ViewState, type Color } from './state/game.ts';
import { Clock, type TimeControl } from './state/clock.ts';
import { BUILTIN_ID, loadSettings, saveSettings, type Settings } from './settings.ts';
import { Board, type Shape } from './ui/board.ts';
import { TenbinGraph, type EvalPoint, type EvalSource } from './ui/graph.ts';
import { Layout } from './ui/layout.ts';
import { SetupDialog } from './ui/setup.ts';
import { checkUpdate } from './ui/update.ts';
import { KifuList } from './ui/kifu.ts';
import { AnalysisPanel, type Target } from './ui/analysis.ts';
import { KifuAnalyzer, askKifuAnalysis } from './ui/kifuanalysis.ts';
import { UsiConsole } from './ui/console.ts';
import { EngineDialog } from './ui/engines.ts';
import { NewGameDialog, type NewGameChoice } from './ui/newgame.ts';
import { PositionEditor } from './ui/editor.ts';
import { MatchDriver } from './ui/play.ts';
import { UsiEngine, isTauri, type Thinker } from './usi/engine.ts';
import { BuiltinEvaluator } from './eval/builtin.ts';
import { parseKif, writeKif, writeNormalOnlyKif } from './kif/tenbin-kif.ts';
import type { Role as OpsRole } from 'shogiops/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Meta {
  sente: string;
  gote: string;
  timeControl: TimeControl | null;
  startedAt: Date;
}

/** 内蔵の布石評価を読む。失敗しても対局は続く（布石の検討と AI の布石だけ使えない） */
async function loadBuiltin(log: (text: string) => void): Promise<BuiltinEvaluator | null> {
  try {
    const base = new URL('/', location.href).href;
    const b = await BuiltinEvaluator.load(base + 'models/', base + 'wasm/fuseki.mjs', base + 'vendor/ort/');
    log(`内蔵の布石評価: 方策 ${b.manifest.policy.file} / 価値ネット ${b.manifest.value.file}${b.kings ? ' / 両玉の価値表' : ''}`);
    return b;
  } catch (e) {
    log(`内蔵の布石評価を読めない: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 平手の初期局面。「本将棋」の対局と、局面編集の出発点に使う */
const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

async function main(): Promise<void> {
  const settings: Settings = await loadSettings();
  applyTheme(settings.theme);

  const fuseki = await Fuseki.load(new URL('/wasm/fuseki.mjs', location.href).href);
  let game = new Game(fuseki, 'tenbin');
  let builtin: BuiltinEvaluator | null = null;
  let meta: Meta = { sente: '', gote: '', timeControl: null, startedAt: new Date() };
  let clock = new Clock(null);
  /** 表示している局面。null は最新。数値は「何手目まで」 */
  let cursor: number | null = null;
  /** 手数ごとの評価。対局の系列と検討の系列を別に持つ（鍵は "source:ply"） */
  const evals = new Map<string, EvalPoint>();
  let shapes: Shape[] = [];
  /** 手で盤を反転したか。したら自動の反転はしない */
  let flipLocked = false;
  /** エンジンが考えている側。名札に動く印を出すため */
  let thinkingColor: Color | null = null;
  let editor: PositionEditor | null = null;

  const status = $('status');
  const consoleEl = $('console');
  const scoreEl = $('graph-score');
  const winrateEl = $('graph-winrate');
  const editorEl = $('editor');
  const usiConsole = new UsiConsole(consoleEl);

  const engineDialog = new EngineDialog($('dialogs'), {
    settings: () => settings,
    save: () => saveSettings(settings),
    onChanged: () => analysis.refreshEngineList(),
    onLog: (_name, dir, text) => usiConsole.append(dir, text),
    openLog: () => {
      consoleEl.hidden = false;
    },
  });
  const newGameDialog = new NewGameDialog($('dialogs'), () => settings);
  const setupDialog = new SetupDialog($('dialogs'), {
    settings: () => settings,
    save: () => saveSettings(settings),
    openEngines: () => engineDialog.open(),
    register: (path, name, evalScale) => engineDialog.addInstalled(path, name, evalScale),
    say: (text, error) => say(text, error),
  });

  /** id（'builtin' か登録 id）から思考するものを作る。processTag で同じ登録の 2 本目を区別する */
  function createThinker(id: string, processTag: string): Thinker | null {
    if (id === BUILTIN_ID) {
      if (builtin) builtin.method = settings.builtinMethod;
      return builtin;
    }
    const cfg = settings.engines.find((e) => e.id === id);
    if (!cfg) return null;
    return new UsiEngine(cfg, `${cfg.id}-${processTag}`);
  }

  function setEval(ply: number, ev: { p: number; cp: number | null; approx: boolean }, source: EvalSource): void {
    evals.set(`${source}:${ply}`, { ply, p: ev.p, cp: ev.cp, approx: ev.approx, source });
  }

  /** 表示中の手数の評価。検討の値を優先し、無ければ対局中に指した側の値 */
  function evalAt(ply: number): { p: number; cp: number | null; approx: boolean } | null {
    const e = evals.get(`analysis:${ply}`) ?? evals.get(`sente:${ply}`) ?? evals.get(`gote:${ply}`) ?? null;
    return e === null ? null : { p: e.p, cp: e.cp, approx: e.approx };
  }

  const analysis = new AnalysisPanel($('analysis'), $('play'), {
    settings: () => settings,
    save: () => saveSettings(settings),
    createThinker,
    onEvaluation: (ply, ev, lines, source) => {
      setEval(ply, ev, source);
      const v = lastView ?? currentView();
      paintGraph(ply === v.ply ? { p: ev.p, cp: ev.cp, approx: ev.approx } : null);
      // 矢印は検討の候補だけ。ただし**エンジン同士**なら対局中の読みも出す
      // （人に手を先に見せる心配が無い。人が入っている対局では出さない）
      if (source !== 'analysis' && !driver.allEngines) return;
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
    onKifuAnalysis: () => void kifuAnalysis(),
    onStartAnalysis: () => {
      // 検討は「いまの局面を調べる」もの。対局が動いていると局面が先へ行ってしまうので止める。
      // 止めても盤は触れる（自分で駒を動かして変化を並べられる）
      if (driver.active && !driver.isPaused && game.phase !== 'over') void togglePause();
    },
    pvText: (usis, t) => gameForPv(t).japanesePv(usis),
  });

  const kifuAnalyzer = new KifuAnalyzer({
    settings: () => settings,
    createThinker,
    targets: () => {
      const out: { index: number; target: Target }[] = [];
      for (let i = 0; i <= game.moves.length; i++) {
        const v = game.viewAt(i);
        if (v.phase === 'choose') continue;
        out.push({ index: i, target: targetOf(v) });
      }
      return out;
    },
    onPoint: (ply, ev) => {
      setEval(ply, ev, 'analysis');
      paintGraph(null);
    },
    onProgress: (text) => analysis.setProgress(text, text ? () => void kifuAnalyzer.stop() : undefined),
    onLog: (_name, dir, text) => usiConsole.append(dir, text),
  });

  async function kifuAnalysis(): Promise<void> {
    if (kifuAnalyzer.running) {
      await kifuAnalyzer.stop();
      return;
    }
    if (game.moves.length === 0) {
      say('棋譜がまだありません', true);
      return;
    }
    if (driver.active && game.phase !== 'over' && !confirm('対局中です。エンジンと解析で計算を取り合いますが、棋譜解析を始めますか')) return;
    const cursorPly = cursor === null ? 0 : currentView().ply;
    const o = await askKifuAnalysis($('dialogs'), { secPerMove: settings.kifuAnalysisSec, hasCursor: cursor !== null, cursorPly });
    if (!o) return;
    settings.kifuAnalysisSec = o.secPerMove;
    void saveSettings(settings);
    const fromIndex = o.fromIndex < 0 ? cursor ?? 0 : 0;
    const t0 = performance.now();
    const n = await kifuAnalyzer.run({ fromIndex, secPerMove: o.secPerMove });
    if (n > 0) say(`棋譜解析: ${n} 局面を ${((performance.now() - t0) / 1000).toFixed(0)} 秒で評価しました`);
  }
  usiConsole.onSend = (line) => analysis.sendRaw(line);

  const driver = new MatchDriver({
    game: () => game,
    clock: () => clock,
    live: () => cursor === null && !editor,
    apply: (token) => tryApply(token),
    builtin: () => builtin,
    createThinker,
    say: (text, error) => say(text, error),
    onLog: (_name, dir, text) => usiConsole.append(dir, text),
    onThinkStart: (seat, color, cfg) => {
      const half = halfOfSeat(seat);
      halfInUse.set(seat, half);
      thinkingColor = color;
      analysis.beginPlayer(half, sideLabel(half), cfg, targetOf(game.view()));
      paintBoard();
      // 「起動しています…」を残さない。考え始めたら局面の案内に戻す
      if (cursor === null) say(phaseText(lastView ?? currentView()));
    },
    multiPv: () => settings.playMultiPv,
    canApply: (token) => game.canApply(token),
    onThinking: (seat, info) => analysis.playerInfo(halfInUse.get(seat) ?? halfOfSeat(seat), info),
    onThinkEnd: (seat, state) => {
      thinkingColor = null;
      analysis.endPlayer(halfInUse.get(seat) ?? halfOfSeat(seat), state);
      paintBoard();
    },
  });

  /** 候補手の欄の左右。0 が先手側、1 が後手側（先後が決まる前は席の順） */
  const halfInUse = new Map<0 | 1, 0 | 1>();

  function beforeChoice(): boolean {
    return game.mode === 'tenbin' && !game.chosenColor;
  }

  function halfOfSeat(seat: 0 | 1): 0 | 1 {
    if (beforeChoice()) return seat;
    return driver.seatOfColor('sente') === seat ? 0 : 1;
  }

  function sideLabel(half: 0 | 1): string {
    if (beforeChoice()) {
      const seat = half;
      const role = seat === 0 ? '玉を置く' : '先後を選ぶ';
      const name = driver.seatName(seat);
      return name ? `${name}（${role}）` : role;
    }
    const color: Color = half === 0 ? 'sente' : 'gote';
    return `${colorMark(color)} ${names()[color] || colorName(color)}`;
  }

  /** 候補手の欄は対局のあいだ**常に左右 2 つ**。人の側もそのまま置く（割りつけを動かさない） */
  function paintPlaySides(): void {
    if (!driver.playing) {
      analysis.setPlayers(null);
      return;
    }
    analysis.setPlayers(
      ([0, 1] as const).map((half) => {
        const seat = beforeChoice() ? half : driver.seatOfColor(half === 0 ? 'sente' : 'gote');
        return { label: sideLabel(half), human: driver.humanAt(seat) };
      }),
    );
  }

  // グラフは 2 つ立てる。別々の欄に置いて同時に見られるようにするため、種類は作るときに決める
  const graphs = [new TenbinGraph(scoreEl, 'score'), new TenbinGraph(winrateEl, 'winrate')] as const;
  const seek = (ply: number): void => {
    if (editor) return;
    // その手数までの棋譜の位置へ。手数を持たない行（先後の選択）は飛ばす
    let idx = 0;
    game.moves.forEach((m, i) => {
      if (m.ply !== null && m.ply <= ply) idx = i + 1;
    });
    cursor = idx >= game.moves.length ? null : idx;
    board.clearSelection();
    paintAll();
  };
  for (const g of graphs) g.onSeek = seek;
  const layout = new Layout($('main'), $('bottom'), { play: $('play'), analysis: $('analysis'), score: scoreEl, winrate: winrateEl }, {
    layout: () => settings.layout,
    save: () => void saveSettings(settings),
    onChange: () => paintGraph(null),
  });

  /** 検討に渡す局面。終局した局面も、その段階のルールで検討できるよう stage を添える */
  function targetOf(v: ViewState): Target {
    let stage: Target['stage'];
    if (v.phase !== 'over') stage = v.phase;
    else if (game.mode === 'position' || v.ply >= 40) stage = 'normal';
    else stage = game.mode === 'tenbin' && v.ply < 2 ? 'kings' : 'fuseki';
    return { positionCmd: v.positionCmd, phase: v.phase, stage, turn: v.turn, ply: v.ply };
  }
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
    game.resync(); // wasm を最新に戻す
    return g;
  }

  /**
   * 読み筋の符号化に使う、検討の対象の局面。表示中の局面ならそのまま、そうでなければ（対局の枠が
   * 指したあとの読みや、過去の局面の読みを描き直すとき）position 行から作る。
   */
  function gameForPv(t: Target): Game {
    const v = lastView ?? currentView();
    if (v.positionCmd === t.positionCmd && v.phase === t.phase) return viewGame();
    const w = t.positionCmd.trim().split(/\s+/);
    const mi = w.indexOf('moves');
    const moves = mi < 0 ? [] : w.slice(mi + 1);
    let g: Game;
    if (w[1] === 'sfen') {
      g = new Game(fuseki, 'position', w.slice(2, mi < 0 ? undefined : mi).join(' '));
      for (const m of moves) g.apply(m);
    } else {
      g = rebuild(fuseki, 'fuseki', moves);
    }
    game.resync();
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
        // press は次の手番の時計を動かす。止めている間に並べた手で時計が動き出さないように戻す
        if (driver.isPaused) clock.stop();
      }
      paintAll();
      driver.kick();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  }

  function startGame(mode: Mode, m: Partial<Meta> = {}, startSfen?: string): void {
    void analysis.stop();
    void driver.abort();
    void kifuAnalyzer.stop();
    analysis.clearPlayers();
    game = new Game(fuseki, mode, startSfen);
    meta = { sente: m.sente ?? '', gote: m.gote ?? '', timeControl: m.timeControl ?? null, startedAt: new Date() };
    attachClock(new Clock(meta.timeControl));
    if (clock.enabled) clock.start(game.turn);
    cursor = null;
    evals.clear();
    shapes = [];
    flipLocked = false;
    board.setOrientation('sente');
    board.clearSelection();
    paintAll();
  }

  async function newGame(): Promise<void> {
    if (game.moves.length > 0 && game.phase !== 'over' && !confirm('いまの対局を捨てて新しく始めますか')) return;
    const c: NewGameChoice | null = await newGameDialog.open();
    if (!c) return;
    startGame(c.mode, { timeControl: c.timeControl }, c.mode === 'position' ? START_SFEN : undefined);
    void driver.start(c);
    paintAll();
  }

  /** 表示中の局面から指し直す（以降の手は消える） */
  function branchHere(): void {
    if (cursor === null) return;
    const tokens = game.tokens().slice(0, cursor);
    const times = game.times().slice(0, cursor);
    game = rebuild(fuseki, game.mode, tokens, { startSfen: game.normalStartSfen ?? undefined, times });
    cursor = null;
    dropEvalsAfter(game.nextPly - 1);
    board.clearSelection();
    if (clock.enabled) clock.start(game.turn);
    paintAll();
    driver.interrupt();
  }

  function dropEvalsAfter(ply: number): void {
    for (const [k, e] of [...evals]) if (e.ply > ply) evals.delete(k);
  }

  function undo(): void {
    if (game.moves.length === 0 || editor) return;
    cursor = null;
    const tokens = game.tokens().slice(0, -1);
    const times = game.times().slice(0, -1);
    game = rebuild(fuseki, game.mode, tokens, { startSfen: game.normalStartSfen ?? undefined, times });
    dropEvalsAfter(game.nextPly - 1);
    board.clearSelection();
    if (clock.enabled) clock.start(game.turn);
    paintAll();
    driver.interrupt();
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
        return next === 1 ? '置く人が、先手陣に先手玉を置きます' : '続けて、後手陣に後手玉を置きます';
      case 'choose':
        return '選ぶ人が、先手を持つか後手を持つかを決めます';
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

  function paintGraph(current: { p: number; cp: number | null; approx: boolean } | null): void {
    const v = lastView ?? currentView();
    const cur = current ?? evalAt(v.ply);
    const input = { points: [...evals.values()], ply: v.ply, current: cur, fusekiEnd: game.mode === 'position' ? 0 : 40 };
    // 閉じたタブと組み替えの途中は幅が 0。開いたときに描き直す
    for (const g of graphs) if (layout.visible(g.type)) g.render(input);
  }

  function names(): Partial<Record<Color, string>> {
    if (driver.active || (meta.sente === '' && meta.gote === '')) {
      const n = driver.colorNames();
      if (n.sente || n.gote) return { sente: n.sente || undefined, gote: n.gote || undefined };
    }
    return { sente: meta.sente || undefined, gote: meta.gote || undefined };
  }

  /** KIF などに書く対局者名（席の名前を色へ写したもの） */
  function kifMeta(): Meta {
    const n = names();
    return { ...meta, sente: n.sente ?? '', gote: n.gote ?? '' };
  }

  /**
   * いま盤の駒を動かしてよいか。一時停止中は自分で変化を並べられる（検討のため）。
   * 動いている対局では、その手番が人の側のときだけ（エンジンの手を人が代わりに指せてしまうのを防ぐ）。
   */
  function canTouchBoard(): boolean {
    if (!driver.playing || driver.isPaused) return true;
    const seat = driver.seatToMove();
    return seat === null || driver.humanAt(seat);
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
      interactive: live && v.phase !== 'over' && v.phase !== 'choose' && canTouchBoard(),
      thinking: live ? thinkingColor : null,
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
    autoFlip();
    paintBoard();
    kifu.render(game.moves, cursor, cursor === null ? undefined : `${v.ply}手目の局面を表示中`);
    paintSide(v);
    paintPlaySides();
    paintGraph(null);
    paintToolbar();
    kifu.revealCurrent();
    say(
      cursor !== null
        ? `${phaseText(v)} · 過去の局面（→ か End で最新へ）`
        : driver.isPaused
          ? `${phaseText(v)} · 一時停止中（「再開」で続きます）`
          : phaseText(v),
    );
    void analysis.setTarget(targetOf(v));
  }

  /** 人が 1 人だけの対局なら、その人の側から見た向きにする。手で反転したらそれを尊重する */
  function autoFlip(): void {
    if (flipLocked) return;
    // 先後が決まる前は、先に置く玉（先手玉）が手前に来る向きで揃える。
    // 前の対局で反転したまま始まると、1 手目の玉が奥に置かれて分かりにくい
    if (beforeChoice()) {
      board.setOrientation('sente');
      return;
    }
    const seat = driver.soleHumanSeat();
    if (seat === null) return;
    board.setOrientation(driver.seatOfColor('sente') === seat ? 'sente' : 'gote');
  }

  /** 盤の向きを手で変える。手で決めたら、以後は自動で反転しない */
  function flipBoard(): void {
    flipLocked = true;
    board.setOrientation(board.currentOrientation === 'sente' ? 'gote' : 'sente');
  }

  function paintToolbar(): void {
    const b = document.querySelector<HTMLButtonElement>('[data-act="pause"]');
    if (!b) return;
    const on = driver.isPaused;
    b.innerHTML = `${on ? ICON.play : ICON.pause}<span>${on ? '再開' : '一時停止'}</span>`;
    b.disabled = !driver.active || game.phase === 'over';
    b.setAttribute('aria-pressed', String(on));
  }

  /** 対局を止める・続ける。考えているエンジンを止め、時計も止める */
  async function togglePause(): Promise<void> {
    if (driver.isPaused) {
      driver.resume();
      if (clock.enabled && game.phase !== 'over') clock.start(game.turn);
    } else {
      await driver.pause();
      clock.stop();
    }
    paintAll();
  }

  function paintSide(v: ViewState): void {
    const el = $('players');
    el.replaceChildren();
    const title = document.createElement('div');
    title.className = 'game-title';
    title.textContent =
      game.mode === 'tenbin' ? '天秤将棋' : game.mode === 'fuseki' ? '布石将棋' : game.normalStartSfen === START_SFEN ? '本将棋' : '本将棋（任意の局面から）';
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
    if (v.phase === 'over' && v.over) {
      const p = document.createElement('div');
      p.className = 'result';
      const w = v.over.winner === null ? '引き分け' : `${colorMark(v.over.winner)} ${names()[v.over.winner] || colorName(v.over.winner)}の勝ち`;
      p.innerHTML = `<strong>終局</strong> ${escapeText(w)}（${escapeText(v.over.reason)}）<span class="result-hint">棋譜解析で振り返るか、局面を選んで検討できます</span>`;
      el.appendChild(p);
      return;
    }
    if (v.phase === 'choose') {
      const p = document.createElement('div');
      p.className = 'choose';
      p.innerHTML = `<p>両玉が置かれました。選ぶ人はどちらを持ちますか。</p>`;
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
      p.textContent = `選ぶ人は${colorName(game.chosenColor)}を持ちました`;
      el.appendChild(p);
    }
  }

  // ---- 局面編集 ----
  function enterEditor(): void {
    if (editor) return;
    void analysis.stop();
    void driver.abort();
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
    else editor.loadSfen(START_SFEN);
    editorEl.hidden = false;
    document.body.classList.add('editing');
    say('局面編集中。駒を置いて「この局面から本将棋を始める」を押します');
    paintBoard();
  }

  function exitEditor(): void {
    editor = null;
    editorEl.hidden = true;
    editorEl.innerHTML = '';
    document.body.classList.remove('editing');
  }

  // ---- KIF ----
  async function saveKif(normalOnly: boolean): Promise<void> {
    const text = normalOnly ? writeNormalOnlyKif(game, kifMeta()) : writeKif(game, kifMeta());
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
    void driver.abort();
    void kifuAnalyzer.stop();
    analysis.clearPlayers();
    flipLocked = false;
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
      <button type="button" data-act="new" title="新しい対局（Ctrl+N）">${ICON.play}<span>新しい対局</span></button>
      <button type="button" data-act="undo" title="待った・1 手戻す（Backspace）">${ICON.undo}<span>待った</span></button>
      <button type="button" data-act="resign" title="投了">${ICON.flag}<span>投了</span></button>
      <button type="button" data-act="pause" aria-pressed="false" title="エンジンの思考と時計を止める（Space）">${ICON.pause}<span>一時停止</span></button>
      <button type="button" data-act="flip" title="盤面反転（F）">${ICON.flip}<span>盤面反転</span></button>
      <button type="button" data-act="edit" title="局面編集">${ICON.edit}<span>局面編集</span></button>
      <button type="button" data-act="open" title="棋譜を開く（Ctrl+O）。貼り付け（Ctrl+V）でも読み込めます">${ICON.open}<span>開く</span></button>
      <button type="button" data-act="save" title="棋譜を保存（Ctrl+S）。Ctrl+C で棋譜を写します">${ICON.save}<span>保存</span></button>
    </div>
    <div class="tools right">
      <button type="button" data-act="setup" title="はじめに（エンジンの入れ方・片づけ方）">${ICON.help}<span>はじめに</span></button>
      <button type="button" data-act="engines" title="エンジンの登録（USI ログもここから）">${ICON.sliders}<span>エンジン</span></button>
      <button type="button" data-act="theme" title="明るさを切り替える">${ICON.theme}<span>テーマ</span></button>
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
        flipBoard();
        break;
      case 'pause':
        void togglePause();
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
      case 'setup':
        void setupDialog.open();
        break;
      case 'engines':
        engineDialog.open();
        break;
      case 'theme': {
        // 明るいと暗いの 2 つだけ。'system' は古い設定の受け皿として型に残してある
        const order: Settings['theme'][] = ['light', 'dark'];
        settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length]!;
        applyTheme(settings.theme);
        void saveSettings(settings);
        break;
      }
    }
  });

  /** 文字を打っている最中や、窓が開いているときはキー操作を横取りしない */
  function keysBusy(target: EventTarget | null): boolean {
    const t = target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return true;
    return document.querySelector('dialog[open]') !== null || editor !== null;
  }

  /** 棋譜を写す（Ctrl+C）。貼り付けはこのアプリ同士でも将棋所などとも行き来できる */
  async function copyKif(): Promise<void> {
    if (game.moves.length === 0) {
      say('棋譜がまだありません', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(writeKif(game, kifMeta()));
      say('棋譜を写しました（Ctrl+V で他のソフトへ貼れます）');
    } catch (e) {
      say(`棋譜を写せません: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /** 貼り付けた文字を棋譜として読む（Ctrl+V） */
  function pasteKif(text: string): void {
    if (!text.trim()) return;
    if (game.moves.length > 0 && game.phase !== 'over' && !confirm('いまの対局を捨てて、貼り付けた棋譜を開きますか')) return;
    try {
      loadKifText(text);
      say(`貼り付けた棋譜を開きました（${game.moves.length} 手）`);
    } catch (e) {
      say(`棋譜として読めません: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  window.addEventListener('paste', (e) => {
    if (keysBusy(e.target)) return;
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text.trim()) return;
    e.preventDefault();
    pasteKif(text);
  });

  window.addEventListener('keydown', (e) => {
    if (keysBusy(e.target)) return;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+V は paste で受ける（keydown からは貼り付けた中身が読めない）
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          void newGame();
          return;
        case 'o':
          e.preventDefault();
          void openKif();
          return;
        case 's':
          e.preventDefault();
          saveMenu.showModal();
          return;
        case 'c':
          // 文字を選んでいるならその写しが先（棋譜の一部だけ写したいことがある）
          if (window.getSelection()?.toString()) return;
          e.preventDefault();
          void copyKif();
          return;
        default:
          return;
      }
    }
    if (e.altKey || e.shiftKey) return;
    const map: Record<string, 'first' | 'prev' | 'next' | 'last'> = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last' };
    const d = map[e.key];
    if (d) {
      e.preventDefault();
      kifu.seek(d);
      return;
    }
    switch (e.key) {
      case ' ':
        // ボタンに焦点があるときの Space はそのボタンを押す操作。二重に効かせない
        if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
        if (!driver.active) return;
        e.preventDefault();
        void togglePause();
        return;
      case 'f':
      case 'F':
        e.preventDefault();
        flipBoard();
        return;
      case 'Backspace':
        e.preventDefault();
        undo();
        return;
    }
  });

  window.addEventListener('beforeunload', () => {
    void analysis.shutdown();
    void driver.shutdown();
    void kifuAnalyzer.shutdown();
  });

  // 動作確認のスクリプト（scripts/*.mjs）から使う入口。利用者の操作には使わない
  (window as unknown as { tenbin: unknown }).tenbin = {
    kif: (normalOnly = false) => (normalOnly ? writeNormalOnlyKif(game, kifMeta()) : writeKif(game, kifMeta())),
    load: (text: string) => loadKifText(text),
    start: (mode: Mode, tc: TimeControl | null = null, sfen?: string) => startGame(mode, { timeControl: tc }, sfen),
    play: (c: NewGameChoice) => {
      startGame(c.mode, { timeControl: c.timeControl });
      void driver.start(c);
      paintAll();
    },
    game: () => game,
    builtin: () => builtin,
    analysis,
    kifuAnalysis: (o: { fromIndex: number; secPerMove: number }) => kifuAnalyzer.run(o),
    evals: () => [...evals.values()],
    settings,
    probe: (cfg: { path: string; args?: string; cwd?: string }) => UsiEngine.probe(cfg, (dir, text) => usiConsole.append(dir, text)),
    save: () => saveSettings(settings),
    refresh: () => analysis.refreshEngineList(),
  };

  paintAll();
  // 初回だけ、はじめの案内を出す（エンジンが 1 本も無いとき）
  if (!settings.seenSetup && settings.engines.length === 0) {
    settings.seenSetup = true;
    void saveSettings(settings);
    void setupDialog.open();
  }
  // 新しい版が出ていれば知らせる（承諾したときだけ入れ替える）
  void checkUpdate(true, { say: (text, error) => say(text, error) });
  builtin = await loadBuiltin((t) => usiConsole.append('sys', t));
  analysis.refreshEngineList();
  if (!isTauri()) {
    usiConsole.append('sys', 'ブラウザのプレビューです。盤と棋譜は動きますが、エンジンや棋譜のファイルは Tauri のアプリ内でだけ扱えます。');
  }
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const ICON = {
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg>',
  pause: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4h3v12H6zM11 4h3v12h-3z"/></svg>',
  undo: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M8 5 4 9l4 4M4 9h8a4 4 0 0 1 0 8h-2"/></svg>',
  flag: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M5 17V3.5M5 4h10l-2.5 3.5L15 11H5"/></svg>',
  flip: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M4 7.5h11l-3-3M16 12.5H5l3 3"/></svg>',
  edit: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M3.5 3.5h13v13h-13zM3.5 8h13M3.5 12h13M8 3.5v13M12 3.5v13"/><path d="M13.5 13.5l3 3" /></svg>',
  open: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M3 5.5h5l1.5 2H17v9H3z"/></svg>',
  save: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M4 3.5h10l2.5 2.5v10.5h-12.5zM7 3.5v4h6v-4M6.5 16.5v-5h7v5"/></svg>',
  terminal: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M3.5 4.5h13v11h-13zM6.5 8l2.5 2-2.5 2M10.5 12h3"/></svg>',
  sliders: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M4 6h12M4 10h12M4 14h12"/><circle cx="7" cy="6" r="1.6" fill="currentColor"/><circle cx="13" cy="10" r="1.6" fill="currentColor"/><circle cx="9" cy="14" r="1.6" fill="currentColor"/></svg>',
  layout: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><path d="M2.5 3.5h15v13h-15zM2.5 8h15M9 8v8.5M14 8v8.5"/></svg>',
  help: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.6a2.3 2.3 0 1 1 2.6 2.6v1.4"/><circle cx="10.2" cy="14.4" r="0.9" fill="currentColor" stroke="none"/></svg>',
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
