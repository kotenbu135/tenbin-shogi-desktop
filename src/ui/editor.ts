// 局面編集。空の盤と、両方の駒台に 20 枚ずつ載った駒から始め、駒台・盤・駒箱のあいだで駒を自由に動かす。
// 盤と駒台の描画は Board が担い、ここは「手に持っている駒」と「局面の中身」を持つ。
//
// 操作（駒の総数は平手の 40 枚から増えも減りもしない）:
//   - 駒台の駒を押して手に持ち、盤のマスを押すと置く。置いた駒はその駒台の側の駒になる
//   - 盤の駒を押すと手に持つ。別のマスを押すと移し、駒台を押すとその側の持ち駒に、駒箱を押すと箱にしまう
//   - 手に持った盤の駒と同じマスを押すと、成る → 向きが変わる → 成る… と切り替わる（玉・金は向きだけ）
//   - 駒を置いたマスに別の駒があれば、その駒は持ち主の駒台へ戻る
//   - 使わない駒は駒箱へ。箱の駒は先手の駒として置き、同じマスを押して向きを変える

import type { Role as OpsRole } from 'shogiops/types';
import type { BoardSnapshot, Color, Piece } from '../state/game.ts';
import { HIRATE_SFEN, roleName } from '../state/game.ts';
import { t } from '../i18n.ts';
import { parseSfen } from 'shogiops/sfen';
import { makeSquareName } from 'shogiops/util';
import { pieceEl } from './board.ts';

/** 手に持っている駒と、その出どころ */
export type Held =
  | { piece: Piece; from: { kind: 'square'; square: string } }
  | { piece: Piece; from: { kind: 'hand'; color: Color } }
  | { piece: Piece; from: { kind: 'box' } };

export interface EditorDeps {
  onChange(): void;
  onStart(sfen: string): void;
  onCancel(): void;
}

