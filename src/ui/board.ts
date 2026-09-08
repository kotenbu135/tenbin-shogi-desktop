// 盤と駒台の描画と、クリックによる入力。
// ルールは持たない。合法な行き先は Game から関数で受け取り、光らせるだけ。

import type { BoardSnapshot, Color, Piece } from '../state/game.ts';
import { ROLE_KANJI } from '../state/game.ts';
import type { Role as OpsRole } from 'shogiops/types';

export interface BoardCallbacks {
  onDrop(role: OpsRole, square: string): void;
  onMove(from: string, to: string): void;
}

export interface RenderOptions {
  interactive: boolean;
  dropSquares(role: OpsRole): Set<string>;
  moveDests(from: string): Set<string>;
  /** マスに載せる印（検討の候補順位など）。square → 短い文字 */
  marks?: Map<string, string>;
}

type Selection = { kind: 'hand'; color: Color; role: OpsRole } | { kind: 'square'; square: string } | null;

const FILES = ['9', '8', '7', '6', '5', '4', '3', '2', '1'];
const RANKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const RANK_KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HAND_ORDER: OpsRole[] = ['king', 'rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];

export class Board {
  private selection: Selection = null;
  private snapshot: BoardSnapshot | null = null;
  private options: RenderOptions | null = null;
  private readonly cells = new Map<string, HTMLButtonElement>();
  private readonly handGote: HTMLElement;
  private readonly handSente: HTMLElement;
  private readonly grid: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly cb: BoardCallbacks) {
    root.innerHTML = `
      <div class="hand hand-gote" data-color="gote"></div>
      <div class="board">
        <div class="coords files">${FILES.map((f) => `<span>${f}</span>`).join('')}</div>
        <div class="grid" role="grid" aria-label="将棋盤"></div>
        <div class="coords ranks">${RANK_KANJI.map((r) => `<span>${r}</span>`).join('')}</div>
      </div>
      <div class="hand hand-sente" data-color="sente"></div>`;
    this.handGote = root.querySelector('.hand-gote')!;
    this.handSente = root.querySelector('.hand-sente')!;
    this.grid = root.querySelector('.grid')!;
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
    // 盤は「使える高さ」と「駒台を除いた幅」の小さい方に合わせる。座標の帯ぶん（約 22px）を引く。
    const fit = () => {
      const r = root.getBoundingClientRect();
      const hands = 68 * 2 + 10 * 2 + 16;
      const size = Math.max(200, Math.floor(Math.min(r.height - 16, r.width - hands)));
      root.style.setProperty('--board-size', `${size}px`);
    };
    new ResizeObserver(fit).observe(root);
    fit();
    for (const el of [this.handGote, this.handSente]) {
      el.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>('.hand-piece');
        if (!t) return;
        this.clickHand(el.dataset.color as Color, t.dataset.role as OpsRole);
      });
    }
  }

  clearSelection(): void {
    this.selection = null;
    this.paint();
  }

  render(snapshot: BoardSnapshot, options: RenderOptions): void {
    this.snapshot = snapshot;
    this.options = options;
    // 選択中の駒が消えていたら選択を捨てる
    if (this.selection?.kind === 'square' && !snapshot.pieces.has(this.selection.square)) this.selection = null;
    if (this.selection?.kind === 'hand' && !(snapshot.hands[this.selection.color].get(this.selection.role) ?? 0)) this.selection = null;
    this.paint();
  }

  private paint(): void {
    const s = this.snapshot;
    const o = this.options;
    if (!s || !o) return;
    const dests = this.destsForSelection();
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
      cell.classList.toggle('last', s.lastSquare === sq);
      cell.classList.toggle('check', s.checkSquare === sq);
      cell.classList.toggle('selected', this.selection?.kind === 'square' && this.selection.square === sq);
      cell.classList.toggle('dest', dests.has(sq));
      cell.disabled = !o.interactive;
    }
    this.paintHand(this.handGote, 'gote');
    this.paintHand(this.handSente, 'sente');
  }

  private paintHand(el: HTMLElement, color: Color): void {
    const s = this.snapshot!;
    const o = this.options!;
    el.replaceChildren();
    const hand = s.hands[color];
    for (const role of HAND_ORDER) {
      const n = hand.get(role) ?? 0;
      if (n === 0) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hand-piece';
      b.dataset.role = role;
      b.disabled = !o.interactive || s.turn !== color;
      b.classList.toggle('selected', this.selection?.kind === 'hand' && this.selection.color === color && this.selection.role === role);
      b.appendChild(pieceEl({ color, role }));
      if (n > 1) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(n);
        b.appendChild(c);
      }
      el.appendChild(b);
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
  const text = p.role === 'king' ? (p.color === 'sente' ? '玉' : '王') : (ROLE_KANJI[p.role] ?? p.role);
  d.textContent = text;
  const promoted = ['tokin', 'promotedlance', 'promotedknight', 'promotedsilver', 'horse', 'dragon'].includes(p.role);
  if (promoted) d.classList.add('promoted');
  return d;
}
