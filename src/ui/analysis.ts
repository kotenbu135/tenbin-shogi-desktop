// 検討パネル。エンジンの読みを出す場所はここ 1 つ（ShogiHome の「思考／読み筋」タブと同じ考え方）。
//
//   対局の枠  対局中に手番のエンジンが読んでいる筋。席ごとに 1 つ。操作は無く、指したら止まる
//   検討の枠  利用者が足したエンジンで同じ局面を並べて検討する。「自動」は局面で切り替える:
//             布石中は内蔵の評価か布石対応のエンジン、41 手目からは本将棋の既定エンジン
//
// 評価はここで「先手の勝率」に直してから外へ渡す（グラフと同じ目盛り）。cp もこの表では先手から見た値に
// そろえる（勝率の列と符号が食い違わないように）。そのエンジンの目盛りのまま添える。

import type { EngineConfig, EngineState, Thinker } from '../usi/engine.ts';
import { cpToP, pToCp } from '../usi/evalscale.ts';
import type { UsiInfo } from '../usi/parse.ts';
import type { Color, Phase } from '../state/game.ts';
import { BUILTIN_ID, normalEngine, type Settings } from '../settings.ts';
import { MAX_SCORE, type EvalSource } from './graph.ts';

export interface AnalysisLine {
  multipv: number;
  /** 先手の勝率 */
  pSente: number;
  /** 先手から見た cp（そのエンジンの目盛り） */
  cp: number | null;
  /** cp が勝率からの換算（内蔵の布石評価など）なら true */
  approx: boolean;
  /** 先手から見た詰み手数（正なら先手の勝ち） */
  mate: number | null;
  depth: number | null;
  seldepth: number | null;
  nodes: number | null;
  nps: number | null;
  time: number | null;
  pv: string[];
}

export interface AnalysisDeps {
  settings(): Settings;
  save(): Promise<void>;
  /** 評価が来た。ply: 評価した局面の手数（その局面までに指された手数）。source: 先手・後手（対局中）か検討 */
  onEvaluation(ply: number, ev: { p: number; cp: number | null; approx: boolean }, lines: AnalysisLine[], source: EvalSource): void;
  onLog(engineName: string, dir: 'in' | 'out' | 'err' | 'sys', text: string): void;
  openEngineSettings(): void;
  /** 「棋譜解析」を押した */
  onKifuAnalysis(): void;
  /** 読み筋（USI）を、その局面を起点に符号の列にする */
  pvText(usis: string[], t: Target): string[];
  /** id（'builtin' か登録 id）から思考するものを作る。無ければ null */
  createThinker(id: string, processTag: string): Thinker | null;
}

/** 検討する局面。stage は「終局」を含まない段階（終局した局面も、その段階のルールで検討できる） */
export interface Target {
  positionCmd: string;
  phase: Phase;
  stage: 'kings' | 'choose' | 'fuseki' | 'normal';
  turn: Color;
  ply: number;
}

/** info 1 行を先手の勝率と先手から見た cp・詰みに直す。評価の無い行（string だけなど）は null */
export function evalOfInfo(info: UsiInfo, eval_: EngineConfig['eval'], turn: Color): { pSente: number; cp: number | null; mate: number | null; approx: boolean } | null {
  if (info.string !== undefined && info.scoreCp === undefined && info.winrate === undefined && info.scoreMate === undefined) return null;
  let pStm: number;
  let cp: number | null = null;
  let mate: number | null = null;
  // cp を勝率から作ったか（そのエンジンが cp を出していないか）
  let approx = false;
  if (info.scoreMate !== undefined) {
    mate = info.scoreMate;
    pStm = info.scoreMate > 0 ? 1 : 0;
  } else if (info.winrate !== undefined) {
    pStm = info.winrate;
    if (info.scoreCp !== undefined) cp = info.scoreCp;
    else {
      cp = pToCp(pStm, eval_);
      approx = true;
    }
  } else if (info.scoreCp !== undefined) {
    cp = info.scoreCp;
    pStm = cpToP(cp, eval_);
  } else {
    return null;
  }
  const sente = turn === 'sente';
  return {
    pSente: sente ? pStm : 1 - pStm,
    cp: cp === null ? null : sente ? cp : -cp,
    mate: mate === null ? null : sente ? mate : -mate,
    approx,
  };
}

