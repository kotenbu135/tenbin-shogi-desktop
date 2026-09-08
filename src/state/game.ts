// 対局の状態。布石フェーズは wasm（Fuseki）、本将棋は shogiops が真実を持ち、
// このクラスは2つを繋いで「棋譜」「表示用の盤」「エンジンへ送る position 行」を作る。
//
// 天秤将棋の手順（docs/plan-desktop-gui.md、開発リポジトリ docs/rules.md）:
//   kings  1〜2手目: 玉を置く役が先手玉→後手玉の順に置く（wasm の手番はそのまま交互）
//   choose        : 選ぶ役が先手／後手を持つと宣言する。盤面も手番も変わらない
//   fuseki 3〜40手: 交互に置く
//   normal 41手〜 : 本将棋。41手目の裁定（後手玉が取れるなら先手の勝ち）を通した局面から

import { parseSfen } from 'shogiops/sfen';
import { makeSquareName, parseSquareName, parseUsi } from 'shogiops/util';
import { handRoles, pieceCanPromote, pieceForcePromote } from 'shogiops/variant/util';
import type { Shogi } from 'shogiops/variant/shogi';
import type { MoveOrDrop, Piece as OpsPiece, Role as OpsRole } from 'shogiops/types';
import { BLACK, WHITE, type Drop, type Fuseki, type Role as DropRole } from '../rules/fuseki.ts';

export type Color = 'sente' | 'gote';
export type Phase = 'kings' | 'choose' | 'fuseki' | 'normal' | 'over';
export type Mode = 'tenbin' | 'fuseki';

export interface Piece {
  color: Color;
  role: OpsRole;
}

export interface MoveRecord {
  /** 0 始まりの通し番号（choose も数える） */
  index: number;
  /** 盤の手数。choose は null */
  ply: number | null;
  color: Color | null;
  /** "P*7g" / "7g7f" / "choose:sente" / "resign" */
  usi: string;
  /** 表示用 "☗７六歩打" */
  text: string;
  phase: Phase;
}

export interface BoardSnapshot {
  pieces: Map<string, Piece>;
  hands: Record<Color, Map<OpsRole, number>>;
  turn: Color;
  lastSquare: string | null;
  /** 王手中の玉のマス（本将棋のみ） */
  checkSquare: string | null;
}

export interface GameOver {
  winner: Color | null;
  reason: string;
}

const RANK_KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const FILE_ZEN = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];
export const ROLE_KANJI: Record<string, string> = {
  pawn: '歩', lance: '香', knight: '桂', silver: '銀', gold: '金', bishop: '角', rook: '飛', king: '玉',
  tokin: 'と', promotedlance: '杏', promotedknight: '圭', promotedsilver: '全', horse: '馬', dragon: '龍',
};

export function squareText(sq: string): string {
  const f = Number(sq[0]);
  const r = sq.charCodeAt(1) - 'a'.charCodeAt(0);
  return `${FILE_ZEN[f - 1] ?? sq[0]}${RANK_KANJI[r] ?? sq[1]}`;
}

function colorMark(c: Color): string {
  return c === 'sente' ? '☗' : '☖';
}

export class Game {
  readonly moves: MoveRecord[] = [];
  private pos: Shogi | null = null;
  private sfen41: string | null = null;
  private normalMoves: string[] = [];
  private readonly fusekiBoard = new Map<string, Piece>();
  private lastSquare: string | null = null;
  private chosen: Color | null = null;
  over: GameOver | null = null;

  constructor(private readonly fuseki: Fuseki, readonly mode: Mode) {
    fuseki.reset();
  }

  get phase(): Phase {
    if (this.over) return 'over';
    if (this.pos) return 'normal';
    if (this.mode === 'tenbin') {
      if (this.fuseki.ply < 2) return 'kings';
      if (this.fuseki.ply === 2 && !this.chosen) return 'choose';
    }
    return 'fuseki';
  }

  /** 選ぶ役が宣言した色（天秤将棋）。未宣言なら null */
  get chosenColor(): Color | null {
    return this.chosen;
  }

  get turn(): Color {
    if (this.pos) return this.pos.turn;
    return this.fuseki.turn === BLACK ? 'sente' : 'gote';
  }

