// 棋譜解析。棋譜の局面を順にエンジンへ渡して 1 手ずつ評価し、グラフの「検討」の系列を埋める。
// 将棋所・ShogiGUI・ShogiHome のどれにもある、対局のあとの決まった流れ（対局 → 棋譜解析 → 気になる局面を検討）。
//
// 使うエンジンは検討の「自動」と同じ（布石は既定の布石評価、41 手目からは既定の本将棋エンジン）。
// 検討の枠とは別のプロセスを立てる（枠の検討を止めずに済む）。内蔵の評価は 1 つしか無いので共用。

import type { EngineConfig, Thinker } from '../usi/engine.ts';
import type { UsiInfo } from '../usi/parse.ts';
import { normalEngine, type Settings } from '../settings.ts';
import { evalOfInfo, type Target } from './analysis.ts';

export interface KifuAnalysisOptions {
  /** 何手目の局面から（棋譜の index。0 は開始局面） */
  fromIndex: number;
  secPerMove: number;
}

export interface KifuAnalysisDeps {
  settings(): Settings;
  createThinker(id: string, processTag: string): Thinker | null;
  /** 棋譜の各局面（index 順。choose の局面は含めない） */
  targets(): { index: number; target: Target }[];
  onPoint(ply: number, pSente: number): void;
  /** 進み具合の文。null で終わり */
  onProgress(text: string | null): void;
  onLog(engineName: string, dir: 'in' | 'out' | 'err' | 'sys', text: string): void;
}

export class KifuAnalyzer {
  private pool = new Map<string, Thinker>();
  private gen = 0;
  running = false;

  constructor(private readonly deps: KifuAnalysisDeps) {}

  private async thinker(id: string): Promise<Thinker> {
    let th = this.pool.get(id);
    if (!th) {
      th = this.deps.createThinker(id, 'kifu') ?? undefined;
      if (!th) throw new Error('エンジンが登録から消えている');
      th.onLog = (dir, text) => this.deps.onLog(th!.config.name || th!.config.path, dir, text);
      this.pool.set(id, th);
    }
    if (th.state === 'stopped') {
      await th.start();
      await th.newGame();
      if (th.hasOption('MultiPV')) th.setOption('MultiPV', 1);
    }
    return th;
  }

  private resolve(t: Target): string | null {
    const s = this.deps.settings();
    if (t.stage === 'normal') return normalEngine(s)?.id ?? null;
    return s.fusekiEngineId;
  }

  /** 解析した局面の数を返す */
  async run(opts: KifuAnalysisOptions): Promise<number> {
    await this.stop();
    const gen = ++this.gen;
    this.running = true;
    const all = this.deps.targets().filter((x) => x.index >= opts.fromIndex && x.target.stage !== 'choose');
    let done = 0;
    let skipped = 0;
    try {
      for (const { target } of all) {
        if (gen !== this.gen) break;
        const id = this.resolve(target);
        if (!id) {
          skipped++;
          continue;
        }
        const th = await this.thinker(id);
        if (gen !== this.gen) break;
        const cfg: EngineConfig = th.config;
        this.deps.onProgress(`棋譜解析 ${done + 1} / ${all.length} 局面 · ${target.ply} 手目 · ${cfg.name || cfg.path}`);
        let last: UsiInfo | null = null;
        try {
          await th.go(target.positionCmd, `movetime ${Math.round(opts.secPerMove * 1000)}`, (info) => {
            if ((info.multipv ?? 1) === 1 && (info.scoreCp !== undefined || info.scoreMate !== undefined || info.winrate !== undefined)) last = info;
          });
        } catch (e) {
          this.deps.onLog(cfg.name || cfg.path, 'sys', `棋譜解析 ${target.ply} 手目: ${e instanceof Error ? e.message : String(e)}`);
          skipped++;
          continue;
        }
        if (gen !== this.gen) break;
        const ev = last ? evalOfInfo(last, cfg.eval, target.turn) : null;
        if (ev) this.deps.onPoint(target.ply, ev.pSente);
        done++;
      }
    } finally {
      if (gen === this.gen) {
        this.running = false;
        this.deps.onProgress(null);
      }
    }
    if (skipped && gen === this.gen) this.deps.onLog('棋譜解析', 'sys', `${skipped} 局面を飛ばした（その段階のエンジンが無い、または評価が返らない）`);
    return done;
  }

  async stop(): Promise<void> {
    this.gen++;
    this.running = false;
    await Promise.all([...this.pool.values()].map((t) => t.stop()));
    this.deps.onProgress(null);
  }

  async shutdown(): Promise<void> {
    this.gen++;
    this.running = false;
    const all = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(all.map((t) => t.quit()));
  }
}

/** 棋譜解析の設定（範囲と 1 手の秒数）。null なら取りやめ */
export function askKifuAnalysis(host: HTMLElement, defaults: { secPerMove: number; hasCursor: boolean; cursorPly: number }): Promise<KifuAnalysisOptions | null> {
  const dialog = document.createElement('dialog');
  dialog.className = 'save-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="dialog-body">
      <div class="dialog-head"><h2>棋譜解析</h2></div>
      <p class="hint">棋譜の局面を順にエンジンで評価し、グラフの「検討」の線を引きます。布石は内蔵の評価、41 手目からは既定のエンジンを使います。</p>
      <fieldset class="kind">
        <legend>範囲</legend>
        <label><input type="radio" name="range" value="all" ${defaults.hasCursor ? '' : 'checked'} /> 最初から最後まで</label>
        <label><input type="radio" name="range" value="here" ${defaults.hasCursor ? 'checked' : ''} ${defaults.hasCursor ? '' : 'disabled'} /> 表示中の局面（${defaults.cursorPly} 手目）から最後まで</label>
      </fieldset>
      <label class="sec-row">1 局面の秒数 <input name="sec" type="number" min="0.2" max="600" step="0.1" value="${defaults.secPerMove}" /></label>
      <div class="dialog-actions">
        <button type="button" data-act="cancel">やめる</button>
        <button type="submit" class="primary" data-act="ok">解析を始める</button>
      </div>
    </form>`;
  host.appendChild(dialog);
  return new Promise((resolve) => {
    let result: KifuAnalysisOptions | null = null;
    const form = dialog.querySelector('form')!;
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', () => {
      const fd = new FormData(form);
      const sec = Math.min(600, Math.max(0.2, Number(fd.get('sec')) || 2));
      result = { fromIndex: fd.get('range') === 'here' ? -1 : 0, secPerMove: sec };
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
  });
}
