// 対局の状態。布石フェーズは wasm（Fuseki）、本将棋は shogiops が真実を持ち、
// このクラスは2つを繋いで「棋譜」「表示用の盤」「エンジンへ送る position 行」を作る。
//
// 天秤将棋の手順（docs/plan-desktop-gui.md、開発リポジトリ docs/rules.md）:
//   kings  1〜2手目: 玉を置く役が先手玉→後手玉の順に置く（wasm の手番はそのまま交互）
//   choose        : 選ぶ役が先手／後手を持つと宣言する。盤面も手番も変わらない
//   fuseki 3〜40手: 交互に置く
//   normal 41手〜 : 本将棋。41手目の裁定（後手玉が取れるなら先手の勝ち）を通した局面から
//
// mode='position' は任意の局面（局面編集・KIF の局面図）から本将棋を始める。
//
// 符号は日本将棋連盟の表記に従う（shogiops の日本語表記を使う）。
//   同　銀 / ５八金左 / 打は盤上の駒が同じマスへ動けるときだけ。布石中は動ける駒が無いので打は付けない。

import { parseSfen } from 'shogiops/sfen';
import { makeSquareName, parseSquareName, parseUsi } from 'shogiops/util';
import { handRoles, pieceCanPromote, pieceForcePromote } from 'shogiops/variant/util';
import { makeJapaneseMoveOrDrop } from 'shogiops/notation/japanese';
import { makeWesternMoveOrDrop } from 'shogiops/notation/western';
import { lang, sideName, t } from '../i18n.ts';
import type { Shogi } from 'shogiops/variant/shogi';
import type { MoveOrDrop, Piece as OpsPiece, Role as OpsRole, Square } from 'shogiops/types';
import { BLACK, WHITE, type Drop, type Fuseki } from '../rules/fuseki.ts';
import type { MoveTime } from './clock.ts';

export type Color = 'sente' | 'gote';
export type Phase = 'kings' | 'choose' | 'fuseki' | 'normal' | 'over';
export type Mode = 'tenbin' | 'fuseki' | 'position';

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
  /** "P*7g" / "7g7f" / "choose:sente" / "resign" / "timeout" */
  usi: string;
  /** 符号 "７六歩"（先後の記号は付けない。表示側が ☗☖ を添える）。KIF と同じ日本語表記 */
  text: string;
  /** 英語表記の符号 "P-76"（shogiops の western）。画面が英語のときに出す */
  textEn: string;
  phase: Phase;
  time?: MoveTime;
}

export interface BoardSnapshot {
  pieces: Map<string, Piece>;
  hands: Record<Color, Map<OpsRole, number>>;
  turn: Color;
  /** 直前の手の行き先 */
  lastSquare: string | null;
  /** 直前の手の出発点（本将棋の移動のみ） */
  lastFrom: string | null;
  /** 王手中の玉のマス（本将棋のみ） */
  checkSquare: string | null;
}

/**
 * 終局の理由。文言ではなく形で持つ（言語を変えても出し直せるように）。
 * 'other' は shogiops が返した英語の結果（'stalemate' など）をそのまま包む。
 */
export type OverReason =
  | { kind: 'resign' | 'timeout'; loser: Color }
  | { kind: 'ruling41' }
  | { kind: 'mate' }
  | { kind: 'other'; result: string };

export interface GameOver {
  winner: Color | null;
  reason: OverReason;
}

/** 終局の理由を画面の言葉にする */
export function overReasonText(r: OverReason): string {
  switch (r.kind) {
    case 'resign':
      return t('over_resign', { side: sideName(r.loser) });
    case 'timeout':
      return t('over_timeout', { side: sideName(r.loser) });
    case 'ruling41':
      return t('over_ruling41');
    case 'mate':
      return t('over_mate');
    default:
      return r.result || t('over_other');
  }
}

/** 棋譜のある地点の局面。過去の局面を見る・検討するときに使う。 */
export interface ViewState {
  snapshot: BoardSnapshot;
  positionCmd: string;
  phase: Phase;
  turn: Color;
  /** その局面までに指された手数 */
  ply: number;
  over: GameOver | null;
}