  /** 次に指す手が何手目か（1 始まり） */
  get nextPly(): number {
    if (this.pos) return 40 + this.normalMoves.length + 1;
    return this.fuseki.ply + 1;
  }

  /** 布石フェーズの合法な駒打ち。kings フェーズでは玉だけに絞る。 */
  legalDrops(): Drop[] {
    if (this.pos || this.over) return [];
    const all = this.fuseki.legalDrops();
    return this.phase === 'kings' ? all.filter((d) => d.role === 'king') : all;
  }

  dropSquares(role: OpsRole): Set<string> {
    const out = new Set<string>();
    if (this.pos) {
      if (this.over) return out;
      const piece: OpsPiece = { color: this.pos.turn, role };
      for (const sq of this.pos.dropDests(piece)) out.add(makeSquareName(sq));
      return out;
    }
    for (const d of this.legalDrops()) if (d.role === role) out.add(d.square);
    return out;
  }

  moveDests(from: string): Set<string> {
    const out = new Set<string>();
    if (!this.pos || this.over) return out;
    const sq = parseSquareName(from);
    if (sq === undefined) return out;
    for (const to of this.pos.moveDests(sq)) out.add(makeSquareName(to));
    return out;
  }

  /** 移動 from→to で成れるか／成らざるを得ないか（本将棋） */
  promotion(from: string, to: string): { can: boolean; forced: boolean } {
    if (!this.pos) return { can: false, forced: false };
    const f = parseSquareName(from);
    const t = parseSquareName(to);
    if (f === undefined || t === undefined) return { can: false, forced: false };
    const piece = this.pos.board.get(f);
    if (!piece) return { can: false, forced: false };
    const can = pieceCanPromote('standard')(piece, f, t, this.pos.board.get(t));
    const forced = can && pieceForcePromote('standard')(piece, t);
    return { can, forced };
  }

  /** 棋譜のトークンを1つ適用する。人間の入力・エンジンの手・棋譜の再生はすべてここを通る。 */
  apply(token: string): MoveRecord {
    if (this.over) throw new Error('対局は終わっている');
    if (token.startsWith('choose:')) return this.applyChoose(token);
    if (token === 'resign') return this.applyResign();
    if (this.pos) return this.applyNormal(token);
    return this.applyDrop(token);
  }

  private push(rec: Omit<MoveRecord, 'index'>): MoveRecord {
    const r: MoveRecord = { ...rec, index: this.moves.length };
    this.moves.push(r);
    return r;
  }

  private applyChoose(token: string): MoveRecord {
    if (this.phase !== 'choose') throw new Error('いまは先後を選ぶ場面ではない');
    const c = token.slice('choose:'.length);
    if (c !== 'sente' && c !== 'gote') throw new Error(`選択の書式が違う: ${token}`);
    this.chosen = c;
    return this.push({ ply: null, color: null, usi: token, text: c === 'sente' ? '先手を持つ' : '後手を持つ', phase: 'choose' });
  }

  private applyResign(): MoveRecord {
    const loser = this.turn;
    const phase = this.phase;
    this.over = { winner: loser === 'sente' ? 'gote' : 'sente', reason: `${loser === 'sente' ? '先手' : '後手'}の投了` };
    return this.push({ ply: this.nextPly, color: loser, usi: 'resign', text: `${colorMark(loser)}投了`, phase });
  }

  private applyDrop(token: string): MoveRecord {
    const phase = this.phase;
    if (phase === 'choose') throw new Error('先に先手か後手かを選ぶ');
    const color = this.turn;
    const ply = this.nextPly;
    const found = this.legalDrops().find((d) => d.usi === token);
    if (!found) throw new Error(`合法な駒打ちではない: ${token}`);
    this.fuseki.drop(found);
    this.fusekiBoard.set(found.square, { color, role: found.role });
    this.lastSquare = found.square;
    const rec = this.push({
      ply, color, usi: token, phase,
      text: `${colorMark(color)}${squareText(found.square)}${ROLE_KANJI[found.role]}打`,
    });
    if (this.fuseki.isPlacementDone) this.enterNormal();
    return rec;
  }