const AUTO = 'auto';
const MAX_SLOTS = 4;

class Slot {
  engineId: string = AUTO;
  thinker: Thinker | null = null;
  /** 一度立てたものは持っておく（40↔41 手目で行き来しても再起動しない） */
  private pool = new Map<string, Thinker>();
  lines = new Map<number, AnalysisLine>();
  hashfull: number | null = null;
  running = false;
  /** 対局の枠だけ: 読んでいるエンジンと局面 */
  playerCfg: EngineConfig | null = null;
  playerTarget: Target | null = null;
  readonly root: HTMLElement;
  readonly select: HTMLSelectElement | null;
  readonly name: HTMLElement;
  readonly stats: HTMLElement;
  readonly notice: HTMLElement;
  readonly table: HTMLElement;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTarget: Target | null = null;

  constructor(readonly index: number, private readonly panel: AnalysisPanel, readonly player = false) {
    this.root = document.createElement('section');
    this.root.className = 'analysis-slot' + (player ? ' player' : '');
    this.root.innerHTML = player
      ? `<div class="aslot-head"><span class="player-label"></span></div>
      <div class="analysis-status"><span class="engine-name"></span><span class="engine-stats"></span></div>
      <div class="analysis-notice" hidden></div>
      <div class="analysis-table"></div>`
      : `<div class="aslot-head">
        <select class="engine-select" aria-label="この枠のエンジン"></select>
        <button type="button" class="link aslot-remove" title="この枠を外す" aria-label="この枠を外す">×</button>
      </div>
      <div class="analysis-status"><span class="engine-name"></span><span class="engine-stats"></span></div>
      <div class="analysis-notice" hidden></div>
      <div class="analysis-table"></div>`;
    this.select = this.root.querySelector('.engine-select');
    this.name = this.root.querySelector('.engine-name')!;
    this.stats = this.root.querySelector('.engine-stats')!;
    this.notice = this.root.querySelector('.analysis-notice')!;
    this.table = this.root.querySelector('.analysis-table')!;
    this.select?.addEventListener('change', () => void this.panel.slotChanged(this, this.select!.value));
    this.root.querySelector('.aslot-remove')?.addEventListener('click', () => void this.panel.removeSlot(this));
    this.paintTable(null);
  }

  /** 局面に対して実際に使うエンジン id */
  resolve(s: Settings, t: Target | null): string | null {
    if (this.engineId !== AUTO) return this.engineId;
    if (!t) return null;
    if (t.stage === 'normal') return normalEngine(s)?.id ?? null;
    return s.fusekiEngineId;
  }

  async use(id: string, deps: AnalysisDeps): Promise<Thinker> {
    let th = this.pool.get(id) ?? null;
    if (!th) {
      th = deps.createThinker(id, `analysis${this.index}`);
      if (!th) throw new Error('エンジンが見つからない');
      th.onLog = (dir, text) => deps.onLog(th!.config.name || th!.config.path, dir, text);
      th.onStateChange = () => this.paintState();
      this.pool.set(id, th);
    }
    if (this.thinker && this.thinker !== th) await this.thinker.stop();
    this.thinker = th;
    if (th.state === 'stopped') {
      this.name.textContent = '起動中…';
      await th.start();
    }
    return th;
  }

  async quitAll(): Promise<void> {
    this.running = false;
    const all = [...this.pool.values()];
    this.pool.clear();
    this.thinker = null;
    await Promise.all(all.map((t) => t.quit()));
    this.paintState();
  }

  showNotice(text: string | null): void {
    this.notice.hidden = !text;
    this.notice.textContent = text ?? '';
  }

  /** 対局の枠の見出し（「☗ 先手 · 水匠5」）と状態 */
  setPlayer(label: string, state: string, cfg: EngineConfig | null): void {
    const el = this.root.querySelector('.player-label');
    if (el) el.textContent = label;
    this.name.textContent = cfg ? `${cfg.name || cfg.idName || cfg.path} · ${state}` : state;
    this.name.title = cfg?.idName ?? '';
    if (!this.running) this.stats.textContent = '';
  }

