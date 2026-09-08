// 評価グラフ。左に天秤、右に手数ごとの先手勝率の折れ線。
// 目盛りは常に「先手の勝率」。cp はここに来る前に勝率へ直してある（目盛りの統一）。
//
// 天秤は現局面の勝率で傾く。左の皿が先手（塗り・朱）、右の皿が後手（輪郭・藍）。
// 重い（勝率の高い）側が下がる。

export interface EvalPoint {
  ply: number;
  /** 先手の勝率 0..1 */
  p: number;
}

export interface GraphInput {
  points: EvalPoint[];
  /** いま表示している局面の手数 */
  ply: number;
  /** 現局面の先手勝率。無ければ null（天秤は水平） */
  current: number | null;
  /** 布石の終わり（既定 40） */
  fusekiEnd?: number;
}

const H = 150;
const W = 900;
const SCALE_W = 190; // 天秤の幅
const PAD_L = SCALE_W + 44;
const PAD_R = 16;
const TOP = 14;
const BOTTOM = H - 22;

export class TenbinGraph {
  constructor(private readonly root: HTMLElement) {
    root.innerHTML = '';
  }

  render(input: GraphInput): void {
    const fusekiEnd = input.fusekiEnd ?? 40;
    const maxPly = Math.max(fusekiEnd + 20, input.ply + 10, ...input.points.map((p) => p.ply));
    const x = (ply: number) => PAD_L + ((W - PAD_L - PAD_R) * ply) / maxPly;
    const y = (p: number) => TOP + (BOTTOM - TOP) * (1 - p);
    const cur = input.current;
    const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

    const line = input.points
      .slice()
      .sort((a, b) => a.ply - b.ply)
      .map((pt, i) => `${i ? 'L' : 'M'}${x(pt.ply).toFixed(1)},${y(pt.p).toFixed(1)}`)
      .join(' ');

    // 手数の目盛り。10手ごと、40手（布石の終わり）は必ず入れる
    const ticks: number[] = [];
    for (let t = 0; t <= maxPly; t += 10) ticks.push(t);
    if (!ticks.includes(fusekiEnd)) ticks.push(fusekiEnd);

    const svg = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tenbin" aria-label="評価グラフ">
  ${scale(cur)}
  <rect class="band fuseki" x="${x(0)}" y="${TOP}" width="${x(fusekiEnd) - x(0)}" height="${BOTTOM - TOP}" />
  <line class="axis-line" x1="${x(0)}" y1="${TOP}" x2="${x(0)}" y2="${BOTTOM}" />
  <line class="axis-line" x1="${x(0)}" y1="${BOTTOM}" x2="${x(maxPly)}" y2="${BOTTOM}" />
  <line class="mid" x1="${x(0)}" y1="${y(0.5)}" x2="${x(maxPly)}" y2="${y(0.5)}" />
  <line class="edge" x1="${x(fusekiEnd)}" y1="${TOP}" x2="${x(fusekiEnd)}" y2="${BOTTOM}" />
  <text class="axis" x="${x(0) - 6}" y="${TOP + 4}" text-anchor="end">100%</text>
  <text class="axis" x="${x(0) - 6}" y="${y(0.5) + 4}" text-anchor="end">50%</text>
  <text class="axis" x="${x(0) - 6}" y="${BOTTOM + 1}" text-anchor="end">0%</text>
  ${ticks.map((t) => `<text class="axis" x="${x(t)}" y="${BOTTOM + 13}" text-anchor="middle">${t}</text>`).join('')}
  <text class="axis label" x="${x(fusekiEnd / 2)}" y="${TOP + 11}" text-anchor="middle">布石</text>
  <text class="axis label" x="${x(fusekiEnd) + 6}" y="${TOP + 11}">本将棋</text>
  ${line ? `<path class="line" d="${line}" />` : ''}
  ${input.points.map((pt) => `<circle class="pt" cx="${x(pt.ply).toFixed(1)}" cy="${y(pt.p).toFixed(1)}" r="2.5" />`).join('')}
  <line class="cursor" x1="${x(input.ply)}" y1="${TOP}" x2="${x(input.ply)}" y2="${BOTTOM}" />
</svg>`;
    this.root.innerHTML = svg;
  }
}

/** 天秤。支柱と台、傾く梁、糸で吊った皿。 */
function scale(cur: number | null): string {
  const cx = SCALE_W / 2 + 10; // 支柱の x
  const top = 26; // 梁の高さ
  const armLen = 66;
  const tilt = cur === null ? 0 : (cur - 0.5) * -22; // 先手（左）が重いと左が下がる
  const stringLen = 30;
  const panW = 40;
  const s = cur === null ? '—' : (cur * 100).toFixed(1) + '%';
  const g = cur === null ? '—' : ((1 - cur) * 100).toFixed(1) + '%';
  return `
  <g class="scale" aria-hidden="true">
    <path class="base" d="M${cx - 30} ${H - 26} h60" />
    <path class="post" d="M${cx} ${H - 26} V${top}" />
    <path class="base" d="M${cx - 6} ${top} l6 -7 l6 7 z" />
    <g transform="translate(${cx} ${top}) rotate(${tilt.toFixed(2)})">
      <path class="arm" d="M${-armLen} 0 H${armLen}" />
      <g class="pan sente" transform="translate(${-armLen} 0)">
        <path class="string" d="M0 0 l-${panW / 2 - 2} ${stringLen} M0 0 l${panW / 2 - 2} ${stringLen}" />
        <path class="dish" d="M${-panW / 2} ${stringLen} h${panW} a${panW / 2} 10 0 0 1 -${panW} 0 z" />
      </g>
      <g class="pan gote" transform="translate(${armLen} 0)">
        <path class="string" d="M0 0 l-${panW / 2 - 2} ${stringLen} M0 0 l${panW / 2 - 2} ${stringLen}" />
        <path class="dish" d="M${-panW / 2} ${stringLen} h${panW} a${panW / 2} 10 0 0 1 -${panW} 0 z" />
      </g>
    </g>
    <text class="pan-label sente" x="${cx - armLen}" y="${H - 8}" text-anchor="middle">先手 ${s}</text>
    <text class="pan-label gote" x="${cx + armLen}" y="${H - 8}" text-anchor="middle">後手 ${g}</text>
  </g>`;
}
