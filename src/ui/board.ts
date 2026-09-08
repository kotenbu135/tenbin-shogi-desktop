// 盤・駒台・名札の描画と、クリックによる入力。
// ルールは持たない。合法な行き先は Game から関数で受け取り、光らせるだけ。
//
// 慣習（日本将棋連盟の盤面図、ShogiHome・将棋所と同じ）:
//   - 先手が手前（下）。筋は上に 9〜1 の算用数字、段は右に 一〜九 の漢数字
//   - 後手の駒台は左上、先手の駒台は右下。駒台の駒は 玉 飛 角 金 銀 桂 香 歩 の順
//   - マスは実物の盤と同じく縦長（1尺2寸 × 1尺1寸 ≒ 1.09）
//   - 駒の画像は公開版サイトと同じ lishogi の kanji_light（Ka-hu, CC BY 4.0）。
//     後手の駒は回転済みの別ファイル（1*.svg）で、CSS では回さない

import type { BoardSnapshot, Color, Phase, Piece } from '../state/game.ts';
import { colorMark, colorName } from '../state/game.ts';
import type { Role as OpsRole } from 'shogiops/types';

export interface BoardCallbacks {
  onDrop(role: OpsRole, square: string): void;
  onMove(from: string, to: string): void;
}

export interface RenderOptions {
  interactive: boolean;
  phase: Phase;
  dropSquares(role: OpsRole): Set<string>;
  moveDests(from: string): Set<string>;
  /** マスに載せる印（検討の候補順位など）。square → 短い文字 */
  marks?: Map<string, string>;
  /** 名札の名前。省略時は 先手／後手 */
  names?: Record<Color, string>;
}

type Selection = { kind: 'hand'; color: Color; role: OpsRole } | { kind: 'square'; square: string } | null;