  paintState(): void {
    if (this.player) return;
    const st: EngineState = this.thinker?.state ?? 'stopped';
    // 登録名を出す。id name は長い（版や CPU の種別が付く）ので title に回す
    const name = this.thinker?.config.name || this.thinker?.idName || '';
    const label: Record<EngineState, string> = { stopped: '停止', starting: '起動中', ready: '待機', thinking: '思考中' };
    this.name.textContent = name ? `${name} · ${label[st]}` : '';
    this.name.title = this.thinker?.idName ?? '';
    if (!this.running) this.stats.textContent = '';
  }

  onInfo(info: UsiInfo, t: Target, cfg: EngineConfig, deps: AnalysisDeps, primary: boolean): void {
    const ev = evalOfInfo(info, cfg.eval, t.turn);
    if (!ev) return;
    const mpv = info.multipv ?? 1;
    this.lines.set(mpv, {
      multipv: mpv,
      pSente: ev.pSente,
      cp: ev.cp,
      approx: ev.approx,
      mate: ev.mate,
      depth: info.depth ?? null,
      seldepth: info.seldepth ?? null,
      nodes: info.nodes ?? null,
      nps: info.nps ?? null,
      time: info.time ?? null,
      pv: info.pv ?? [],
    });
    if (info.hashfull !== undefined) this.hashfull = info.hashfull;
    if (primary && mpv === 1) {
      // 詰みはグラフの端に置く。系列は対局中なら手番の側、検討なら検討
      const cp = ev.mate !== null ? (ev.mate > 0 ? MAX_SCORE : -MAX_SCORE) : ev.cp;
      const source: EvalSource = this.player ? (t.turn === 'sente' ? 'sente' : 'gote') : 'analysis';
      deps.onEvaluation(t.ply, { p: ev.pSente, cp, approx: ev.approx }, this.sortedLines(), source);
    }
    // info は秒に数十回来る。描画は間引く。描く局面は最後に受けたもの（間引きの窓の中で局面が変わりうる）
    this.lastTarget = t;
    if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.paintTable(this.lastTarget);
      }, 80);
    }
  }

  sortedLines(): AnalysisLine[] {
    return [...this.lines.values()].sort((a, b) => a.multipv - b.multipv);
  }

  paintTable(t: Target | null): void {
    const lines = this.sortedLines();
    const top = lines[0];
    if (top && t && t.stage !== 'normal') {
      // 布石中の数字は価値ネットの推定。深さやノード数に意味は無いので、代わりに当てにできる度合いを出す。
      // held-out の AUC は 1〜17 手目で 0.62〜0.65、18 手目から 0.69、30 手目以降で 0.76〜0.78（iter1400 以降）。
      const trust = t.ply < 18 ? '序盤の数字は当てにならない' : t.ply < 30 ? '中盤の数字は目安' : '終盤の数字はおおむね当たる';
      this.stats.textContent = t.stage === 'kings' ? '両玉の価値表 · 実対局の勝率' : `布石の価値ネット · ${trust}`;
    } else if (top) {
      // ShogiHome の見出しと同じ並び: ノード数 · NPS · Hash 使用率 · 経過時間
      const parts: string[] = [];
      if (top.nodes !== null) parts.push(`${top.nodes.toLocaleString('ja-JP')} ノード`);
      if (top.nps !== null) parts.push(`${top.nps.toLocaleString('ja-JP')} NPS`);
      if (this.hashfull !== null) parts.push(`Hash ${(this.hashfull / 10).toFixed(1)}%`);
      if (top.time !== null) parts.push(`${(top.time / 1000).toFixed(1)} 秒`);
      this.stats.textContent = parts.join(' · ');
    }
    if (!t || lines.length === 0) {
      this.table.innerHTML = this.running
        ? '<div class="analysis-empty">読み筋を待っています…</div>'
        : this.player
          ? '<div class="analysis-empty">エンジンが考え始めると、読み筋がここに出ます。</div>'
          : '<div class="analysis-empty">検討を始めると、候補手・評価値・期待勝率がここに並びます。</div>';
      return;
    }
    // 列は ShogiHome と同じ 順位 / 深さ / Node数 / 評価値 に、期待勝率 を足して 読み筋。
    // 評価値と期待勝率は**どちらも先手から見た値**（符号と % の向きが食い違わないように）。
    const table = document.createElement('table');
    table.className = 'cand-table';
    table.innerHTML =
      '<thead><tr><th class="c-rank">順位</th><th class="c-depth">深さ</th><th class="c-nodes">Node数</th>' +
      '<th class="c-score">評価値</th><th class="c-p">期待勝率</th><th class="c-pv">読み筋</th></tr></thead>';
    const body = document.createElement('tbody');
    // 布石中の深さ・ノード数は価値ネットの内部の数字で、読みの深さではない。出さない
    const fuseki = t.stage !== 'normal';
    for (const l of lines) {
      const pv = this.panel.pvText(l.pv, t);
      const move = pv[0] ?? '—';
      const scoreText =
        l.mate !== null
          ? `${l.mate > 0 ? '+' : '-'}${Math.abs(l.mate) === 999 ? '' : Math.abs(l.mate)}詰`
          : l.cp !== null
            ? `${l.approx ? '≈' : ''}${l.cp > 0 ? '+' : ''}${l.cp}`
            : '—';
      const depth = fuseki || l.depth === null ? '—' : `${l.depth}${l.seldepth !== null ? '/' + l.seldepth : ''}`;
      const nodes = fuseki || l.nodes === null ? '—' : l.nodes.toLocaleString('ja-JP');
      const pct = (l.pSente * 100).toFixed(1);
      const tr = document.createElement('tr');
      tr.className = 'cand';
      tr.innerHTML = `
        <td class="c-rank">${l.multipv}</td>
        <td class="c-depth">${escapeHtml(depth)}</td>
        <td class="c-nodes">${escapeHtml(nodes)}</td>
        <td class="c-score${l.approx ? ' approx' : ''}"${l.approx ? ' title="このエンジンは評価値を出さない。勝率から換算した目安"' : ''}>${escapeHtml(scoreText)}</td>
        <td class="c-p"><span class="bar" style="--p:${pct}%"><i></i></span><span class="num">${pct}%</span></td>
        <td class="c-pv"><span class="move">${escapeHtml(move)}</span> <span class="rest">${escapeHtml(pv.slice(1, 24).join(' '))}</span></td>`;
      tr.querySelector('.c-pv')!.setAttribute('title', pv.join(' '));
      body.appendChild(tr);
    }
    table.appendChild(body);
    this.table.replaceChildren(table);
  }
}

