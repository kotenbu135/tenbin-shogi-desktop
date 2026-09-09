// 評価グラフ。ShogiHome と同じく **2 種類**を持つ。
//
//   評価値（score）    先手から見た cp。±2000 で頭打ち（ShogiHome の MAX_SCORE と同じ）
//   期待勝率（winrate） 先手の勝率 0〜100%
//
// 系列は 3 本（ShogiHome は対局者ごと＋検討 1〜4 に分ける）:
//   sente / gote  対局中に**その手番のエンジン**が出した値。実戦で指した側の判断
//   analysis      検討と棋譜解析の値。あとから見直した判断
//
// cp はエンジンごとに目盛りが違い、布石の内蔵評価には cp が無い（勝率から換算した目安）。
// 換算した点は中を抜いた丸で描き、凡例に断る。共通の通貨は勝率のほうである。
// グラフを押すとその手数の局面へ移る（将棋所・ShogiGUI・ShogiHome のどれもそう動く）。

export type EvalSource = 'sente' | 'gote' | 'analysis';
export type ChartType = 'score' | 'winrate';

export interface EvalPoint {
  ply: number;
  /** 先手の勝率 0..1 */
  p: number;
  /** 先手から見た cp。無ければ null */
  cp: number | null;
  /** cp が勝率からの換算（内蔵の布石評価など）なら true */
  approx: boolean;
  source: EvalSource;
}

export interface GraphInput {
  points: EvalPoint[];
  /** いま表示している局面の手数 */
  ply: number;
  /** 現局面の評価（勝率と cp）。無ければ null */
  current: { p: number; cp: number | null; approx: boolean } | null;
  /** 布石の終わり（既定 40）。任意局面からの本将棋なら 0 */
  fusekiEnd?: number;
}

export const MAX_SCORE = 2000;

import { t, type Key } from '../i18n.ts';

const PAD_L = 46;
const PAD_R = 14;
/** 折れ線を描く枠の上端。凡例はこの上の余白に置く（布石・本将棋の見出しと重ならないように） */
const TOP = 20;
const PAD_B = 22;

// 凡例の文言は描くときに引く（言語の設定は起動の途中で決まるので、読み込み時には固めない）
const SERIES: { key: EvalSource; label: Key }[] = [
  { key: 'sente', label: 'graph_series_sente' },
  { key: 'gote', label: 'graph_series_gote' },
  { key: 'analysis', label: 'graph_series_analysis' },
];

export class TenbinGraph {
  private maxPly = 60;
  private svg: SVGSVGElement | null = null;
  private last: GraphInput | null = null;
  /** グラフを押したときに呼ぶ。ply はいちばん近い手数 */
  onSeek: ((ply: number) => void) | null = null;

  constructor(private readonly root: HTMLElement, private readonly type_: ChartType) {
    root.innerHTML = '';
    root.addEventListener('click', (e) => {
      if (!this.svg || !this.onSeek) return;
      const r = this.svg.getBoundingClientRect();
      const w = r.width || 1;
      const xv = e.clientX - r.left;
      const ply = Math.round(((xv - PAD_L) / Math.max(1, w - PAD_L - PAD_R)) * this.maxPly);
      this.onSeek(Math.max(0, Math.min(this.maxPly, ply)));
    });
    // 下の欄の高さが変わったら描き直す（文字を歪ませないため viewBox は実寸）
    new ResizeObserver(() => {
      if (this.last) this.render(this.last);
    }).observe(root);
  }

  get type(): ChartType {
    return this.type_;
  }