/** 本将棋の手を、その直前の局面とともに順に辿る（KIF の書き出しなどに使う） */
export interface NormalStep {
  record: MoveRecord;
  pos: Shogi;
  md: MoveOrDrop;
  lastDest: Square | undefined;
}

const RANK_KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const FILE_ZEN = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];
export const ROLE_KANJI: Record<string, string> = {
  pawn: '歩', lance: '香', knight: '桂', silver: '銀', gold: '金', bishop: '角', rook: '飛', king: '玉',
  tokin: 'と', promotedlance: '成香', promotedknight: '成桂', promotedsilver: '成銀', horse: '馬', dragon: '龍',
};
/** 英語の駒名。成駒は「+銀」の形に倣って + を付ける（英語圏の棋譜で通る書き方） */
const ROLE_EN: Record<string, string> = {
  pawn: 'pawn', lance: 'lance', knight: 'knight', silver: 'silver', gold: 'gold', bishop: 'bishop', rook: 'rook', king: 'king',
  tokin: 'tokin', promotedlance: '+lance', promotedknight: '+knight', promotedsilver: '+silver', horse: 'horse', dragon: 'dragon',
};

/** 駒の呼び名。画面の言語で選ぶ */
export function roleName(role: string): string {
  return lang() === 'en' ? (ROLE_EN[role] ?? role) : (ROLE_KANJI[role] ?? role);
}

export const USI_OF_ROLE: Record<string, string> = {
  pawn: 'P', lance: 'L', knight: 'N', silver: 'S', gold: 'G', bishop: 'B', rook: 'R', king: 'K',
};
export const ROLE_OF_USI: Record<string, OpsRole> = {
  P: 'pawn', L: 'lance', N: 'knight', S: 'silver', G: 'gold', B: 'bishop', R: 'rook', K: 'king',
};

export const HIRATE_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

export function squareText(sq: string): string {
  const f = Number(sq[0]);
  const r = sq.charCodeAt(1) - 'a'.charCodeAt(0);
  return `${FILE_ZEN[f - 1] ?? sq[0]}${RANK_KANJI[r] ?? sq[1]}`;
}

/** マス "7g" を英語表記の "77" にする（shogiops の western と同じ数字2つ） */
export function squareNumber(sq: string): string {
  const r = sq.charCodeAt(1) - 'a'.charCodeAt(0) + 1;
  return `${sq[0]}${r}`;
}

/** マスの呼び方。画面の言語で「７六」と "76" を選ぶ */
export function squareLabel(sq: string): string {
  return lang() === 'en' ? squareNumber(sq) : squareText(sq);
}

/** 棋譜に出す符号。画面の言語で日本語表記と英語表記を選ぶ */
export function moveText(m: MoveRecord): string {
  return lang() === 'en' ? m.textEn : m.text;
}

export function colorMark(c: Color): string {
  return c === 'sente' ? '☗' : '☖';
}

export function colorName(c: Color): string {
  return c === 'sente' ? '先手' : '後手';
}

export class Game {
  readonly moves: MoveRecord[] = [];
  private pos: Shogi | null = null;
  /** 本将棋の開始局面（41手目、または任意局面）の SFEN */
  private startSfen: string | null = null;
  private normalMoves: string[] = [];
  private readonly fusekiBoard = new Map<string, Piece>();
  private lastSquare: string | null = null;
  private lastFrom: string | null = null;
  private chosen: Color | null = null;
  /** 本将棋の手数の土台。布石からなら 40、任意局面からなら 0 */
  private readonly basePly: number;
  over: GameOver | null = null;

