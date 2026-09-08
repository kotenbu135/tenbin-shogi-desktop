// 天秤グラフ。上段は現局面の勝率で傾く天秤、下段は手数ごとの先手勝率の折れ線。
// 目盛りは常に「先手の勝率」。cp はここに来る前に勝率へ直してある（目盛りの統一）。

export interface EvalPoint {
  ply: number;
  /** 先手の勝率 0..1 */
  p: number;
}

export interface GraphInput {
  points: EvalPoint[];
  /** いま表示している局面の手数（次に指す手が nextPly なら nextPly-1） */
  ply: number;
  /** 現局面の先手勝率。無ければ null（天秤は水平） */
  current: number | null;
  /** 布石の終わり（既定 40） */
  fusekiEnd?: number;
}

const W = 900;
const H = 150;
const BEAM_H = 46;
const PAD_L = 28;
const PAD_R = 14;

export class TenbinGraph {
  constructor(private readonly root: HTMLElement) {
    root.innerHTML = '';
  }

  render(input: GraphInput): void {
    const fusekiEnd = input.fusekiEnd ?? 40;
    const maxPly = Math.max(fusekiEnd + 20, input.ply + 10, ...input.points.map((p) => p.ply));
    const x = (ply: number) => PAD_L + ((W - PAD_L - PAD_R) * ply) / maxPly;
    const top = BEAM_H + 8;
    const bottom = H - 16;
    const y = (p: number) => top + (bottom - top) * (1 - p);

    const cur = input.current;
    const tilt = cur === null ? 0 : (cur - 0.5) * -24; // 先手が良いほど先手側（左）が下がる
    const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

    const line = input.points
      .slice()
      .sort((a, b) => a.ply - b.ply)
      .map((pt, i) => `${i ? 'L' : 'M'}${x(pt.ply).toFixed(1)},${y(pt.p).toFixed(1)}`)
      .join(' ');

    const svg = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tenbin" aria-label="評価グラフ">
  <g class="beam" transform="translate(${W / 2} ${BEAM_H - 10})">
    <line class="post" x1="0" y1="0" x2="0" y2="${BEAM_H - 14}" />
    <g transform="rotate(${tilt.toFixed(2)})">
      <line class="arm" x1="-${W * 0.42}" y1="0" x2="${W * 0.42}" y2="0" />
      <g class="pan sente" transform="translate(-${W * 0.42} 0)"><line x1="0" y1="0" x2="0" y2="14" /><rect x="-30" y="14" width="60" height="6" /></g>
      <g class="pan gote" transform="translate(${W * 0.42} 0)"><line x1="0" y1="0" x2="0" y2="14" /><rect x="-30" y="14" width="60" height="6" /></g>
    </g>
  </g>
  <text class="pan-label sente" x="${W * 0.08 + 40}" y="${BEAM_H + 2}">先手 ${cur === null ? '—' : pct(cur)}</text>
  <text class="pan-label gote" x="${W * 0.92 - 40}" y="${BEAM_H + 2}" text-anchor="end">後手 ${cur === null ? '—' : pct(1 - cur)}</text>

  <rect class="band fuseki" x="${x(0)}" y="${top}" width="${x(fusekiEnd) - x(0)}" height="${bottom - top}" />
  <line class="mid" x1="${x(0)}" y1="${y(0.5)}" x2="${x(maxPly)}" y2="${y(0.5)}" />
  <line class="edge" x1="${x(fusekiEnd)}" y1="${top}" x2="${x(fusekiEnd)}" y2="${bottom}" />
  <text class="axis" x="${x(0)}" y="${bottom + 12}">布石</text>
  <text class="axis" x="${x(fusekiEnd) + 4}" y="${bottom + 12}">本将棋</text>
  <text class="axis" x="${PAD_L - 4}" y="${top + 8}" text-anchor="end">先手</text>
  <text class="axis" x="${PAD_L - 4}" y="${bottom}" text-anchor="end">後手</text>
  ${line ? `<path class="line" d="${line}" />` : ''}
  ${input.points.map((pt) => `<circle class="pt" cx="${x(pt.ply).toFixed(1)}" cy="${y(pt.p).toFixed(1)}" r="2.5" />`).join('')}
  <line class="cursor" x1="${x(input.ply)}" y1="${top}" x2="${x(input.ply)}" y2="${bottom}" />
</svg>`;
    this.root.innerHTML = svg;
  }
}
