// 起動と配線。状態は Game、表示は ui/ の各部品、エンジンは usi/。
// ここには「誰が誰を呼ぶか」だけを書く。

import { invoke } from '@tauri-apps/api/core';
import { Fuseki } from './rules/fuseki.ts';
import { Game, rebuild, squareLabel, colorMark, overReasonText, type Mode, type ViewState, type Color } from './state/game.ts';
import { lang, setLang, sideName, t, type Lang } from './i18n.ts';
import { Clock, type TimeControl } from './state/clock.ts';
import { BUILTIN_ID, loadSettings, saveSettings, settingsLoadError, type Settings } from './settings.ts';
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
    log(t('msg_builtin_loaded', { policy: b.manifest.policy.file, value: b.manifest.value.file, kings: b.kings ? t('msg_builtin_kings') : '' }));
    return b;
  } catch (e) {
    log(t('msg_builtin_failed', { msg: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

/** 平手の初期局面。「本将棋」の対局と、局面編集の出発点に使う */
const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

async function main(): Promise<void> {
  const settings: Settings = await loadSettings();
  setLang(settings.lang);
  // index.html に直に書いてある文言はここで言語に合わせる（<html lang> は setLang が直す）
  document.title = t('app_name');
  // 窓の題（OS 側）は WebView の <title> と別。設定の言語に合わせる
  if (isTauri()) {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(t('app_name'))).catch(() => {});
  }
  $('split-v').setAttribute('aria-label', t('split_record'));
  $('split-h').setAttribute('aria-label', t('split_bottom'));
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
    beforeInstall: () => updateDeps.beforeInstall(),
  });

  /** 内蔵の布石評価の、利用者ごとの手（検討の欄・棋譜解析）。模型は 1 つを共有する */
  const builtinViews = new Map<string, BuiltinEvaluator>();

  /** id（'builtin' か登録 id）から思考するものを作る。processTag で同じ登録の 2 本目を区別する */
  function createThinker(id: string, processTag: string): Thinker | null {
    if (id === BUILTIN_ID) {
      if (!builtin) return null;
      // 同じ実体を配ると、世代の数え札とルールを共有してしまい、片方の探索が
      // もう片方を黙って打ち消す（欄が空のまま止まる／解析から手が抜ける）
      let v = builtinViews.get(processTag);
      if (!v) {
        v = builtin.view();
        builtinViews.set(processTag, v);
      }
      v.method = settings.builtinMethod;
      return v;
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

  /** 次のフレームで描く評価（info ごとに描き直さないための溜め） */
  let evalPaint: { ply: number; ev: { p: number; cp: number | null; approx: boolean }; board: boolean } | null = null;
  const analysis = new AnalysisPanel($('analysis'), $('play'), {
    settings: () => settings,
    save: () => saveSettings(settings),
    createThinker,
    onEvaluation: (ply, ev, lines, source) => {
      setEval(ply, ev, source);
      // 矢印は検討の候補だけ。ただし**エンジン同士**なら対局中の読みも出す
      // （人に手を先に見せる心配が無い。人が入っている対局では出さない）
      let board = false;
      if (source === 'analysis' || driver.allEngines) {
        shapes = [];
        for (const l of lines.slice(0, 3)) {
          const mv = l.pv[0];
          if (!mv || mv.length < 4) continue;
          const to = mv.slice(2, 4);
          if (shapes.some((s) => s.to === to)) continue;
          shapes.push(mv[1] === '*' ? { to, rank: l.multipv } : { from: mv.slice(0, 2), to, rank: l.multipv });
        }
        board = true;
      }
      // info は毎秒何十行も来る。グラフと盤の描き直しは 1 フレームに 1 回にまとめる
      if (!evalPaint) {
        requestAnimationFrame(() => {
          const p = evalPaint!;
          evalPaint = null;
          const v = lastView ?? currentView();
          paintGraph(p.ply === v.ply ? { p: p.ev.p, cp: p.ev.cp, approx: p.ev.approx } : null);
          if (p.board) paintBoard();
        });
      }
      evalPaint = { ply, ev, board: board || (evalPaint?.board ?? false) };
    },
    onLog: (_name, dir, text) => usiConsole.append(dir, text),
    openEngineSettings: () => engineDialog.open(),
    onKifuAnalysis: () => void kifuAnalysis(),
    onStartAnalysis: () => {
      // 検討は「いまの局面を調べる」もの。対局が動いていると局面が先へ行ってしまうので止める。
      // 止めても盤は触れる（自分で駒を動かして変化を並べられる）
      if (driver.active && !driver.isPaused && game.phase !== 'over') void togglePause();
    },
    pvText: (usis, t) => gameForPv(t).pvText(usis),
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
      say(t('msg_no_kifu'), true);
      return;
    }
    if (driver.active && game.phase !== 'over' && !confirm(t('confirm_kifu_analysis'))) return;
    const cursorPly = cursor === null ? 0 : currentView().ply;
    const o = await askKifuAnalysis($('dialogs'), { secPerMove: settings.kifuAnalysisSec, hasCursor: cursor !== null, cursorPly });
    if (!o) return;
    settings.kifuAnalysisSec = o.secPerMove;
    void saveSettings(settings);
    const fromIndex = o.fromIndex < 0 ? cursor ?? 0 : 0;
    const t0 = performance.now();
    const n = await kifuAnalyzer.run({ fromIndex, secPerMove: o.secPerMove });
    if (n > 0) say(t('msg_kifu_analysis_done', { n, sec: ((performance.now() - t0) / 1000).toFixed(0) }));
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
    // 一時停止はボタンからだけでなく、エンジンが指せない手を返したときにも起きる。
    // どちらでも時計は止め、ボタンの表示も「再開」に直す
    onPause: () => {
      clock.pause();
      paintAll();
    },
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
      const role = t(seat === 0 ? 'role_placer' : 'role_chooser');
      const name = driver.seatName(seat);
      return name ? t('name_with_role', { name, role }) : role;
    }
    const color: Color = half === 0 ? 'sente' : 'gote';
    return `${colorMark(color)} ${names()[color] || sideName(color)}`;
  }

  /** 先後が決まると席と左右の対応が入れ替わる。前の読みは別の人のものになるので消す */
  let lastChosen: Color | null = null;

  /** 候補手の欄は対局のあいだ**常に左右 2 つ**。人の側もそのまま置く（割りつけを動かさない） */
  function paintPlaySides(): void {
    const chosen = game.mode === 'tenbin' ? game.chosenColor : null;
    if (chosen !== lastChosen) {
      lastChosen = chosen;
      analysis.clearPlayers();
    }
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
    if (cursor === null) driver.kick(); // 見ている間に届いた手は捨てているので、戻ったら考え直させる
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
    return { positionCmd: v.positionCmd, phase: v.phase, stage, turn: v.turn, ply: v.ply, mode: game.mode };
  }
  const kifu = new KifuList($('kifu'), {
    onSeek: (c) => {
      if (editor) return;
      cursor = c;
      board.clearSelection();
      paintAll();
      if (cursor === null) driver.kick(); // 見ている間に届いた手は捨てているので、戻ったら考え直させる
    },
  });
  const board = new Board($('board'), {
    onDrop: (role, sq) => tryApply(`${usiRole(role)}*${sq}`),
    onMove: (from, to) => {
      const { can, forced } = game.promotion(from, to);
      let promote = false;
      if (forced) promote = true;
      else if (can) promote = confirm(t('confirm_promote', { sq: squareLabel(to) }));
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
      if (game.phase === 'over' || game.actingColor !== loser) return;
      // 過去の手を見ていても負けは負け。最新局面へ戻してから記録する（戻さないと tryApply が黙って捨てる）
      cursor = null;
      tryApply('timeout');
      say(t('over_timeout', { side: sideName(loser) }));
    };
  }

  function clockViews(): Record<Color, ReturnType<Clock['view']>> {
    return { sente: clock.view('sente'), gote: clock.view('gote') };
  }

  // ---- 対局の操作 ----
  function tryApply(token: string, loser?: Color): void {
    if (cursor !== null || editor) return;
    try {
      const rec = game.apply(token, undefined, loser);
      // 選ぶ側が先手を取ったら、席ごとに計っていた時計の枠を色に合わせて入れ替える
      if (token === 'choose:sente') clock.swap();
      if (game.phase === 'over') {
        clock.stop();
        if (driver.isPaused) driver.resume(); // 終局に「一時停止中」を残さない（再開のボタンは終局で押せなくなる）
      } else {
        const t = clock.press(game.actingColor);
        if (t) rec.time = t;
        // press は次の手番の時計を動かす。止めている間に並べた手で時計が動き出さないように止めておく
        if (driver.isPaused) clock.pause();
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
    if (clock.enabled) clock.start(game.actingColor);
    cursor = null;
    evals.clear();
    shapes = [];
    flipLocked = false;
    board.setOrientation('sente');
    board.clearSelection();
    paintAll();
  }

  async function newGame(): Promise<void> {
    if (game.moves.length > 0 && game.phase !== 'over' && !confirm(t('confirm_new'))) return;
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
    // 残り時間を記録から組み直す（枠の入れ替えも時間切れで 0 にした分もここで戻る）
    clock.restore(game.spentSec());
    if (clock.enabled) clock.start(game.actingColor);
    if (driver.isPaused) clock.pause(); // 止めている間に戻しても時計は動かさない
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
    // 残り時間を記録から組み直す（枠の入れ替えも時間切れで 0 にした分もここで戻る）
    clock.restore(game.spentSec());
    if (clock.enabled) clock.start(game.actingColor);
    if (driver.isPaused) clock.pause(); // 止めている間に戻しても時計は動かさない
    paintAll();
    driver.interrupt();
  }

  function say(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function phaseText(v: ViewState): string {
    const turn = sideName(v.turn);
    const next = v.ply + 1;
    switch (v.phase) {
      case 'kings':
        return t(next === 1 ? 'st_place_sente' : 'st_place_gote');
      case 'choose':
        return t('st_choose');
      case 'fuseki':
        return t('st_fuseki', { n: next, turn, left: 41 - next });
      case 'normal':
        return t('st_normal', { n: next, turn });
      case 'over': {
        const o = v.over!;
        const w = o.winner === null ? t('draw') : t('win_of', { side: sideName(o.winner) });
        return t('st_over', { result: w, reason: overReasonText(o.reason) });
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

  /**
   * 投了する側の色。エンジンと指しているなら人の席の色（相手の手番でも一時停止中でも、
   * 投げるのは押した本人）。人同士は手番の側。エンジン同士は投げる人がいないので null。
   */
  function resignColor(): Color | null {
    if (!driver.playing) return game.actingColor;
    const humans = ([0, 1] as const).filter((s) => driver.humanAt(s));
    if (humans.length === 1) return halfOfSeat(humans[0]!) === 0 ? 'sente' : 'gote';
    if (humans.length === 0) return null;
    const seat = driver.seatToMove();
    return seat === null || driver.humanAt(seat) ? game.actingColor : null;
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
    kifu.render(game.moves, cursor, cursor === null ? undefined : t('kifu_viewing', { n: v.ply }));
    paintSide(v);
    paintPlaySides();
    paintGraph(null);
    paintToolbar();
    kifu.revealCurrent();
    say(
      cursor !== null
        ? t('st_past', { phase: phaseText(v) })
        : driver.isPaused
          ? t('st_paused', { phase: phaseText(v) })
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
    b.innerHTML = `${on ? ICON.play : ICON.pause}<span>${t(on ? 'tb_resume' : 'tb_pause')}</span>`;
    b.disabled = !driver.active || game.phase === 'over';
    b.setAttribute('aria-pressed', String(on));
  }

  /** 対局を止める・続ける。考えているエンジンを止め、時計も止める */
  async function togglePause(): Promise<void> {
    if (driver.isPaused) {
      driver.resume();
      clock.resume(); // 止める前に使っていた時間から続ける
    } else {
      await driver.pause(); // 時計を止めて描き直すのは driver の onPause
    }
    paintAll();
  }

  function paintSide(v: ViewState): void {
    const el = $('players');
    el.replaceChildren();
    const title = document.createElement('div');
    title.className = 'game-title';
    title.textContent =
      game.mode === 'tenbin'
        ? t('game_tenbin')
        : game.mode === 'fuseki'
          ? t('game_fuseki')
          : t(game.normalStartSfen === START_SFEN ? 'game_normal' : 'game_normal_pos');
    el.appendChild(title);
    if (cursor !== null) {
      const p = document.createElement('div');
      p.className = 'branch';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t('branch_btn');
      b.addEventListener('click', () => {
        if (confirm(t('branch_confirm', { n: v.ply, k: game.moves.length - cursor! }))) branchHere();
      });
      p.appendChild(b);
      el.appendChild(p);
      return;
    }
    if (v.phase === 'over' && v.over) {
      const p = document.createElement('div');
      p.className = 'result';
      const w =
        v.over.winner === null
          ? t('draw')
          : t('win_of', { side: `${colorMark(v.over.winner)} ${names()[v.over.winner] || sideName(v.over.winner)}` });
      p.innerHTML = `<strong>${escapeText(t('result_head'))}</strong> ${escapeText(w)}（${escapeText(overReasonText(v.over.reason))}）<span class="result-hint">${escapeText(t('result_hint'))}</span>`;
      el.appendChild(p);
      return;
    }
    if (v.phase === 'choose') {
      const p = document.createElement('div');
      p.className = 'choose';
      p.innerHTML = `<p>${escapeText(t('choose_prompt'))}</p>`;
      for (const c of ['sente', 'gote'] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = c === 'sente' ? 'primary' : '';
        b.textContent = t(c === 'sente' ? 'choose_sente_btn' : 'choose_gote_btn');
        b.addEventListener('click', () => tryApply(`choose:${c}`));
        p.appendChild(b);
      }
      el.appendChild(p);
    } else if (game.mode === 'tenbin' && game.chosenColor) {
      const p = document.createElement('div');
      p.className = 'chosen';
      p.textContent = t('chosen_note', { side: sideName(game.chosenColor) });
      el.appendChild(p);
    }
  }

  // ---- 局面編集 ----
  function enterEditor(): void {
    if (editor) return;
    // 席の名前は abort() で消える。やめて戻ったときのために meta へ写しておく
    const n = names();
    meta = { ...meta, sente: n.sente ?? '', gote: n.gote ?? '' };
    void analysis.stop();
    void driver.abort();
    clock.stop(); // 対局は捨てる。編集中に時間切れが起きても記録できない
    const v = currentView();
    editor = new PositionEditor(editorEl, {
      onChange: () => paintBoard(),
      onStart: (sfen) => {
        exitEditor();
        startGame('position', { sente: meta.sente, gote: meta.gote, timeControl: null }, sfen);
      },
      onCancel: () => {
        exitEditor();
        // enterEditor で止めた時計を戻す。戻さないと以降の手が消費時間なしで記録される
        if (clock.enabled && game.phase !== 'over') {
          clock.start(game.actingColor);
          if (driver.isPaused) clock.pause();
        }
        paintAll();
      },
    });
    if (v.phase === 'normal' || v.phase === 'over') editor.loadSnapshot(v.snapshot);
    else editor.loadSfen(START_SFEN);
    editorEl.hidden = false;
    document.body.classList.add('editing');
    say(t('msg_editor_hint'));
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
      say(t('msg_no_normal_kif'), true);
      return;
    }
    if (!isTauri()) {
      say(t('msg_save_tauri_only'), true);
      console.log(text);
      return;
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `${game.mode === 'fuseki' ? 'fuseki' : game.mode === 'position' ? 'shogi' : 'tenbin'}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${normalOnly ? '-honshogi' : ''}.kif`;
    const path = await save({ defaultPath: name, filters: [{ name: t('kif_filter'), extensions: ['kif', 'kifu'] }] });
    if (!path) return;
    await invoke('write_text_file', { path, text });
    say(t('msg_saved', { path }));
  }

  async function openKif(): Promise<void> {
    if (!isTauri()) {
      say(t('msg_open_tauri_only'), true);
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, filters: [{ name: t('kif_filter'), extensions: ['kif', 'kifu', 'txt'] }] });
    if (typeof path !== 'string') return;
    try {
      const text = await invoke<string>('read_text_file', { path });
      loadKifText(text);
      say(t('msg_opened', { path }));
    } catch (e) {
      say(t('msg_kif_unreadable', { msg: e instanceof Error ? e.message : String(e) }), true);
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
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>${t('app_name')}</span></div>
    <div class="tools">
      <button type="button" data-act="new" title="${t('tb_new_title')}">${ICON.play}<span>${t('tb_new')}</span></button>
      <button type="button" data-act="undo" title="${t('tb_undo_title')}">${ICON.undo}<span>${t('tb_undo')}</span></button>
      <button type="button" data-act="resign" title="${t('tb_resign_title')}">${ICON.flag}<span>${t('tb_resign')}</span></button>
      <button type="button" data-act="pause" aria-pressed="false" title="${t('tb_pause_title')}">${ICON.pause}<span>${t('tb_pause')}</span></button>
      <button type="button" data-act="flip" title="${t('tb_flip_title')}">${ICON.flip}<span>${t('tb_flip')}</span></button>
      <button type="button" data-act="edit" title="${t('tb_edit')}">${ICON.edit}<span>${t('tb_edit')}</span></button>
      <button type="button" data-act="open" title="${t('tb_open_title')}">${ICON.open}<span>${t('tb_open')}</span></button>
      <button type="button" data-act="save" title="${t('tb_save_title')}">${ICON.save}<span>${t('tb_save')}</span></button>
    </div>
    <div class="tools right">
      <button type="button" data-act="setup" title="${t('tb_setup_title')}">${ICON.help}<span>${t('tb_setup')}</span></button>
      <button type="button" data-act="engines" title="${t('tb_engines_title')}">${ICON.sliders}<span>${t('tb_engines')}</span></button>
      <button type="button" data-act="lang" title="${t('tb_lang_title')}" lang="${lang() === 'ja' ? 'en' : 'ja'}">${ICON.lang}<span>${t('tb_lang')}</span></button>
      <button type="button" data-act="theme" title="${t('tb_theme_title')}">${ICON.theme}<span>${t('tb_theme')}</span></button>
    </div>`;
  const saveMenu = document.createElement('dialog');
  saveMenu.className = 'save-dialog';
  saveMenu.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-head"><h2>${t('save_title')}</h2></div>
      <button type="button" data-save="all" class="save-choice"><strong>${t('save_all')}</strong><span>${t('save_all_sub')}</span></button>
      <button type="button" data-save="normal" class="save-choice"><strong>${t('save_normal')}</strong><span>${t('save_normal_sub')}</span></button>
      <div class="dialog-actions"><button type="submit">${t('cancel')}</button></div>
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
      case 'resign': {
        if (cursor !== null || editor || game.phase === 'over') break;
        // 投げるのは押した本人。手番から決めると、相手の手番で一時停止して押したときに
        // 相手が投げたことになってしまうので、席から色を決める
        const loser = resignColor();
        if (loser === null) {
          // 案内は次の描き直しで消えてしまうので、押した本人に届く形で出す
          alert(t('alert_not_your_turn'));
          break;
        }
        if (confirm(t('confirm_resign', { side: sideName(loser) }))) tryApply('resign', loser);
        break;
      }
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
      case 'lang': {
        // 言葉を変えたら窓ごと読み込み直す。検討の枠はエンジンを抱えていて組み立て直せないので、
        // 作り直すほうが確か（beforeunload が閉じるときと同じ後始末をする）
        const next: Lang = lang() === 'ja' ? 'en' : 'ja';
        if (game.moves.length > 0 && game.phase !== 'over' && !confirm(t('confirm_lang'))) break;
        settings.lang = next;
        void (async () => {
          await saveSettings(settings);
          location.reload();
        })();
        break;
      }
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
      say(t('msg_no_kifu'), true);
      return;
    }
    try {
      await navigator.clipboard.writeText(writeKif(game, kifMeta()));
      say(t('msg_copied'));
    } catch (e) {
      say(t('msg_copy_failed', { msg: e instanceof Error ? e.message : String(e) }), true);
    }
  }

  /** 貼り付けた文字を棋譜として読む（Ctrl+V） */
  function pasteKif(text: string): void {
    if (!text.trim()) return;
    if (game.moves.length > 0 && game.phase !== 'over' && !confirm(t('confirm_paste'))) return;
    try {
      loadKifText(text);
      say(t('msg_pasted', { n: game.moves.length }));
    } catch (e) {
      say(t('msg_paste_unreadable', { msg: e instanceof Error ? e.message : String(e) }), true);
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
        if (!driver.active || game.phase === 'over') return; // ボタンと同じ条件。終局後に止めても再開できない
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
  if (settingsLoadError) {
    // 読めなかった設定を既定値で上書きしない。保存すると前の登録が消えるので、まず知らせる
    say(t('msg_settings_broken', { msg: settingsLoadError }), true);
  } else if (!settings.seenSetup && settings.engines.length === 0) {
    // 初回だけ、はじめの案内を出す（エンジンが 1 本も無いとき）
    settings.seenSetup = true;
    void saveSettings(settings);
    void setupDialog.open();
  }
  // 新しい版が出ていれば知らせる（承諾したときだけ入れ替える）。入れ替えの前にエンジンを全部止める。
  // 入れ替えは窓を閉じずにプロセスを終えるので、ここで止めないとやねうら王が残る
  const updateDeps = {
    say: (text: string, error?: boolean) => say(text, error),
    beforeInstall: async () => {
      await Promise.all([analysis.shutdown(), driver.shutdown(), kifuAnalyzer.shutdown()]);
    },
  };
  void checkUpdate(true, updateDeps);
  builtin = await loadBuiltin((t) => usiConsole.append('sys', t));
  analysis.refreshEngineList();
  if (!isTauri()) {
    usiConsole.append('sys', t('msg_preview'));
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
  lang: '<svg viewBox="0 0 20 20" aria-hidden="true" class="stroke"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15"/><path d="M10 2.5c2.2 2.2 3.2 4.8 3.2 7.5S12.2 15.3 10 17.5C7.8 15.3 6.8 12.7 6.8 10S7.8 4.7 10 2.5z"/></svg>',
};

/** 状態欄に赤で出し、console にも残す。起動の失敗と、拾い損ねた失敗の共通の出口 */
function fail(key: 'msg_boot_failed' | 'msg_unexpected', e: unknown): void {
  const s = document.getElementById('status');
  if (s) {
    s.textContent = t(key, { msg: e instanceof Error ? e.message : String(e) });
    s.classList.add('error');
  }
  console.error(e);
}

// 誰も拾わなかった失敗を黙って落とさない。無言で止まるのが対局中は一番困る
window.addEventListener('error', (ev) => fail('msg_unexpected', ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => fail('msg_unexpected', ev.reason));

main().catch((e) => fail('msg_boot_failed', e));