  constructor(private readonly fuseki: Fuseki, readonly mode: Mode, startSfen?: string) {
    fuseki.reset();
    this.basePly = mode === 'position' ? 0 : 40;
    if (mode === 'position') {
      const sfen = startSfen ?? HIRATE_SFEN;
      const r = parseSfen('standard', sfen, false);
      if (r.isErr) throw new Error(t('err_read_position', { msg: r.error.message }));
      this.pos = r.value;
      this.startSfen = sfen;
    }
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

  /**
   * いま動いている側の色。天秤将棋で先後が決まる前は、両玉を置く側を先手の枠、先後を選ぶ側を
   * 後手の枠とみなす（時計・投了・時間切れの帰属に使う。盤の手番 `turn` は 2 手目で後手になる）
   */
  get actingColor(): Color {
    if (this.mode === 'tenbin' && !this.chosen && !this.pos) return this.phase === 'choose' ? 'gote' : 'sente';
    return this.turn;
  }

  /** 次に指す手が何手目か（1 始まり） */
  get nextPly(): number {
    if (this.pos) return this.basePly + this.normalMoves.length + 1;
    return this.fuseki.ply + 1;
  }

  /** 本将棋の開始局面の SFEN（まだ本将棋でなければ null） */
  get normalStartSfen(): string | null {
    return this.startSfen;
  }

  /** 本将棋の開始局面（shogiops）。KIF の局面図などに使う */
  startPosition(): Shogi | null {
    if (!this.startSfen) return null;
    const r = parseSfen('standard', this.startSfen, false);
    return r.isOk ? r.value : null;
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
  apply(token: string, time?: MoveTime, loser?: Color): MoveRecord {
    if (this.over) throw new Error(t('err_game_over'));
    let rec: MoveRecord;
    if (token.startsWith('choose:')) rec = this.applyChoose(token);
    else if (token === 'resign' || token === 'timeout') rec = this.applyEnd(token, loser);
    else if (this.pos) rec = this.applyNormal(token);
    else rec = this.applyDrop(token);
    if (time) rec.time = time;
    return rec;
  }

  private push(rec: Omit<MoveRecord, 'index'>): MoveRecord {
    const r: MoveRecord = { ...rec, index: this.moves.length };
    this.moves.push(r);
    return r;
  }

  private applyChoose(token: string): MoveRecord {
    if (this.phase !== 'choose') throw new Error(t('err_not_choose'));
    const c = token.slice('choose:'.length);
    if (c !== 'sente' && c !== 'gote') throw new Error(t('err_choose_format', { token }));
    this.chosen = c;
    return this.push({
      ply: null,
      color: null,
      usi: token,
      text: c === 'sente' ? '先手を持つ' : '後手を持つ',
      textEn: c === 'sente' ? 'Takes Sente' : 'Takes Gote',
      phase: 'choose',
    });
  }

  private applyEnd(token: 'resign' | 'timeout', given?: Color): MoveRecord {
    // 投了は押した席の色を受け取る。渡されなければ手番の側（先後が決まる前は
    // 置く側を先手の枠、選ぶ側を後手の枠として扱う。時計と同じ約束）
    const loser: Color = given ?? this.actingColor;
    const phase = this.phase;
    this.over = { winner: loser === 'sente' ? 'gote' : 'sente', reason: { kind: token, loser } };
    return this.push({
      ply: this.nextPly,
      color: loser,
      usi: token,
      text: token === 'resign' ? '投了' : '切れ負け',
      textEn: token === 'resign' ? 'Resigns' : 'Time forfeit',
      phase,
    });
  }

  private applyDrop(token: string): MoveRecord {
    const phase = this.phase;
    if (phase === 'choose') throw new Error(t('err_choose_first'));
    const color = this.turn;
    const ply = this.nextPly;
    const found = this.legalDrops().find((d) => d.usi === token);
    if (!found) throw new Error(t('err_illegal_drop', { token }));
    this.fuseki.drop(found);
    this.fusekiBoard.set(found.square, { color, role: found.role });
    this.lastSquare = found.square;
    this.lastFrom = null;
    // 布石中は盤上の駒が動けないので「打」は付けない（連盟の表記）
    const rec = this.push({
      ply,
      color,
      usi: token,
      phase,
      text: `${squareText(found.square)}${ROLE_KANJI[found.role]}`,
      textEn: `${USI_OF_ROLE[found.role] ?? found.role}*${squareNumber(found.square)}`,
    });
    if (this.fuseki.isPlacementDone) this.enterNormal();
    return rec;
  }

  private enterNormal(): void {
    const sfen = this.fuseki.toSfen();
    this.startSfen = sfen;
    if (!this.fuseki.verifyFinalSfen(sfen)) {
      // 41手目の裁定: 手番（先手）が後手玉を取れる。エンジンには渡せない局面なのでここで終わる。
      this.over = { winner: 'sente', reason: { kind: 'ruling41' } };
      return;
    }
    const r = parseSfen('standard', sfen, false);
    if (r.isErr) throw new Error(t('err_read_41', { msg: r.error.message }));
    this.pos = r.value;
  }

  /** その手を今の局面に指せるか（エンジンの返した手を当てる前の確認） */
  canApply(token: string): boolean {
    if (token === 'resign' || token === 'timeout' || token.startsWith('choose:')) return true;
    if (this.pos) {
      const md = parseUsi(token);
      return !!md && this.pos.isLegal(md);
    }
    if (this.over) return false;
    try {
      return this.legalDrops().some((d) => d.usi === token);
    } catch {
      return false;
    }
  }

  private applyNormal(token: string): MoveRecord {
    const pos = this.pos!;
    const md: MoveOrDrop | undefined = parseUsi(token);
    if (!md || !pos.isLegal(md)) throw new Error(t('err_illegal_move', { token }));
    const color = pos.turn;
    const ply = this.nextPly;
    const lastDest = this.lastSquare ? parseSquareName(this.lastSquare) : undefined;
    const text = makeJapaneseMoveOrDrop(pos, md, lastDest) ?? token;
    const textEn = makeWesternMoveOrDrop(pos, md) ?? token;
    this.lastFrom = 'from' in md ? makeSquareName(md.from) : null;
    this.lastSquare = makeSquareName(md.to);
    pos.play(md);
    this.normalMoves.push(token);
    const rec = this.push({ ply, color, usi: token, text, textEn, phase: 'normal' });
    if (pos.isEnd()) {
      const o = pos.outcome();
      this.over = { winner: o?.winner ?? null, reason: o?.result === 'checkmate' ? { kind: 'mate' } : { kind: 'other', result: o?.result ?? '' } };
    }
    return rec;
  }

  /** 読み筋（USI）を符号の列にする。本将棋は局面を進めながら、布石は駒打ちとして読む。画面の言語に合わせる。 */
  pvText(usis: string[]): string[] {
    const out: string[] = [];
    if (this.pos) {
      const p = this.pos.clone();
      let last: Square | undefined = this.lastSquare ? parseSquareName(this.lastSquare) : undefined;
      for (const u of usis) {
        const md = parseUsi(u);
        if (!md || !p.isLegal(md)) break;
        const one = lang() === 'en' ? makeWesternMoveOrDrop(p, md) : makeJapaneseMoveOrDrop(p, md, last);
        out.push(`${colorMark(p.turn)}${one ?? u}`);
        p.play(md);
        last = md.to;
      }
      return out;
    }
    // 共有の wasm は最新の対局へ戻されていることがある（過去の局面の読み筋）ので、手番は自分の記録から数える
    const played = this.moves.filter((m) => m.ply !== null && m.phase !== 'normal' && m.usi !== 'resign' && m.usi !== 'timeout').length;
    let turn: Color = played % 2 === 0 ? 'sente' : 'gote';
    for (const u of usis) {
      if (u.length < 4 || u[1] !== '*') break;
      const role = ROLE_OF_USI[u[0]!];
      if (!role) break;
      const sq = u.slice(2, 4);
      out.push(
        lang() === 'en'
          ? `${colorMark(turn)}${u[0]}*${squareNumber(sq)}`
          : `${colorMark(turn)}${squareText(sq)}${ROLE_KANJI[role]}`,
      );
      turn = turn === 'sente' ? 'gote' : 'sente';
    }
    return out;
  }

  tokens(): string[] {
    return this.moves.map((m) => m.usi);
  }

  times(): (MoveTime | undefined)[] {
    return this.moves.map((m) => m.time);
  }

  /**
   * 時計の枠ごとの消費時間（秒）。巻き戻したときに残り時間を組み直すために使う。
   * 先後が決まる前は 置く側＝先手の枠・選ぶ側＝後手の枠 で計っており、選ぶ側が
   * 先手を取ったらその枠ごと入れ替わる（Clock.swap と同じ約束）。
   */
  spentSec(): Record<Color, number> {
    const spent: Record<Color, number> = { sente: 0, gote: 0 };
    const placer: Color = this.chosen === 'sente' ? 'gote' : 'sente';
    const chooser: Color = placer === 'sente' ? 'gote' : 'sente';
    for (const m of this.moves) {
      const sec = m.time?.elapsed ?? 0;
      if (sec === 0) continue;
      if (m.phase === 'kings') spent[placer] += sec;
      else if (m.phase === 'choose') spent[chooser] += sec;
      else if (m.color) spent[m.color] += sec;
    }
    return spent;
  }

  /** 本将棋の手を、直前の局面つきで順に返す。 */
  *normalSteps(): Generator<NormalStep> {
    const start = this.startPosition();
    if (!start) return;
    const p = start.clone();
    let last: Square | undefined;
    for (const rec of this.moves) {
      if (rec.phase !== 'normal' || rec.usi === 'resign' || rec.usi === 'timeout') continue;
      const md = parseUsi(rec.usi);
      if (!md) break;
      yield { record: rec, pos: p.clone(), md, lastDest: last };
      p.play(md);
      last = md.to;
    }
  }

  /** エンジンへ送る position 行。choose はエンジンに送らない（盤面も手番も変えないため）。 */
  positionCommand(): string {
    if (this.startSfen && (this.pos || this.over)) {
      return `position sfen ${this.startSfen}` + (this.normalMoves.length ? ` moves ${this.normalMoves.join(' ')}` : '');
    }
    const drops = this.moves.filter((m) => m.ply !== null && m.phase !== 'normal' && m.usi !== 'resign' && m.usi !== 'timeout').map((m) => m.usi);
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
      return { pieces, hands, turn: this.pos.turn, lastSquare: this.lastSquare, lastFrom: this.lastFrom, checkSquare };
    }
    const hands: Record<Color, Map<OpsRole, number>> = {
      sente: this.fuseki.remaining(BLACK) as Map<OpsRole, number>,
      gote: this.fuseki.remaining(WHITE) as Map<OpsRole, number>,
    };
    return { pieces: new Map(this.fusekiBoard), hands, turn: this.turn, lastSquare: this.lastSquare, lastFrom: null, checkSquare: null };
  }

  view(): ViewState {
    return {
      snapshot: this.snapshot(),
      positionCmd: this.positionCommand(),
      phase: this.phase,
      turn: this.turn,
      ply: this.nextPly - 1,
      over: this.over,
    };
  }

  /**
   * 棋譜の index 手目まで進めた局面。wasm の実体は1つなので、一時的に作り直してから
   * 自分の局面へ戻す（40手の再生は数ミリ秒）。
   */
  viewAt(index: number): ViewState {
    const n = Math.max(0, Math.min(index, this.moves.length));
    if (n === this.moves.length) return this.view();
    const g = rebuild(this.fuseki, this.mode, this.tokens().slice(0, n), { startSfen: this.mode === 'position' ? this.startSfen ?? undefined : undefined });
    const v = g.view();
    this.resyncWasm();
    return v;
  }

  /** wasm の局面を自分の棋譜どおりに戻す。別の Game を作った（rebuild した）あとに呼ぶ */
  resync(): void {
    this.resyncWasm();
  }

  /** wasm の局面を自分の棋譜どおりに戻す（viewAt の後始末）。 */
  private resyncWasm(): void {
    this.fuseki.reset();
    if (this.mode === 'position') return;
    for (const m of this.moves) {
      if (m.phase === 'normal' || m.ply === null || m.usi === 'resign' || m.usi === 'timeout') continue;
      const d = this.fuseki.legalDrops().find((x) => x.usi === m.usi);
      if (!d) throw new Error(t('err_rewind', { usi: m.usi }));
      this.fuseki.drop(d);
    }
  }
}

export interface RebuildOptions {
  startSfen?: string;
  times?: (MoveTime | undefined)[];
}

/** トークン列から対局を作り直す（待った・棋譜の読み込み・過去の局面の表示）。 */
export function rebuild(fuseki: Fuseki, mode: Mode, tokens: string[], opts: RebuildOptions = {}): Game {
  const g = new Game(fuseki, mode, opts.startSfen);
  tokens.forEach((t, i) => g.apply(t, opts.times?.[i]));
  return g;
}