  render(input: GraphInput): void {
    this.last = input;
    const score = this.type_ === 'score';
    const W = Math.max(360, Math.round(this.root.clientWidth || 900));
    const H = Math.max(120, Math.round(this.root.clientHeight || 180));
    const BOTTOM = H - PAD_B;
    const fusekiEnd = input.fusekiEnd ?? 40;
    const maxPly = Math.max(fusekiEnd + 20, input.ply + 10, ...input.points.map((p) => p.ply));
    this.maxPly = maxPly;
    const x = (ply: number) => PAD_L + ((W - PAD_L - PAD_R) * ply) / maxPly;
    const yp = (p: number) => TOP + (BOTTOM - TOP) * (1 - p);
    const ycp = (cp: number) => yp((Math.max(-MAX_SCORE, Math.min(MAX_SCORE, cp)) + MAX_SCORE) / (2 * MAX_SCORE));
    const yOf = (pt: EvalPoint) => (score ? ycp(pt.cp!) : yp(pt.p));

    let approx = false;
    const series = SERIES.map(({ key, label }) => {
      const pts = input.points
        .filter((p) => p.source === key && (!score || p.cp !== null))
        .sort((a, b) => a.ply - b.ply);
      if (score && pts.some((p) => p.approx)) approx = true;
      const d = pts.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.ply).toFixed(1)},${yOf(pt).toFixed(1)}`).join(' ');
      return {
        key,
        label: t(label),
        n: pts.length,
        path: d ? `<path class="line ${key}" d="${d}" />` : '',
        dots: pts
          .map(
            (pt) =>
              `<circle class="pt ${key}${score && pt.approx ? ' approx' : ''}" cx="${x(pt.ply).toFixed(1)}" cy="${yOf(pt).toFixed(1)}" r="2.5" />`,
          )
          .join(''),
      };
    });

    // 手数の目盛り。10手ごと、布石の終わりは必ず入れる
    const ticks: number[] = [];
    for (let p = 0; p <= maxPly; p += 10) ticks.push(p);
    if (fusekiEnd > 0 && !ticks.includes(fusekiEnd)) ticks.push(fusekiEnd);

    // 縦軸。評価値は ±2000 を 1000 刻み、勝率は 0/50/100%
    const rows = score
      ? [MAX_SCORE, MAX_SCORE / 2, 0, -MAX_SCORE / 2, -MAX_SCORE].map((cp) => ({
          y: ycp(cp),
          text: cp > 0 ? `+${cp}` : String(cp),
          mid: cp === 0,
        }))
      : [1, 0.5, 0].map((p) => ({ y: yp(p), text: `${p * 100}%`, mid: p === 0.5 }));

    // 現局面は評価値と期待勝率を**両方**出す。どちらのタブでも、そのタブの量を先に置く
    const cur = input.current;
    const cpText = cur === null || cur.cp === null ? null : `${cur.approx ? '≈' : ''}${cur.cp > 0 ? '+' : ''}${cur.cp}`;
    const pText = cur === null ? null : `${(cur.p * 100).toFixed(1)}%`;
    const both = score ? [cpText, pText] : [pText, cpText];
    const curLabel = cur === null ? '' : t('graph_current', { v: both.filter((v) => v !== null).join(' · ') });
    const cx = x(input.ply);
    const labelRight = cx < W - 130;
    const legend = series.filter((s) => s.n > 0).map((s) => `<tspan class="lg ${s.key}">━</tspan> ${s.label}`);
    if (approx) legend.push(`<tspan class="lg approx">○</tspan> ${t('graph_approx')}`);
    // 狭い欄では凡例を畳む（線の色だけで読める）
    const showLegend = legend.length > 0 && W > 380;

    this.root.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="tenbin" aria-label="${t('graph_title', { kind: t(score ? 'graph_score' : 'graph_winrate') })}" role="img">
  ${fusekiEnd > 0 ? `<rect class="band fuseki" x="${x(0)}" y="${TOP}" width="${x(fusekiEnd) - x(0)}" height="${BOTTOM - TOP}" />` : ''}
  ${rows.map((r) => `<line class="${r.mid ? 'mid' : 'grid'}" x1="${x(0)}" y1="${r.y.toFixed(1)}" x2="${x(maxPly)}" y2="${r.y.toFixed(1)}" />`).join('')}
  <line class="axis-line" x1="${x(0)}" y1="${TOP}" x2="${x(0)}" y2="${BOTTOM}" />
  <line class="axis-line" x1="${x(0)}" y1="${BOTTOM}" x2="${x(maxPly)}" y2="${BOTTOM}" />
  ${fusekiEnd > 0 ? `<line class="edge" x1="${x(fusekiEnd)}" y1="${TOP}" x2="${x(fusekiEnd)}" y2="${BOTTOM}" />` : ''}
  ${rows.map((r) => `<text class="axis" x="${x(0) - 6}" y="${(r.y + 4).toFixed(1)}" text-anchor="end">${r.text}</text>`).join('')}
  ${ticks.map((p) => `<text class="axis" x="${x(p).toFixed(1)}" y="${BOTTOM + 14}" text-anchor="middle">${p}</text>`).join('')}
  ${fusekiEnd > 0 ? `<text class="axis label" x="${x(fusekiEnd / 2).toFixed(1)}" y="${TOP + 12}" text-anchor="middle">${t('phase_fuseki')}</text><text class="axis label" x="${(x(fusekiEnd) + 6).toFixed(1)}" y="${TOP + 12}">${t('phase_normal')}</text>` : ''}
  ${showLegend ? `<text class="axis legend" x="${W - PAD_R}" y="13" text-anchor="end">${legend.join('　')}</text>` : ''}
  ${series.map((s) => s.path).join('')}${series.map((s) => s.dots).join('')}
  <line class="cursor" x1="${cx.toFixed(1)}" y1="${TOP}" x2="${cx.toFixed(1)}" y2="${BOTTOM}" />
  ${curLabel ? `<text class="axis current" x="${(labelRight ? cx + 5 : cx - 5).toFixed(1)}" y="${BOTTOM - 5}" text-anchor="${labelRight ? 'start' : 'end'}">${curLabel}</text>` : ''}
</svg>`;
    this.svg = this.root.querySelector('svg');
  }
}
