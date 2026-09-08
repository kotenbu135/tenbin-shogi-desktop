// 局面編集。盤と駒台を自由に組み、その局面から本将棋を始める。
// 盤の描画は Board が担い、ここは「手に持っている駒」と「局面の中身」を持つ。
//
// 操作:
//   - 下の駒の一覧から駒を選び、マスを押すと置く（同じ駒で続けて置ける）
//   - 何も選ばずに盤の駒を押すと、その駒を手に持つ。次に押したマスへ移す。駒台を押せば持ち駒にする
//   - 「消す」を選んでマスを押すと取り除く
//   - 駒台の＋−で持ち駒を増減する

import type { Role as OpsRole } from 'shogiops/types';
import type { BoardSnapshot, Color, Piece } from '../state/game.ts';
import { HIRATE_SFEN, ROLE_KANJI } from '../state/game.ts';
import { parseSfen } from 'shogiops/sfen';
import { makeSquareName } from 'shogiops/util';
import { pieceEl } from './board.ts';

export type Tool = { kind: 'piece'; piece: Piece; fromSquare?: string } | { kind: 'erase' } | null;

export interface EditorDeps {
  onChange(): void;
  onStart(sfen: string): void;
  onCancel(): void;
}

const HAND_ROLES: OpsRole[] = ['rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];
const PALETTE_ROLES: OpsRole[] = ['king', 'rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn', 'dragon', 'horse', 'promotedsilver', 'promotedknight', 'promotedlance', 'tokin'];
const PROMOTE: Partial<Record<OpsRole, OpsRole>> = {
  rook: 'dragon', bishop: 'horse', silver: 'promotedsilver', knight: 'promotedknight', lance: 'promotedlance', pawn: 'tokin',
};
const UNPROMOTE: Partial<Record<OpsRole, OpsRole>> = Object.fromEntries(Object.entries(PROMOTE).map(([k, v]) => [v, k])) as Partial<Record<OpsRole, OpsRole>>;
const FORSYTH: Record<string, string> = {
  king: 'K', rook: 'R', bishop: 'B', gold: 'G', silver: 'S', knight: 'N', lance: 'L', pawn: 'P',
  dragon: '+R', horse: '+B', promotedsilver: '+S', promotedknight: '+N', promotedlance: '+L', tokin: '+P',
};

export class PositionEditor {
  pieces = new Map<string, Piece>();
  hands: Record<Color, Map<OpsRole, number>> = { sente: new Map(), gote: new Map() };
  turn: Color = 'sente';
  tool: Tool = null;

  constructor(private readonly root: HTMLElement, private readonly deps: EditorDeps) {
    this.render();
  }

  /** 表示中の局面から始める */
  loadSnapshot(s: BoardSnapshot): void {
    this.pieces = new Map(s.pieces);
    this.hands = { sente: new Map(s.hands.sente), gote: new Map(s.hands.gote) };
    this.turn = s.turn;
    this.tool = null;
    this.render();
    this.deps.onChange();
  }

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
    this.tool = null;
    this.render();
    this.deps.onChange();
  }

  clear(): void {
    this.pieces = new Map();
    this.hands = { sente: new Map(), gote: new Map() };
    this.turn = 'sente';
    this.tool = null;
    this.render();
    this.deps.onChange();
  }

  snapshot(): BoardSnapshot {
    return { pieces: new Map(this.pieces), hands: { sente: new Map(this.hands.sente), gote: new Map(this.hands.gote) }, turn: this.turn, lastSquare: null, lastFrom: null, checkSquare: null };
  }

  selectedSquare(): string | null {
    return this.tool?.kind === 'piece' ? this.tool.fromSquare ?? null : null;
  }

  handleSquare(sq: string): void {
    const t = this.tool;
    const here = this.pieces.get(sq);
    if (t?.kind === 'erase') {
      this.pieces.delete(sq);
    } else if (t?.kind === 'piece') {
      if (t.fromSquare === sq) {
        // 元のマスを押した: 成／不成を切り替える
        const alt = PROMOTE[t.piece.role] ?? UNPROMOTE[t.piece.role];
        if (alt) this.pieces.set(sq, { ...t.piece, role: alt });
        else this.pieces.set(sq, t.piece);
        this.tool = null;
      } else {
        this.pieces.set(sq, t.piece);
        if (t.fromSquare) {
          this.pieces.delete(t.fromSquare);
          this.tool = null; // 盤から取った駒は1回置いたら手放す
        }
      }
    } else if (here) {
      // 手に持つ（元のマスには残したまま。置く先を押すと移る）
      this.tool = { kind: 'piece', piece: here, fromSquare: sq };
    }
    this.render();
    this.deps.onChange();
  }

  handleHand(color: Color, role: OpsRole): void {
    const t = this.tool;
    if (t?.kind === 'piece') {
      // 手の駒を駒台へ（成駒は生駒にして、その色の持ち駒に）
      const base = UNPROMOTE[t.piece.role] ?? t.piece.role;
      if (base !== 'king') this.bump(color, base, +1);
      if (t.fromSquare) {
        this.pieces.delete(t.fromSquare);
        this.tool = null;
      }
    } else if (t?.kind === 'erase') {
      this.bump(color, role, -1);
    } else {
      // 駒台の駒を手に持つ
      if ((this.hands[color].get(role) ?? 0) > 0) {
        this.bump(color, role, -1);
        this.tool = { kind: 'piece', piece: { color, role } };
      }
    }
    this.render();
    this.deps.onChange();
  }

  private bump(color: Color, role: OpsRole, d: number): void {
    const n = Math.max(0, (this.hands[color].get(role) ?? 0) + d);
    if (n === 0) this.hands[color].delete(role);
    else this.hands[color].set(role, n);
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
    if (kings.sente !== 1 || kings.gote !== 1) return '玉は先手・後手に1枚ずつ置いてください';
    const r = parseSfen('standard', this.toSfen(), false);
    if (r.isErr) return `局面として成り立ちません: ${r.error.message}`;
    return null;
  }

  render(): void {
    const root = this.root;
    root.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'editor-head';
    head.innerHTML = `<span class="editor-title">局面編集</span><span class="editor-hint">駒を選んでマスへ。盤の駒を押すと手に持ち、もう一度同じマスを押すと成・不成が切り替わります。</span>`;
    root.appendChild(head);

    const body = document.createElement('div');
    body.className = 'editor-body';
    for (const color of ['sente', 'gote'] as const) {
      const row = document.createElement('div');
      row.className = 'palette-row';
      const lab = document.createElement('span');
      lab.className = 'palette-label';
      lab.textContent = color === 'sente' ? '☗先手' : '☖後手';
      row.appendChild(lab);
      for (const role of PALETTE_ROLES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'palette-piece';
        const sel = this.tool?.kind === 'piece' && !this.tool.fromSquare && this.tool.piece.color === color && this.tool.piece.role === role;
        b.classList.toggle('selected', sel);
        b.title = `${color === 'sente' ? '先手' : '後手'}の${ROLE_KANJI[role]}`;
        b.appendChild(pieceEl({ color, role }));
        b.addEventListener('click', () => {
          this.tool = sel ? null : { kind: 'piece', piece: { color, role } };
          this.render();
          this.deps.onChange();
        });
        row.appendChild(b);
      }
      body.appendChild(row);
    }
    const tools = document.createElement('div');
    tools.className = 'editor-tools';
    const erase = document.createElement('button');
    erase.type = 'button';
    erase.textContent = '消す';
    erase.classList.toggle('selected', this.tool?.kind === 'erase');
    erase.addEventListener('click', () => {
      this.tool = this.tool?.kind === 'erase' ? null : { kind: 'erase' };
      this.render();
      this.deps.onChange();
    });
    const holding = document.createElement('span');
    holding.className = 'editor-holding';
    holding.textContent = this.tool?.kind === 'piece'
      ? `手に持っている駒: ${this.tool.piece.color === 'sente' ? '☗' : '☖'}${ROLE_KANJI[this.tool.piece.role]}`
      : this.tool?.kind === 'erase' ? '消す: 押したマスの駒を取り除きます' : '';
    tools.append(erase, holding);
    body.appendChild(tools);

    const turnRow = document.createElement('div');
    turnRow.className = 'editor-turn';
    turnRow.innerHTML = `<span>手番</span>
      <label><input type="radio" name="edit-turn" value="sente" ${this.turn === 'sente' ? 'checked' : ''}/> ☗先手</label>
      <label><input type="radio" name="edit-turn" value="gote" ${this.turn === 'gote' ? 'checked' : ''}/> ☖後手</label>`;
    turnRow.addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value as Color;
      this.turn = v;
      this.deps.onChange();
    });
    body.appendChild(turnRow);

    const actions = document.createElement('div');
    actions.className = 'editor-actions';
    const mk = (label: string, cls: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      actions.appendChild(b);
      return b;
    };
    mk('平手の初期配置', '', () => this.loadSfen(HIRATE_SFEN));
    mk('盤を空にする', '', () => this.clear());
    mk('やめる', '', () => this.deps.onCancel());
    mk('この局面から本将棋を始める', 'primary', () => {
      const why = this.validate();
      if (why) {
        alert(why);
        return;
      }
      this.deps.onStart(this.toSfen());
    });
    body.appendChild(actions);
    root.appendChild(body);
  }
}
