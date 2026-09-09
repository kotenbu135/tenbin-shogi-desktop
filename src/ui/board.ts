// 盤・駒台・名札・時計の描画と、クリックによる入力。
// ルールは持たない。合法な行き先は Game から関数で受け取り、光らせるだけ。
//
// 慣習（日本将棋連盟の盤面図、ShogiHome・将棋所と同じ）:
//   - 先手が手前（下）。筋は上に 9〜1 の算用数字、段は右に 一〜九 の漢数字。反転すると逆順
//   - 後手の駒台は左上、先手の駒台は右下（反転すると入れ替わる）。駒台の駒は 玉 飛 角 金 銀 桂 香 歩 の順
//   - マスは実物の盤と同じく縦長（1尺2寸 × 1尺1寸 ≒ 1.09）
//   - 駒の画像は公開版サイトと同じ lishogi の kanji_light（Ka-hu, CC BY 4.0）。
//     後手の駒は回転済みの別ファイル（1*.svg）で、CSS では回さない。反転時は色と絵の対応を入れ替える

import type { BoardSnapshot, Color, Phase, Piece } from '../state/game.ts';
import { colorMark, roleName } from '../state/game.ts';
import { lang, sideName, t } from '../i18n.ts';
import type { ClockView } from '../state/clock.ts';
import type { Role as OpsRole } from 'shogiops/types';

export type Orientation = 'sente' | 'gote';

export interface BoardCallbacks {
  onDrop(role: OpsRole, square: string): void;
  onMove(from: string, to: string): void;
  /** 局面編集中のクリック */
  onEditSquare?(square: string): void;
  onEditHand?(color: Color, role: OpsRole): void;
}

/** 検討の候補などを盤に描く形。from が無ければ駒打ち（行き先に輪） */
export interface Shape {
  from?: string;
  to: string;
  rank: number;
}

export interface RenderOptions {
  interactive: boolean;
  /** エンジンが考えている側（名札に動く印を出す） */
  thinking?: Color | null;
  phase: Phase;
  dropSquares(role: OpsRole): Set<string>;
  moveDests(from: string): Set<string>;
  shapes?: Shape[];
  /** 名札の名前。省略時は 先手／後手 */
  names?: Partial<Record<Color, string>>;
  clocks?: Record<Color, ClockView | null>;
  /** 局面編集。すべてのマスと駒台を押せる。selected は手に持っている駒の元のマス */
  edit?: { selected?: string | null };
}

type Selection = { kind: 'hand'; color: Color; role: OpsRole } | { kind: 'square'; square: string } | null;