/** 持ち駒の並び（SFEN の順）。玉は編集のあいだだけ駒台に載る */
const HAND_ROLES: OpsRole[] = ['rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];
const BOX_ROLES: OpsRole[] = ['king', ...HAND_ROLES];
/** 片側の 20 枚 */
const ONE_SIDE: [OpsRole, number][] = [['king', 1], ['rook', 1], ['bishop', 1], ['gold', 2], ['silver', 2], ['knight', 2], ['lance', 2], ['pawn', 9]];
const PROMOTE: Partial<Record<OpsRole, OpsRole>> = {
  rook: 'dragon', bishop: 'horse', silver: 'promotedsilver', knight: 'promotedknight', lance: 'promotedlance', pawn: 'tokin',
};
const UNPROMOTE: Partial<Record<OpsRole, OpsRole>> = Object.fromEntries(Object.entries(PROMOTE).map(([k, v]) => [v, k])) as Partial<Record<OpsRole, OpsRole>>;
const FORSYTH: Record<string, string> = {
  king: 'K', rook: 'R', bishop: 'B', gold: 'G', silver: 'S', knight: 'N', lance: 'L', pawn: 'P',
  dragon: '+R', horse: '+B', promotedsilver: '+S', promotedknight: '+N', promotedlance: '+L', tokin: '+P',
};

/** 成駒は元の駒に（駒台と駒箱には成っていない駒で載る） */
export function baseRole(role: OpsRole): OpsRole {
  return UNPROMOTE[role] ?? role;
}

/** 同じマスを押したときの次の姿。成る → 向きが変わる → 成る → 元へ。成れない駒は向きだけ変わる */
export function nextFace(p: Piece): Piece {
  const flip: Color = p.color === 'sente' ? 'gote' : 'sente';
  const promoted = PROMOTE[p.role];
  if (promoted) return { color: p.color, role: promoted };
  const base = UNPROMOTE[p.role];
  if (base) return { color: flip, role: base };
  return { color: flip, role: p.role };
}

function fullHand(): Map<OpsRole, number> {
  return new Map(ONE_SIDE);
}

export class PositionEditor {
  pieces = new Map<string, Piece>();
  hands: Record<Color, Map<OpsRole, number>> = { sente: fullHand(), gote: fullHand() };
  box = new Map<OpsRole, number>();
  turn: Color = 'sente';
  held: Held | null = null;

  private readonly root: HTMLElement;
  private readonly deps: EditorDeps;

  constructor(root: HTMLElement, deps: EditorDeps) {
    this.root = root;
    this.deps = deps;
    this.render();
  }

  private changed(): void {
    this.render();
    this.deps.onChange();
  }

  /** 空の盤。40 枚を両方の駒台に 20 枚ずつ戻す */
  reset(): void {
    this.pieces = new Map();
    this.hands = { sente: fullHand(), gote: fullHand() };
    this.box = new Map();
    this.turn = 'sente';
    this.held = null;
    this.changed();
  }

  /** SFEN の局面にする。盤と持ち駒に無い駒は駒箱へ（40 枚に足りない分） */
  loadSfen(sfen: string): void {
    const r = parseSfen('standard', sfen, false);
    if (r.isErr) return;
    const pos = r.value;
    this.pieces = new Map();
    for (const [sq, p] of pos.board) this.pieces.set(makeSquareName(sq), { color: p.color, role: p.role });
    this.hands = { sente: new Map(), gote: new Map() };
    for (const c of ['sente', 'gote'] as const) {
      for (const role of HAND_ROLES) {
        const n = pos.hands.color(c).get(role);
        if (n > 0) this.hands[c].set(role, n);
      }
    }
    this.turn = pos.turn;
    this.fillBox();
    this.held = null;
    this.changed();
  }

  /** 盤と持ち駒で使っていない駒を駒箱に入れる */
  private fillBox(): void {
    const left = new Map<OpsRole, number>(ONE_SIDE.map(([r, n]) => [r, n * 2]));
    const take = (role: OpsRole, n: number) => left.set(baseRole(role), (left.get(baseRole(role)) ?? 0) - n);
    for (const p of this.pieces.values()) take(p.role, 1);
    for (const c of ['sente', 'gote'] as const) for (const [role, n] of this.hands[c]) take(role, n);
    this.box = new Map([...left].filter(([, n]) => n > 0));
  }

  snapshot(): BoardSnapshot {
    return { pieces: new Map(this.pieces), hands: { sente: new Map(this.hands.sente), gote: new Map(this.hands.gote) }, turn: this.turn, lastSquare: null, lastFrom: null, checkSquare: null };
  }

  selectedSquare(): string | null {
    return this.held?.from.kind === 'square' ? this.held.from.square : null;
  }

  /** 手に持っている駒台の駒（盤がその駒を光らせる） */
  selectedHand(): { color: Color; role: OpsRole } | null {
    return this.held?.from.kind === 'hand' ? { color: this.held.from.color, role: this.held.piece.role } : null;
  }

  /** 手に持った駒を出どころから外す */
  private takeHeld(h: Held): void {
    if (h.from.kind === 'square') this.pieces.delete(h.from.square);
    else if (h.from.kind === 'hand') bump(this.hands[h.from.color], h.piece.role, -1);
    else bump(this.box, h.piece.role, -1);
  }

  handleSquare(sq: string): void {
    const h = this.held;
    const here = this.pieces.get(sq);
    if (!h) {
      if (here) this.held = { piece: here, from: { kind: 'square', square: sq } };
      this.changed();
      return;
    }
    this.held = null;
    if (h.from.kind === 'square' && h.from.square === sq) {
      this.pieces.set(sq, nextFace(h.piece));
      this.changed();
      return;
    }
    this.takeHeld(h);
    // 置いたマスにあった駒は、持ち主の駒台へ戻す
    if (here) bump(this.hands[here.color], baseRole(here.role), +1);
    this.pieces.set(sq, h.piece);
    this.changed();
  }

  /** 駒台を押した。role は押した駒（駒台の空いたところなら null） */
  handleHand(color: Color, role: OpsRole | null): void {
    const h = this.held;
    if (!h) {
      if (role && (this.hands[color].get(role) ?? 0) > 0) this.held = { piece: { color, role }, from: { kind: 'hand', color } };
      this.changed();
      return;
    }
    this.held = null;
    // 同じ駒台の駒をもう一度押したら手放すだけ
    if (!(h.from.kind === 'hand' && h.from.color === color)) {
      this.takeHeld(h);
      bump(this.hands[color], baseRole(h.piece.role), +1);
    }
    this.changed();
  }

  /** 駒箱を押した。role は押した駒（箱の空いたところなら null） */
  handleBox(role: OpsRole | null): void {
    const h = this.held;
    if (!h) {
      if (role && (this.box.get(role) ?? 0) > 0) this.held = { piece: { color: 'sente', role }, from: { kind: 'box' } };
      this.changed();
      return;
    }
    this.held = null;
    if (h.from.kind !== 'box') {
      this.takeHeld(h);
      bump(this.box, baseRole(h.piece.role), +1);
    }
    this.changed();
  }

  /** 盤の上の駒をすべて持ち主の駒台へ戻す */
  allToHands(): void {
    for (const p of this.pieces.values()) bump(this.hands[p.color], baseRole(p.role), +1);
    this.pieces = new Map();
    this.held = null;
    this.changed();
  }

  toSfen(): string {
    const rows: string[] = [];
    for (const r of 'abcdefghi') {
      let row = '';
      let empty = 0;
      for (const f of '987654321') {
        const p = this.pieces.get(f + r);
        if (!p) {
          empty++;
          continue;
        }
        if (empty) {
          row += String(empty);
          empty = 0;
        }
        const letter = FORSYTH[p.role] ?? 'P';
        row += p.color === 'sente' ? letter : letter.toLowerCase();
      }
      if (empty) row += String(empty);
      rows.push(row);
    }
    let hand = '';
    for (const c of ['sente', 'gote'] as const) {
      for (const role of HAND_ROLES) {
        const n = this.hands[c].get(role) ?? 0;
        if (!n) continue;
        const letter = FORSYTH[role]!;
        hand += (n > 1 ? String(n) : '') + (c === 'sente' ? letter : letter.toLowerCase());
      }
    }
    return `${rows.join('/')} ${this.turn === 'sente' ? 'b' : 'w'} ${hand || '-'} 1`;
  }

  /** 開始できない理由。無ければ null */
  validate(): string | null {
    const kings = { sente: 0, gote: 0 };
    for (const p of this.pieces.values()) if (p.role === 'king') kings[p.color]++;
    if (kings.sente !== 1 || kings.gote !== 1) return t('ed_need_kings');
    const r = parseSfen('standard', this.toSfen(), true);
    if (r.isErr) return t('ed_bad_position', { msg: r.error.message });
    return null;
  }

  render(): void {
    const root = this.root;
    root.replaceChildren();
    const bar = document.createElement('div');
    bar.className = 'editor-bar';

    const title = document.createElement('span');
    title.className = 'editor-title';
    title.textContent = t('ed_title');
    bar.appendChild(title);

    const turn = document.createElement('div');
    turn.className = 'editor-turn';
    turn.setAttribute('role', 'radiogroup');
    turn.setAttribute('aria-label', t('ed_turn'));
    for (const c of ['sente', 'gote'] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(this.turn === c));
      b.classList.toggle('selected', this.turn === c);
      b.textContent = t(c === 'sente' ? 'ed_turn_sente' : 'ed_turn_gote');
      b.addEventListener('click', () => {
        this.turn = c;
        this.changed();
      });
      turn.appendChild(b);
    }
    bar.appendChild(turn);

    // 駒箱。使わない駒の置き場。空でも押せば手の駒をしまえる
    const box = document.createElement('div');
    box.className = 'editor-box';
    box.classList.toggle('target', this.held !== null && this.held.from.kind !== 'box');
    box.title = t('ed_box');
    box.setAttribute('aria-label', t('ed_box'));
    const label = document.createElement('span');
    label.className = 'editor-box-label';
    label.textContent = t('ed_box');
    box.appendChild(label);
    for (const role of BOX_ROLES) {
      const n = this.box.get(role) ?? 0;
      if (!n) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'box-piece';
      b.dataset.role = role;
      b.classList.toggle('selected', this.held?.from.kind === 'box' && this.held.piece.role === role);
      b.setAttribute('aria-label', t('ed_box_piece', { role: roleName(role), n }));
      b.appendChild(pieceEl({ color: 'sente', role }));
      if (n >= 2) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(n);
        b.appendChild(c);
      }
      box.appendChild(b);
    }
    box.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.box-piece');
      this.handleBox((b?.dataset.role as OpsRole | undefined) ?? null);
    });
    bar.appendChild(box);

    const actions = document.createElement('div');
    actions.className = 'editor-actions';
    const mk = (label: string, cls: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mk(t('ed_hirate'), '', () => this.loadSfen(HIRATE_SFEN));
    mk(t('ed_to_hands'), '', () => this.allToHands());
    mk(t('ed_reset'), '', () => this.reset());
    mk(t('cancel'), '', () => this.deps.onCancel());
    mk(t('ed_start'), 'primary', () => {
      const why = this.validate();
      if (why) {
        alert(why);
        return;
      }
      this.deps.onStart(this.toSfen());
    });
    bar.appendChild(actions);
    root.appendChild(bar);
  }
}

function bump(m: Map<OpsRole, number>, role: OpsRole, d: number): void {
  const n = Math.max(0, (m.get(role) ?? 0) + d);
  if (n === 0) m.delete(role);
  else m.set(role, n);
}