  private enterNormal(): void {
    const sfen = this.fuseki.toSfen();
    this.sfen41 = sfen;
    if (!this.fuseki.verifyFinalSfen(sfen)) {
      // 41手目の裁定: 手番（先手）が後手玉を取れる。エンジンには渡せない局面なのでここで終わる。
      this.over = { winner: 'sente', reason: '41手目の裁定（後手玉が先手の利きに当たっている）' };
      return;
    }
    const r = parseSfen('standard', sfen, false);
    if (r.isErr) throw new Error(`41手目の局面を読めない: ${r.error.message}`);
    this.pos = r.value;
  }

  private applyNormal(token: string): MoveRecord {
    const pos = this.pos!;
    const md: MoveOrDrop | undefined = parseUsi(token);
    if (!md || !pos.isLegal(md)) throw new Error(`合法手ではない: ${token}`);
    const color = pos.turn;
    const ply = this.nextPly;
    let text: string;
    if ('from' in md) {
      const piece = pos.board.get(md.from)!;
      const to = makeSquareName(md.to);
      text = `${colorMark(color)}${squareText(to)}${ROLE_KANJI[piece.role] ?? piece.role}${md.promotion ? '成' : ''}`;
      this.lastSquare = to;
    } else {
      const to = makeSquareName(md.to);
      text = `${colorMark(color)}${squareText(to)}${ROLE_KANJI[md.role] ?? md.role}打`;
      this.lastSquare = to;
    }
    pos.play(md);
    this.normalMoves.push(token);
    const rec = this.push({ ply, color, usi: token, text, phase: 'normal' });
    if (pos.isEnd()) {
      const o = pos.outcome();
      this.over = { winner: o?.winner ?? null, reason: o?.result === 'checkmate' ? '詰み' : (o?.result ?? '終局') };
    }
    return rec;
  }

  /** 最後の1手（または選択）を取り消す。wasm は巻き戻せないので最初から再生する。 */
  undoTokens(): string[] {
    return this.moves.slice(0, -1).map((m) => m.usi);
  }

  /** エンジンへ送る position 行。choose はエンジンに送らない（盤面も手番も変えないため）。 */
  positionCommand(): string {
    if (this.sfen41 && (this.pos || this.over)) {
      return `position sfen ${this.sfen41}` + (this.normalMoves.length ? ` moves ${this.normalMoves.join(' ')}` : '');
    }
    const drops = this.moves.filter((m) => m.ply !== null && m.usi !== 'resign').map((m) => m.usi);
    return 'position fuseki' + (drops.length ? ` moves ${drops.join(' ')}` : '');
  }

  snapshot(): BoardSnapshot {
    if (this.pos) {
      const pieces = new Map<string, Piece>();
      for (const [sq, p] of this.pos.board) pieces.set(makeSquareName(sq), { color: p.color, role: p.role });
      const hands: Record<Color, Map<OpsRole, number>> = { sente: new Map(), gote: new Map() };
      for (const c of ['sente', 'gote'] as const) {
        const h = this.pos.hands.color(c);
        for (const role of handRoles('standard')) {
          const n = h.get(role);
          if (n > 0) hands[c].set(role, n);
        }
      }
      let checkSquare: string | null = null;
      if (this.pos.isCheck()) {
        const k = this.pos.board.pieces(this.pos.turn, 'king').first();
        if (k !== undefined) checkSquare = makeSquareName(k);
      }
      return { pieces, hands, turn: this.pos.turn, lastSquare: this.lastSquare, checkSquare };
    }
    const hands: Record<Color, Map<OpsRole, number>> = {
      sente: this.fuseki.remaining(BLACK) as Map<OpsRole, number>,
      gote: this.fuseki.remaining(WHITE) as Map<OpsRole, number>,
    };
    return { pieces: new Map(this.fusekiBoard), hands, turn: this.turn, lastSquare: this.lastSquare, checkSquare: null };
  }
}

export type { DropRole };

/** トークン列から対局を作り直す（待った・棋譜の読み込み）。 */
export function rebuild(fuseki: Fuseki, mode: Mode, tokens: string[]): Game {
  const g = new Game(fuseki, mode);
  for (const t of tokens) g.apply(t);
  return g;
}
