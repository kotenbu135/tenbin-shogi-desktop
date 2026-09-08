// 検討パネル。エンジンを1本選び、表示中の局面を渡して MultiPV の読み筋を表にする。
// 評価はここで「先手の勝率」に直してから外へ渡す（グラフと同じ目盛り）。

import { UsiEngine, type EngineConfig, type EngineState } from '../usi/engine.ts';
import { cpToWinrate, winrateToCp, type UsiInfo } from '../usi/parse.ts';
import type { Color, Phase } from '../state/game.ts';
import type { Settings } from '../settings.ts';

export interface AnalysisLine {
  multipv: number;
  /** 先手の勝率 */
  pSente: number;
  /** 手番側 cp（擬似 cp を含む） */
  cp: number | null;
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
  /** ply: 評価した局面の手数（その局面までに指された手数） */
  onEvaluation(ply: number, pSente: number, lines: AnalysisLine[]): void;
  onLog(engineName: string, dir: 'in' | 'out' | 'err' | 'sys', text: string): void;
  openEngineSettings(): void;
  /** 読み筋（USI）を符号の列にする */
  pvText(usis: string[]): string[];
}

export interface Target {
  positionCmd: string;
  phase: Phase;
  turn: Color;
  ply: number;
}

export class AnalysisPanel {
  private engine: UsiEngine | null = null;
  private target: Target | null = null;
  private lines = new Map<number, AnalysisLine>();
  private running = false;
  private readonly select: HTMLSelectElement;
  private readonly toggle: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly table: HTMLElement;
  private readonly notice: HTMLElement;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly root: HTMLElement, private readonly deps: AnalysisDeps) {
    root.innerHTML = `
      <div class="analysis-head">
        <span class="analysis-title">検討</span>
        <select class="engine-select" aria-label="検討に使うエンジン"></select>
        <button type="button" class="primary" data-act="toggle">検討を始める</button>
      </div>
      <div class="analysis-status"><span class="engine-name"></span><span class="engine-stats"></span></div>
      <div class="analysis-notice" hidden></div>
      <div class="analysis-table"></div>`;
    this.select = root.querySelector('.engine-select')!;
    this.toggle = root.querySelector('[data-act="toggle"]')!;
    this.status = root.querySelector('.engine-name')!;
    this.stats = root.querySelector('.engine-stats')!;
    this.table = root.querySelector('.analysis-table')!;
    this.notice = root.querySelector('.analysis-notice')!;
    this.select.addEventListener('change', () => {
      void this.switchEngine(this.select.value);
    });
    this.toggle.addEventListener('click', () => {
      if (this.running) void this.stop();
      else void this.start();
    });
    this.refreshEngineList();
  }

  get isRunning(): boolean {
    return this.running;
  }

  refreshEngineList(): void {
    const s = this.deps.settings();
    const cur = s.analysisEngineId ?? this.select.value;
    this.select.replaceChildren();
    if (s.engines.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'エンジンが未登録';
      this.select.appendChild(o);
      this.select.disabled = true;
      this.toggle.disabled = true;
      this.status.textContent = '';
      this.notice.hidden = false;
      this.notice.replaceChildren();
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = 'エンジンを登録する';
      b.addEventListener('click', () => this.deps.openEngineSettings());
      this.notice.append('検討には USI エンジンが要ります。', b);
      return;
    }
    this.select.disabled = false;
    this.toggle.disabled = false;
    this.notice.hidden = true;
    for (const e of s.engines) {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.name || e.path;
      this.select.appendChild(o);
    }
    const chosen = s.engines.some((e) => e.id === cur) ? cur : s.engines[0]!.id;
    this.select.value = chosen;
    this.paintState();
  }

  private currentConfig(): EngineConfig | null {
    return this.deps.settings().engines.find((e) => e.id === this.select.value) ?? null;
  }

  private async switchEngine(id: string): Promise<void> {
    const wasRunning = this.running;
    await this.shutdown();
    this.deps.settings().analysisEngineId = id;
    if (wasRunning) await this.start();
    this.paintState();
  }

  /** 表示中の局面が変わったら呼ぶ。検討中なら新しい局面で続ける。 */
  async setTarget(t: Target): Promise<void> {
    const same = this.target?.positionCmd === t.positionCmd;
    this.target = t;
    if (this.running && !same) await this.restart();
    else this.paintState();
  }

  private canAnalyze(cfg: EngineConfig, t: Target): string | null {
    if (t.phase === 'over') return '対局は終わっています。';
    if (t.phase === 'choose') return '先手か後手かを選ぶと検討できます。';
    if (t.phase !== 'normal' && cfg.kind !== 'fuseki') {
      return '布石中はこのエンジンでは評価できません。布石対応のエンジンを選んでください。';
    }
    return null;
  }

  async start(): Promise<void> {
    const cfg = this.currentConfig();
    const t = this.target;
    if (!cfg || !t) return;
    const why = this.canAnalyze(cfg, t);
    if (why) {
      this.showNotice(why);
      return;
    }
    this.notice.hidden = true;
    try {
      if (!this.engine || this.engine.config.id !== cfg.id) {
        await this.shutdown();
        this.engine = new UsiEngine(cfg);
        this.engine.onLog = (dir, text) => this.deps.onLog(cfg.name || cfg.path, dir, text);
        this.engine.onStateChange = () => this.paintState();
      }
      if (this.engine.state === 'stopped') {
        this.status.textContent = '起動中…';
        await this.engine.start();
      }
      this.running = true;
      this.lines.clear();
      this.paintTable();
      await this.engine.goInfinite(t.positionCmd, (info) => this.onInfo(info));
      this.paintState();
    } catch (e) {
      this.running = false;
      this.showNotice(e instanceof Error ? e.message : String(e));
      this.paintState();
    }
  }

  private async restart(): Promise<void> {
    if (!this.engine || !this.target) return;
    const cfg = this.engine.config;
    const why = this.canAnalyze(cfg, this.target);
    if (why) {
      await this.engine.stop();
      this.running = false;
      this.showNotice(why);
      this.paintState();
      return;
    }
    this.notice.hidden = true;
    this.lines.clear();
    this.paintTable();
    await this.engine.goInfinite(this.target.positionCmd, (info) => this.onInfo(info));
    this.paintState();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.engine?.stop();
    this.paintState();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    const e = this.engine;
    this.engine = null;
    if (e) await e.quit();
    this.paintState();
  }

  sendRaw(line: string): void {
    this.engine?.send(line);
  }

  private showNotice(text: string): void {
    this.notice.hidden = false;
    this.notice.textContent = text;
  }

  private onInfo(info: UsiInfo): void {
    const t = this.target;
    if (!t) return;
    if (info.string !== undefined && info.scoreCp === undefined && info.winrate === undefined) return;
    const w = this.deps.settings().winrate;
    let pStm: number;
    let cp: number | null = null;
    let mate: number | null = null;
    if (info.scoreMate !== undefined) {
      mate = info.scoreMate;
      pStm = info.scoreMate > 0 ? 1 : 0;
    } else if (info.winrate !== undefined) {
      pStm = info.winrate;
      cp = info.scoreCp ?? winrateToCp(pStm, w.scale, w.offsetCp);
    } else if (info.scoreCp !== undefined) {
      cp = info.scoreCp;
      pStm = cpToWinrate(cp, w.scale, w.offsetCp);
    } else {
      return;
    }
    const pSente = t.turn === 'sente' ? pStm : 1 - pStm;
    const mpv = info.multipv ?? 1;
    this.lines.set(mpv, {
      multipv: mpv,
      pSente,
      cp,
      mate,
      depth: info.depth ?? null,
      seldepth: info.seldepth ?? null,
      nodes: info.nodes ?? null,
      nps: info.nps ?? null,
      time: info.time ?? null,
      pv: info.pv ?? [],
    });
    if (mpv === 1) this.deps.onEvaluation(t.ply, pSente, this.sortedLines());
    // info は秒に数十回来る。描画は間引く。
    if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.paintTable();
      }, 80);
    }
  }

  sortedLines(): AnalysisLine[] {
    return [...this.lines.values()].sort((a, b) => a.multipv - b.multipv);
  }

  private paintState(): void {
    const st: EngineState = this.engine?.state ?? 'stopped';
    this.toggle.textContent = this.running ? '検討を止める' : '検討を始める';
    this.toggle.classList.toggle('primary', !this.running);
    const name = this.engine?.idName || this.currentConfig()?.name || '';
    const label: Record<EngineState, string> = { stopped: '停止', starting: '起動中', ready: '待機', thinking: '思考中' };
    this.status.textContent = name ? `${name} · ${label[st]}` : '';
    if (!this.running) this.stats.textContent = '';
  }

  private paintTable(): void {
    const t = this.target;
    const lines = this.sortedLines();
    const top = lines[0];
    if (top) {
      const parts: string[] = [];
      if (top.depth !== null) parts.push(`深さ ${top.depth}${top.seldepth !== null ? '/' + top.seldepth : ''}`);
      if (top.nodes !== null) parts.push(`${top.nodes.toLocaleString('ja-JP')} ノード`);
      if (top.nps !== null) parts.push(`${top.nps.toLocaleString('ja-JP')} NPS`);
      if (top.time !== null) parts.push(`${(top.time / 1000).toFixed(1)} 秒`);
      this.stats.textContent = parts.join(' · ');
    }
    if (!t || lines.length === 0) {
      this.table.innerHTML = this.running
        ? '<div class="analysis-empty">読み筋を待っています…</div>'
        : '<div class="analysis-empty">検討を始めると、候補手と勝率がここに並びます。</div>';
      return;
    }
    // 候補ごとに2行。1行目に順位・候補手・先手勝率・評価値、2行目に読み筋。
    // 右列は幅が狭いので、表の列に分けると読み筋が縦に潰れる。
    const list = document.createElement('ol');
    list.className = 'cand-list';
    for (const l of lines) {
      const li = document.createElement('li');
      li.className = 'cand';
      const pv = this.deps.pvText(l.pv);
      const move = pv[0] ?? '—';
      const evalText = l.mate !== null
        ? `${l.mate > 0 ? '+' : '-'}${Math.abs(l.mate) === 999 ? '' : Math.abs(l.mate)}詰`
        : l.cp !== null ? (l.cp > 0 ? `+${l.cp}` : String(l.cp)) : '';
      const pct = (l.pSente * 100).toFixed(1);
      li.innerHTML = `
        <div class="cand-head">
          <span class="rank">${l.multipv}</span>
          <span class="move">${escapeHtml(move)}</span>
          <span class="p"><span class="bar" style="--p:${pct}%"><i></i></span><span class="num">${pct}%</span></span>
          <span class="cp" title="手番側の評価値">${escapeHtml(evalText)}</span>
        </div>
        <div class="pv">${escapeHtml(pv.slice(1, 16).join(' '))}</div>`;
      list.appendChild(li);
    }
    this.table.replaceChildren(list);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