export class AnalysisPanel {
  private slots: Slot[] = [];
  private players = new Map<0 | 1, Slot>();
  private target: Target | null = null;
  private running = false;
  private readonly toggle: HTMLButtonElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly kifuBtn: HTMLButtonElement;
  private readonly multipv: HTMLInputElement;
  private readonly slotsEl: HTMLElement;
  private readonly playersEl: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly progress: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly deps: AnalysisDeps) {
    root.innerHTML = `
      <div class="analysis-head">
        <button type="button" class="primary" data-act="toggle">検討を始める</button>
        <label class="multipv" title="候補の数（MultiPV）"><span>候補</span><input type="number" min="1" max="20" value="${deps.settings().analysisMultiPv}" /></label>
        <button type="button" class="link" data-act="add" title="もう 1 本のエンジンで同じ局面を検討する">＋ エンジンを足す</button>
        <button type="button" class="link" data-act="kifu" title="棋譜の各局面を順に評価してグラフに入れる">棋譜解析</button>
      </div>
      <div class="analysis-notice panel-notice" hidden></div>
      <div class="analysis-progress" hidden></div>
      <div class="slots"><div class="player-slots"></div><div class="user-slots"></div></div>`;
    this.toggle = root.querySelector('[data-act="toggle"]')!;
    this.addBtn = root.querySelector('[data-act="add"]')!;
    this.kifuBtn = root.querySelector('[data-act="kifu"]')!;
    this.multipv = root.querySelector('.multipv input')!;
    this.slotsEl = root.querySelector('.user-slots')!;
    this.playersEl = root.querySelector('.player-slots')!;
    this.notice = root.querySelector('.panel-notice')!;
    this.progress = root.querySelector('.analysis-progress')!;
    this.toggle.addEventListener('click', () => {
      if (this.running) void this.stop();
      else void this.start();
    });
    this.addBtn.addEventListener('click', () => void this.addSlot(AUTO));
    this.kifuBtn.addEventListener('click', () => this.deps.onKifuAnalysis());
    this.multipv.addEventListener('change', () => {
      const n = Math.min(20, Math.max(1, Math.floor(Number(this.multipv.value) || 1)));
      this.multipv.value = String(n);
      this.deps.settings().analysisMultiPv = n;
      void this.deps.save();
      for (const s of this.slots) if (s.thinker?.hasOption('MultiPV')) s.thinker.setOption('MultiPV', n);
      if (this.running) void this.restartAll();
    });
    for (const id of deps.settings().analysisSlots) this.addSlot(id, false);
    if (this.slots.length === 0) this.addSlot(AUTO, false);
    this.refreshEngineList();
  }

  get isRunning(): boolean {
    return this.running;
  }

  pvText(usis: string[], t: Target): string[] {
    return this.deps.pvText(usis, t);
  }

  // ---- 対局の枠 ----

  /** 手番のエンジンが考え始めた。席ごとに枠を 1 つ持ち、前の読みは消す */
  beginPlayer(seat: 0 | 1, label: string, cfg: EngineConfig, t: Target): void {
    let s = this.players.get(seat);
    if (!s) {
      s = new Slot(seat, this, true);
      this.players.set(seat, s);
      // 席の順に並べる
      const other = this.players.get(seat === 0 ? 1 : 0);
      if (seat === 0 && other) this.playersEl.insertBefore(s.root, other.root);
      else this.playersEl.appendChild(s.root);
    }
    s.playerCfg = cfg;
    s.playerTarget = t;
    s.lines.clear();
    s.hashfull = null;
    s.running = true;
    s.setPlayer(label, '思考中', cfg);
    s.paintTable(t);
  }

  playerInfo(seat: 0 | 1, info: UsiInfo): void {
    const s = this.players.get(seat);
    if (!s || !s.running || !s.playerTarget || !s.playerCfg) return;
    s.onInfo(info, s.playerTarget, s.playerCfg, this.deps, true);
  }

  /** 指した（または中断した）。読みは残す */
  endPlayer(seat: 0 | 1, state = '指した'): void {
    const s = this.players.get(seat);
    if (!s) return;
    s.running = false;
    s.setPlayer(s.root.querySelector('.player-label')?.textContent ?? '', state, s.playerCfg);
    s.paintTable(s.playerTarget);
  }

  /** 対局が変わった。対局の枠を全部消す */
  clearPlayers(): void {
    for (const s of this.players.values()) s.root.remove();
    this.players.clear();
  }

  /** 棋譜解析の進み具合。null で消す */
  setProgress(text: string | null, onStop?: () => void): void {
    this.progress.hidden = !text;
    this.progress.replaceChildren();
    if (!text) return;
    this.progress.append(text);
    if (onStop) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = '止める';
      b.addEventListener('click', onStop);
      this.progress.append(' ', b);
    }
  }

  // ---- 検討の枠 ----

  private addSlot(id: string, persist = true): void {
    if (this.slots.length >= MAX_SLOTS) return;
    const s = new Slot(this.slots.length, this);
    s.engineId = id;
    this.slots.push(s);
    this.slotsEl.appendChild(s.root);
    this.refreshEngineList();
    if (persist) this.persistSlots();
    if (this.running) void this.startSlot(s);
  }

  async removeSlot(s: Slot): Promise<void> {
    if (this.slots.length <= 1) return;
    this.slots = this.slots.filter((x) => x !== s);
    s.root.remove();
    await s.quitAll();
    this.slots.forEach((x, i) => ((x as { index: number }).index = i));
    this.persistSlots();
    this.refreshEngineList();
  }

  private persistSlots(): void {
    this.deps.settings().analysisSlots = this.slots.map((s) => s.engineId);
    void this.deps.save();
  }

  async slotChanged(s: Slot, id: string): Promise<void> {
    s.engineId = id;
    this.persistSlots();
    if (this.running) await this.startSlot(s);
    else s.paintState();
  }

  /** 登録が変わったら呼ぶ */
  refreshEngineList(): void {
    const st = this.deps.settings();
    const hasNormal = st.engines.some((e) => e.kind === 'normal');
    this.notice.hidden = hasNormal;
    if (!hasNormal) {
      this.notice.replaceChildren();
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = 'エンジンを登録する';
      b.addEventListener('click', () => this.deps.openEngineSettings());
      this.notice.append('布石は内蔵の評価で検討できます。41 手目以降には USI エンジンが要ります。', b);
    }
    for (const s of this.slots) {
      const sel = s.select!;
      const cur = s.engineId;
      sel.replaceChildren();
      const add = (value: string, text: string) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
      };
      add(AUTO, '自動（布石は内蔵、41手目から既定のエンジン）');
      add(BUILTIN_ID, '内蔵の布石評価');
      for (const e of st.engines) add(e.id, e.name || e.path);
      sel.value = cur === AUTO || cur === BUILTIN_ID || st.engines.some((e) => e.id === cur) ? cur : AUTO;
      s.engineId = sel.value;
    }
    this.addBtn.disabled = this.slots.length >= MAX_SLOTS;
  }

  private canAnalyze(cfg: EngineConfig, t: Target): string | null {
    if (t.stage === 'choose') return '先手か後手かを選ぶと検討できます。';
    if (t.stage !== 'normal' && cfg.kind !== 'fuseki') return '布石中はこのエンジンでは評価できません。布石対応のエンジンか内蔵の評価を選んでください。';
    if (t.stage === 'normal' && cfg.id === BUILTIN_ID) return '内蔵の評価は布石だけです。41 手目からは本将棋のエンジンを使います。';
    return null;
  }

  /** 表示中の局面が変わったら呼ぶ。検討中なら新しい局面で続ける。 */
  async setTarget(t: Target): Promise<void> {
    // 先後の選択は position に出ないので、局面の文字列だけでは区別できない。段階も見る
    const same = this.target?.positionCmd === t.positionCmd && this.target?.stage === t.stage;
    this.target = t;
    if (this.running && !same) await this.restartAll();
    else for (const s of this.slots) s.paintState();
  }

  async start(): Promise<void> {
    if (!this.target) return;
    this.running = true;
    this.paintHead();
    await Promise.all(this.slots.map((s) => this.startSlot(s)));
  }

  private async restartAll(): Promise<void> {
    await Promise.all(this.slots.map((s) => this.startSlot(s)));
  }

  private async startSlot(s: Slot): Promise<void> {
    const t = this.target;
    if (!t || !this.running) return;
    const st = this.deps.settings();
    const id = s.resolve(st, t);
    if (!id) {
      await s.thinker?.stop();
      s.running = false;
      s.showNotice(t.stage === 'normal' ? '41 手目以降の既定エンジンがありません。エンジンを登録してください。' : '布石を検討するものがありません。');
      s.paintState();
      return;
    }
    // 前のエンジンの候補を消してから次を立てる（起動を待つ間に古い候補が残らないように）
    s.lines.clear();
    s.hashfull = null;
    s.paintTable(t);
    try {
      const th = await s.use(id, this.deps);
      const cfg = th.config;
      const why = this.canAnalyze(cfg, t);
      if (why) {
        await th.stop();
        s.running = false;
        s.showNotice(why);
        s.lines.clear();
        s.hashfull = null;
    s.hashfull = null;
        s.paintTable(t);
        s.paintState();
        return;
      }
      s.showNotice(null);
      s.running = true;
      s.lines.clear();
    s.hashfull = null;
      s.paintTable(t);
      if (th.hasOption('MultiPV')) th.setOption('MultiPV', st.analysisMultiPv);
      const primary = this.slots[0] === s;
      await th.goInfinite(t.positionCmd, (info) => {
        // 同じ局面で setTarget が重なると target の実体が入れ替わる。局面が同じなら受ける
        if (this.target?.positionCmd !== t.positionCmd) return;
        s.onInfo(info, t, cfg, this.deps, primary);
      });
      s.paintState();
    } catch (e) {
      s.running = false;
      s.showNotice(e instanceof Error ? e.message : String(e));
      s.paintState();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.paintHead();
    await Promise.all(this.slots.map(async (s) => {
      s.running = false;
      await s.thinker?.stop();
      s.paintState();
    }));
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.paintHead();
    await Promise.all(this.slots.map((s) => s.quitAll()));
  }

  /** USI ログの手入力は主の枠へ */
  sendRaw(line: string): void {
    this.slots[0]?.thinker?.send(line);
  }

  private paintHead(): void {
    this.toggle.textContent = this.running ? '検討を止める' : '検討を始める';
    this.toggle.classList.toggle('primary', !this.running);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