const FILES = ['9', '8', '7', '6', '5', '4', '3', '2', '1'];
const RANKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const RANK_KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 駒台の並び（先手から見て左上→右下）。後手は逆順にして、後手から見て同じ並びにする */
const STAND_ORDER: OpsRole[] = ['king', 'rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];
const STAND_ORDER_NO_KING: OpsRole[] = ['rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];

/** kanji_light のファイル名。0 が先手、1 が後手（回転済み） */
const PIECE_CODE: Record<string, string> = {
  pawn: 'FU', lance: 'KY', knight: 'KE', silver: 'GI', gold: 'KI', bishop: 'KA', rook: 'HI',
  tokin: 'TO', promotedlance: 'NY', promotedknight: 'NK', promotedsilver: 'NG', horse: 'UM', dragon: 'RY',
};

export function pieceCode(p: Piece): string {
  // 玉将は下位者（先手）、王将は上位者（後手）が持つ慣習
  if (p.role === 'king') return p.color === 'sente' ? '0GY' : '1OU';
  return `${p.color === 'sente' ? 0 : 1}${PIECE_CODE[p.role] ?? 'FU'}`;
}

export class Board {
  private selection: Selection = null;
  private snapshot: BoardSnapshot | null = null;
  private options: RenderOptions | null = null;
  private readonly cells = new Map<string, HTMLButtonElement>();
  private readonly stands: Record<Color, HTMLElement>;
  private readonly plates: Record<Color, HTMLElement>;
  private readonly grid: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly cb: BoardCallbacks) {
    root.classList.add('shogi');
    root.innerHTML = `
      <div class="stand gote" data-color="gote">
        <div class="stand-pieces"></div>
        <div class="plate"></div>
      </div>
      <div class="board-wrap">
        <div class="files">${FILES.map((f) => `<span>${f}</span>`).join('')}</div>
        <div class="board"><div class="grid" role="grid" aria-label="将棋盤"></div></div>
        <div class="ranks">${RANK_KANJI.map((r) => `<span>${r}</span>`).join('')}</div>
      </div>
      <div class="stand sente" data-color="sente">
        <div class="plate"></div>
        <div class="stand-pieces"></div>
      </div>`;
    this.grid = root.querySelector('.grid')!;
    this.stands = {
      gote: root.querySelector('.stand.gote .stand-pieces')!,
      sente: root.querySelector('.stand.sente .stand-pieces')!,
    };
    this.plates = {
      gote: root.querySelector('.stand.gote .plate')!,
      sente: root.querySelector('.stand.sente .plate')!,
    };
    for (const r of RANKS) {
      for (const f of FILES) {
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
    for (const c of ['sente', 'gote'] as const) {
      this.stands[c].addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>('.slot');
        if (!t || !t.dataset.role) return;
        this.clickHand(c, t.dataset.role as OpsRole);
      });
    }
    // マスの幅 --sq を、使える高さと幅の小さい方から決める。
    // 幅: 駒台(2.3) + 隙間(0.35) + 盤(9) + 段の帯(0.55) + 隙間(0.35) + 駒台(2.3) ≒ 14.85
    // 高さ: 筋の帯(0.5) + 盤(9 × 1.09) ≒ 10.35（+ 名札のぶん 0.6）
    const fit = () => {
      const r = root.getBoundingClientRect();
      const sq = Math.floor(Math.min((r.width - 24) / 14.85, (r.height - 24) / 10.95));
      root.style.setProperty('--sq', `${Math.max(24, sq)}px`);
    };
    new ResizeObserver(fit).observe(root);
    fit();
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
    this.paint();
  }

  private paint(): void {
    const s = this.snapshot;
    const o = this.options;
    if (!s || !o) return;
    const dests = this.destsForSelection();
    const zone = o.phase === 'kings' || o.phase === 'fuseki' ? s.turn : null;
    this.root.classList.toggle('phase-normal', o.phase === 'normal' || o.phase === 'over');
    for (const [sq, cell] of this.cells) {
      const p = s.pieces.get(sq);
      cell.replaceChildren();
      if (p) cell.appendChild(pieceEl(p));
      const mark = o.marks?.get(sq);
      if (mark) {
        const m = document.createElement('span');
        m.className = 'mark';
        m.textContent = mark;
        cell.appendChild(m);
      }
      const rank = sq.charCodeAt(1) - 96; // a=1
      cell.classList.toggle('zone', zone === 'sente' ? rank >= 6 : zone === 'gote' ? rank <= 4 : false);
      cell.classList.toggle('last', s.lastSquare === sq);
      cell.classList.toggle('last-from', s.lastFrom === sq);
      cell.classList.toggle('check', s.checkSquare === sq);
      cell.classList.toggle('selected', this.selection?.kind === 'square' && this.selection.square === sq);
      cell.classList.toggle('dest', dests.has(sq));
      cell.classList.toggle('oc', dests.has(sq) && !!p);
      cell.disabled = !o.interactive;
    }
    this.paintStand('gote');
    this.paintStand('sente');
  }

  private paintStand(color: Color): void {
    const s = this.snapshot!;
    const o = this.options!;
    const el = this.stands[color];
    el.replaceChildren();
    const hand = s.hands[color];
    const withKing = o.phase !== 'normal' && o.phase !== 'over';
    const base = withKing ? STAND_ORDER : STAND_ORDER_NO_KING;
    const order = color === 'sente' ? base : [...base].reverse();
    const toMove = s.turn === color;
    for (const role of order) {
      const n = hand.get(role) ?? 0;
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'slot';
      slot.dataset.role = role;
      slot.dataset.n = String(n);
      slot.disabled = !o.interactive || !toMove || n === 0;
      slot.classList.toggle('selected', this.selection?.kind === 'hand' && this.selection.color === color && this.selection.role === role);
      slot.classList.toggle('dim', n === 0);
      if (o.phase === 'kings') slot.classList.toggle('faded', role !== 'king');
      slot.appendChild(pieceEl({ color, role }));
      if (n >= 2) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(n);
        slot.appendChild(c);
      }
      slot.setAttribute('aria-label', `${colorName(color)}の持ち駒 ${role} ${n}枚`);
      el.appendChild(slot);
    }
    el.classList.toggle('with-king', withKing);
    const plate = this.plates[color];
    const name = o.names?.[color] ?? colorName(color);
    plate.replaceChildren();
    const mark = document.createElement('span');
    mark.className = 'plate-mark';
    mark.textContent = colorMark(color);
    const label = document.createElement('span');
    label.className = 'plate-name';
    label.textContent = name;
    plate.append(mark, label);
    const active = toMove && o.phase !== 'over' && o.phase !== 'choose';
    plate.classList.toggle('to-move', active);
    if (active) {
      const t = document.createElement('span');
      t.className = 'plate-turn';
      t.textContent = '手番';
      plate.appendChild(t);
    }
  }

  private destsForSelection(): Set<string> {
    const sel = this.selection;
    const o = this.options;
    if (!sel || !o) return new Set();
    return sel.kind === 'hand' ? o.dropSquares(sel.role) : o.moveDests(sel.square);
  }

  private clickHand(color: Color, role: OpsRole): void {
    const s = this.snapshot;
    if (!s || !this.options?.interactive || s.turn !== color) return;
    const sel = this.selection;
    this.selection = sel?.kind === 'hand' && sel.role === role && sel.color === color ? null : { kind: 'hand', color, role };
    this.paint();
  }

  private clickSquare(sq: string): void {
    const s = this.snapshot;
    if (!s || !this.options?.interactive) return;
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

function pieceEl(p: Piece): HTMLElement {
  const d = document.createElement('div');
  d.className = `piece ${p.color} ${p.role}`;
  d.dataset.code = pieceCode(p);
  return d;
}
