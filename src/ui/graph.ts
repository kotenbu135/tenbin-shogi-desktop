// 評価グラフ。手数ごとの先手勝率の折れ線。目盛りは常に「先手の勝率」。
// cp はここに来る前に勝率へ直してある（目盛りの統一）。
//
// 系列は 2 本（ShogiHome の「対局者の評価」と「検討の評価」と同じ分け方）:
//   play     対局中にその手番のエンジンが読んだ値。実戦で指した側の判断
//   analysis 検討と棋譜解析の値。あとから見直した判断
// グラフを押すとその手数の局面へ移る（将棋所・ShogiGUI・ShogiHome のどれもそう動く）。

export type EvalSource = 'play' | 'analysis';

export interface EvalPoint {
  ply: number;
  /** 先手の勝率 0..1 */
  p: number;
  source: EvalSource;
}

export interface GraphInput {
  points: EvalPoint[];
  /** いま表示している局面の手数 */
  ply: number;
  /** 現局面の先手勝率。無ければ null */
  current: number | null;
  /** 布石の終わり（既定 40）。任意局面からの本将棋なら 0 */
  fusekiEnd?: number;
}

const H = 150;
const W = 900;
const PAD_L = 44;
const PAD_R = 16;
const TOP = 14;
const BOTTOM = H - 22;

export class TenbinGraph {
  private maxPly = 60;
  private svg: SVGSVGElement | null = null;
  /** グラフを押したときに呼ぶ。ply はいちばん近い手数 */
  onSeek: ((ply: number) => void) | null = null;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = '';
    root.addEventListener('click', (e) => {
      if (!this.svg || !this.onSeek) return;
      const r = this.svg.getBoundingClientRect();
      const xv = ((e.clientX - r.left) / r.width) * W;
      const ply = Math.round(((xv - PAD_L) / (W - PAD_L - PAD_R)) * this.maxPly);
      this.onSeek(Math.max(0, Math.min(this.maxPly, ply)));
    });
  }

  render(input: GraphInput): void {
    const fusekiEnd = input.fusekiEnd ?? 40;
    const maxPly = Math.max(fusekiEnd + 20, input.ply + 10, ...input.points.map((p) => p.ply));
    this.maxPly = maxPly;
    const x = (ply: number) => PAD_L + ((W - PAD_L - PAD_R) * ply) / maxPly;
    const y = (p: number) => TOP + (BOTTOM - TOP) * (1 - p);

    const series = (src: EvalSource) => {
      const pts = input.points.filter((p) => p.source === src).sort((a, b) => a.ply - b.ply);
      const d = pts.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.ply).toFixed(1)},${y(pt.p).toFixed(1)}`).join(' ');
      return {
        n: pts.length,
        path: d ? `<path class="line ${src}" d="${d}" />` : '',
        dots: pts.map((pt) => `<circle class="pt ${src}" cx="${x(pt.ply).toFixed(1)}" cy="${y(pt.p).toFixed(1)}" r="2.5" />`).join(''),
      };
    };
    const play = series('play');
    const analysis = series('analysis');

    // 手数の目盛り。10手ごと、布石の終わりは必ず入れる
    const ticks: number[] = [];
    for (let t = 0; t <= maxPly; t += 10) ticks.push(t);
    if (fusekiEnd > 0 && !ticks.includes(fusekiEnd)) ticks.push(fusekiEnd);

    const cur = input.current;
    const curLabel = cur === null ? '' : `先手 ${(cur * 100).toFixed(1)}%`;
    const cx = x(input.ply);
    const labelRight = cx < W - 120;
    const legend: string[] = [];
    if (play.n) legend.push('<tspan class="lg play">━</tspan> 対局');
    if (analysis.n) legend.push('<tspan class="lg analysis">━</tspan> 検討');

    this.root.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tenbin" aria-label="評価グラフ" role="img">
  ${fusekiEnd > 0 ? `<rect class="band fuseki" x="${x(0)}" y="${TOP}" width="${x(fusekiEnd) - x(0)}" height="${BOTTOM - TOP}" />` : ''}
  <line class="axis-line" x1="${x(0)}" y1="${TOP}" x2="${x(0)}" y2="${BOTTOM}" />
  <line class="axis-line" x1="${x(0)}" y1="${BOTTOM}" x2="${x(maxPly)}" y2="${BOTTOM}" />
  <line class="mid" x1="${x(0)}" y1="${y(0.5)}" x2="${x(maxPly)}" y2="${y(0.5)}" />
  ${fusekiEnd > 0 ? `<line class="edge" x1="${x(fusekiEnd)}" y1="${TOP}" x2="${x(fusekiEnd)}" y2="${BOTTOM}" />` : ''}
  <text class="axis" x="${x(0) - 6}" y="${TOP + 4}" text-anchor="end">100%</text>
  <text class="axis" x="${x(0) - 6}" y="${y(0.5) + 4}" text-anchor="end">50%</text>
  <text class="axis" x="${x(0) - 6}" y="${BOTTOM + 1}" text-anchor="end">0%</text>
  ${ticks.map((t) => `<text class="axis" x="${x(t)}" y="${BOTTOM + 13}" text-anchor="middle">${t}</text>`).join('')}
  ${fusekiEnd > 0 ? `<text class="axis label" x="${x(fusekiEnd / 2)}" y="${TOP + 11}" text-anchor="middle">布石</text><text class="axis label" x="${x(fusekiEnd) + 6}" y="${TOP + 11}">本将棋</text>` : ''}
  ${legend.length ? `<text class="axis legend" x="${W - PAD_R}" y="${TOP + 11}" text-anchor="end">${legend.join('　')}</text>` : ''}
  ${analysis.path}${analysis.dots}
  ${play.path}${play.dots}
  <line class="cursor" x1="${cx}" y1="${TOP}" x2="${cx}" y2="${BOTTOM}" />
  ${curLabel ? `<text class="axis current" x="${labelRight ? cx + 5 : cx - 5}" y="${BOTTOM - 4}" text-anchor="${labelRight ? 'start' : 'end'}">${curLabel}</text>` : ''}
</svg>`;
    this.svg = this.root.querySelector('svg');
  }
}