const FILES = ['9', '8', '7', '6', '5', '4', '3', '2', '1'];
const RANKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const RANK_KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 英語のときの段。符号が "P-76" の数字2つなので、盤の目盛りも数字で揃える */
const RANK_NUM = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** 駒台の並び（手前の対局者から見て左上→右下）。奥の対局者は逆順にして、その人から見て同じ並びにする */
const STAND_ORDER: OpsRole[] = ['king', 'rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];
const STAND_ORDER_NO_KING: OpsRole[] = ['rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];

/** kanji_light のファイル名。0 が手前向き、1 が奥向き（回転済み） */
const PIECE_CODE: Record<string, string> = {
  pawn: 'FU', lance: 'KY', knight: 'KE', silver: 'GI', gold: 'KI', bishop: 'KA', rook: 'HI',
  tokin: 'TO', promotedlance: 'NY', promotedknight: 'NK', promotedsilver: 'NG', horse: 'UM', dragon: 'RY',
};

export function pieceCode(p: Piece, orientation: Orientation = 'sente'): string {
  // 玉将は先手、王将は後手（上位者が王将を持つ慣習）。向きは盤の向きで決まる
  const facingViewer = p.color === orientation;
  const prefix = facingViewer ? '0' : '1';
  if (p.role === 'king') return `${prefix}${p.color === 'sente' ? 'GY' : 'OU'}`;
  return `${prefix}${PIECE_CODE[p.role] ?? 'FU'}`;
}

// 盤の描画座標（SVG の矢印用）。マス幅 100、高さ 109
const SQ_W = 100;
const SQ_H = 109;

export class Board {
  private selection: Selection = null;
  private snapshot: BoardSnapshot | null = null;
  private options: RenderOptions | null = null;
  private orientation: Orientation = 'sente';
  private readonly cells = new Map<string, HTMLButtonElement>();
  private readonly standFar: HTMLElement;
  private readonly standNear: HTMLElement;
  private readonly plateFar: HTMLElement;
  private readonly plateNear: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly shapesEl: SVGSVGElement;
  private readonly filesEl: HTMLElement;
  private readonly ranksEl: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly cb: BoardCallbacks) {
    root.classList.add('shogi');
    root.innerHTML = `
      <div class="stand far">
        <div class="stand-pieces"></div>
        <div class="plate"></div>
      </div>
      <div class="board-wrap">
        <div class="files"></div>
        <div class="board"><div class="grid" role="grid" aria-label="${t('board_aria')}"></div><svg class="shapes" viewBox="0 0 ${SQ_W * 9} ${SQ_H * 9}" aria-hidden="true"></svg></div>
        <div class="ranks"></div>
      </div>
      <div class="stand near">
        <div class="plate"></div>
        <div class="stand-pieces"></div>
      </div>`;
    this.grid = root.querySelector('.grid')!;
    this.shapesEl = root.querySelector('svg.shapes')!;
    this.filesEl = root.querySelector('.files')!;
    this.ranksEl = root.querySelector('.ranks')!;
    this.standFar = root.querySelector('.stand.far .stand-pieces')!;
    this.standNear = root.querySelector('.stand.near .stand-pieces')!;
    this.plateFar = root.querySelector('.stand.far .plate')!;
    this.plateNear = root.querySelector('.stand.near .plate')!;
    this.buildGrid();
    for (const el of [this.standFar, this.standNear]) {
      el.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>('.slot');
        if (!t || !t.dataset.role) return;
        this.clickHand(el.dataset.color as Color, t.dataset.role as OpsRole);
      });
    }
    // マスの幅 --sq を、使える高さと幅の小さい方から決める。
    // 幅: 駒台(2.3) + 隙間(0.35) + 盤(9) + 段の帯(0.55) + 隙間(0.35) + 駒台(2.3) ≒ 14.85
    // 高さ: 筋の帯(0.5) + 盤(9 × 1.09) ≒ 10.35（+ 名札と時計のぶん 0.6）
    const fit = () => {
      const r = root.getBoundingClientRect();
      const sq = Math.floor(Math.min((r.width - 24) / 14.85, (r.height - 24) / 10.95));
      root.style.setProperty('--sq', `${Math.max(24, sq)}px`);
    };
    new ResizeObserver(fit).observe(root);
    fit();
  }

  get currentOrientation(): Orientation {
    return this.orientation;
  }

  /** 盤の向き。後手向きにすると筋・段・駒台・駒の向きがすべて入れ替わる */
  setOrientation(o: Orientation): void {
    if (o === this.orientation) return;
    this.orientation = o;
    this.buildGrid();
    this.paint();
  }

  private displayFiles(): string[] {
    return this.orientation === 'sente' ? FILES : [...FILES].reverse();
  }

  private displayRanks(): string[] {
    return this.orientation === 'sente' ? RANKS : [...RANKS].reverse();
  }

  private buildGrid(): void {
    this.grid.replaceChildren();
    this.cells.clear();
    const files = this.displayFiles();
    const ranks = this.displayRanks();
    for (const r of ranks) {
      for (const f of files) {
        const sq = f + r;
        const b = document.createElement('button');
        b.className = 'cell';
        b.dataset.sq = sq;
        b.type = 'button';
        b.setAttribute('aria-label', sq);
        b.addEventListener('click', () => this.clickSquare(sq));
        this.grid.appendChild(b);
        this.cells.set(sq, b);
      }
    }
    this.filesEl.innerHTML = files.map((f) => `<span>${f}</span>`).join('');
    const rankLabels = lang() === 'en' ? RANK_NUM : RANK_KANJI;
    this.ranksEl.innerHTML = ranks.map((r) => `<span>${rankLabels[r.charCodeAt(0) - 97]}</span>`).join('');
    this.standFar.dataset.color = this.orientation === 'sente' ? 'gote' : 'sente';
    this.standNear.dataset.color = this.orientation;
  }

  /** マスの表示上の位置（列, 行）。矢印の座標に使う */
  private displayPos(sq: string): { col: number; row: number } {
    const col = this.displayFiles().indexOf(sq[0]!);
    const row = this.displayRanks().indexOf(sq[1]!);
    return { col, row };
  }

  clearSelection(): void {
    this.selection = null;
    this.paint();
  }

  render(snapshot: BoardSnapshot, options: RenderOptions): void {
    this.snapshot = snapshot;
    this.options = options;
    if (this.selection?.kind === 'square' && !snapshot.pieces.has(this.selection.square)) this.selection = null;
    if (this.selection?.kind === 'hand' && !(snapshot.hands[this.selection.color].get(this.selection.role) ?? 0)) this.selection = null;
    if (options.edit) this.selection = null;
    this.paint();
  }

  /** 時計だけを描き直す（毎秒呼ばれるので、盤全体は触らない） */
  updateClocks(clocks: Record<Color, ClockView | null>): void {
    if (!this.options) return;
    this.options.clocks = clocks;
    this.paintPlate('sente');
    this.paintPlate('gote');
  }

  private paint(): void {
    const s = this.snapshot;
    const o = this.options;
    if (!s || !o) return;
    const dests = this.destsForSelection();
    const zone = !o.edit && (o.phase === 'kings' || o.phase === 'fuseki') ? s.turn : null;
    this.root.classList.toggle('phase-normal', o.phase === 'normal' || o.phase === 'over');
    this.root.classList.toggle('editing', !!o.edit);
    for (const [sq, cell] of this.cells) {
      const p = s.pieces.get(sq);
      cell.replaceChildren();
      if (p) cell.appendChild(pieceEl(p, this.orientation));
      const rank = sq.charCodeAt(1) - 96; // a=1
      cell.classList.toggle('zone', zone === 'sente' ? rank >= 6 : zone === 'gote' ? rank <= 4 : false);
      cell.classList.toggle('last', !o.edit && s.lastSquare === sq);
      cell.classList.toggle('last-from', !o.edit && s.lastFrom === sq);
      cell.classList.toggle('check', !o.edit && s.checkSquare === sq);
      cell.classList.toggle('selected', (this.selection?.kind === 'square' && this.selection.square === sq) || o.edit?.selected === sq);
      cell.classList.toggle('dest', dests.has(sq));
      cell.classList.toggle('oc', dests.has(sq) && !!p);
      cell.disabled = !o.interactive && !o.edit;
    }
    this.paintStand('gote');
    this.paintStand('sente');
    this.paintPlate('gote');
    this.paintPlate('sente');
    this.paintShapes(o.shapes ?? []);
  }

  private standFor(color: Color): HTMLElement {
    return color === this.orientation ? this.standNear : this.standFar;
  }

  private plateFor(color: Color): HTMLElement {
    return color === this.orientation ? this.plateNear : this.plateFar;
  }

  private paintStand(color: Color): void {
    const s = this.snapshot!;
    const o = this.options!;
    const el = this.standFor(color);
    el.replaceChildren();
    const hand = s.hands[color];
    const withKing = !o.edit && o.phase !== 'normal' && o.phase !== 'over';
    const base = withKing ? STAND_ORDER : STAND_ORDER_NO_KING;
    const near = color === this.orientation;
    const order = near ? base : [...base].reverse();
    const toMove = s.turn === color;
    for (const role of order) {
      const n = hand.get(role) ?? 0;
      // 持っていない駒は駒台に出さない（実際の駒台と同じ）。
      // 局面編集だけは全種類を並べる（無い駒を盤へ置くための台なので）。
      // 布石のあいだは 20 枚を持っているので、置けない駒も薄くせずそのまま出す（押せないだけ）
      if (!o.edit && n === 0) continue;
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'slot';
      slot.dataset.role = role;
      slot.dataset.n = String(n);
      // 両玉を置く間に置けるのは玉だけ。押せなくするが、薄くはしない
      slot.disabled = o.edit ? false : !o.interactive || !toMove || (o.phase === 'kings' && role !== 'king');
      slot.classList.toggle('selected', this.selection?.kind === 'hand' && this.selection.color === color && this.selection.role === role);
      slot.appendChild(pieceEl({ color, role }, this.orientation));
      // 枚数は 2 枚以上のときに出す。局面編集では 0 枚も出す（薄くする代わりに数で示す）
      if (n >= 2 || (o.edit && n !== 1)) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(n);
        slot.appendChild(c);
      }
      slot.setAttribute('aria-label', t('hand_aria', { side: sideName(color), role: roleName(role), n }));
      el.appendChild(slot);
    }
    el.classList.toggle('with-king', withKing);
  }

  private paintPlate(color: Color): void {
    const s = this.snapshot;
    const o = this.options;
    if (!s || !o) return;
    const plate = this.plateFor(color);
    const name = o.names?.[color] || sideName(color);
    plate.replaceChildren();
    const mark = document.createElement('span');
    mark.className = 'plate-mark';
    mark.textContent = colorMark(color);
    const label = document.createElement('span');
    label.className = 'plate-name';
    label.textContent = name;
    plate.append(mark, label);
    const active = !o.edit && s.turn === color && o.phase !== 'over' && o.phase !== 'choose';
    plate.classList.toggle('to-move', active);
    if (active) {
      const tn = document.createElement('span');
      // エンジンが考えているあいだは、動く印を出す（長考でも画面が止まって見えないように）
      const thinking = o.thinking === color;
      tn.className = 'plate-turn' + (thinking ? ' thinking' : '');
      tn.textContent = t(thinking ? 'plate_thinking' : 'plate_to_move');
      if (thinking) {
        const dots = document.createElement('span');
        dots.className = 'thinking-dots';
        dots.setAttribute('aria-hidden', 'true');
        dots.innerHTML = '<i></i><i></i><i></i>';
        tn.append(' ', dots);
      }
      plate.appendChild(tn);
    }
    const ck = o.clocks?.[color];
    if (ck) {
      const c = document.createElement('span');
      c.className = 'plate-clock' + (ck.running ? ' running' : '') + (ck.inByoyomi ? ' byoyomi' : '');
      c.textContent = ck.inByoyomi && ck.byoyomi !== null ? t('plate_byoyomi', { sec: ck.byoyomi }) : ck.main;
      plate.appendChild(c);
    }
  }

  private paintShapes(shapes: Shape[]): void {
    const parts: string[] = [];
    const center = (sq: string) => {
      const { col, row } = this.displayPos(sq);
      return { x: (col + 0.5) * SQ_W, y: (row + 0.5) * SQ_H };
    };
    // 順位の低い方から描き、1位を最後に（上に）重ねる
    for (const sh of [...shapes].sort((a, b) => b.rank - a.rank)) {
      const r = Math.min(sh.rank, 3);
      const to = center(sh.to);
      if (sh.from) {
        const from = center(sh.from);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const head = 26;
        const tipX = to.x - ux * 30;
        const tipY = to.y - uy * 30;
        const baseX = tipX - ux * head;
        const baseY = tipY - uy * head;
        const px = -uy;
        const py = ux;
        parts.push(
          `<g class="shape r${r}">` +
            `<line x1="${from.x + ux * 22}" y1="${from.y + uy * 22}" x2="${baseX}" y2="${baseY}" />` +
            `<polygon points="${tipX},${tipY} ${baseX + px * 15},${baseY + py * 15} ${baseX - px * 15},${baseY - py * 15}" />` +
            badge(to.x + 36, to.y - 40, sh.rank) +
            '</g>',
        );
      } else {
        parts.push(
          `<g class="shape r${r}">` +
            `<ellipse class="ring" cx="${to.x}" cy="${to.y}" rx="38" ry="42" />` +
            badge(to.x + 36, to.y - 40, sh.rank) +
            '</g>',
        );
      }
    }
    this.shapesEl.innerHTML = parts.join('');
  }

  private destsForSelection(): Set<string> {
    const sel = this.selection;
    const o = this.options;
    if (!sel || !o || o.edit) return new Set();
    return sel.kind === 'hand' ? o.dropSquares(sel.role) : o.moveDests(sel.square);
  }

  private clickHand(color: Color, role: OpsRole): void {
    const s = this.snapshot;
    const o = this.options;
    if (!s || !o) return;
    if (o.edit) {
      this.cb.onEditHand?.(color, role);
      return;
    }
    if (!o.interactive || s.turn !== color) return;
    const sel = this.selection;
    this.selection = sel?.kind === 'hand' && sel.role === role && sel.color === color ? null : { kind: 'hand', color, role };
    this.paint();
  }

  private clickSquare(sq: string): void {
    const s = this.snapshot;
    const o = this.options;
    if (!s || !o) return;
    if (o.edit) {
      this.cb.onEditSquare?.(sq);
      return;
    }
    if (!o.interactive) return;
    const sel = this.selection;
    const dests = this.destsForSelection();
    if (sel && dests.has(sq)) {
      this.selection = null;
      if (sel.kind === 'hand') this.cb.onDrop(sel.role, sq);
      else this.cb.onMove(sel.square, sq);
      return;
    }
    const p = s.pieces.get(sq);
    if (p && p.color === s.turn && !(sel?.kind === 'square' && sel.square === sq)) {
      this.selection = { kind: 'square', square: sq };
    } else {
      this.selection = null;
    }
    this.paint();
  }
}

function badge(x: number, y: number, rank: number): string {
  return `<circle class="badge" cx="${x}" cy="${y}" r="15" /><text class="badge-text" x="${x}" y="${y + 6}" text-anchor="middle">${rank}</text>`;
}

export function pieceEl(p: Piece, orientation: Orientation = 'sente'): HTMLElement {
  const d = document.createElement('div');
  d.className = `piece ${p.color} ${p.role}`;
  d.dataset.code = pieceCode(p, orientation);
  return d;
}
