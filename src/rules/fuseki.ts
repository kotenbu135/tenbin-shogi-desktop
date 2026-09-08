// 布石フェーズの局面。ルール（合法手・二歩回避の禁じ手・利きの判定・特徴量抽出）は
// すべて public/wasm/ の C++ 実装（開発リポジトリ engine/dlshogi/cppshogi）に委ね、
// このファイルは呼び出し規約だけを持つ。
//
// TS 側でルールを書き直さないのは、禁じ手や利きの判定が C++ 版と静かにズレると
// 「動くが弱い／間違う」という気付きにくい壊れ方をするため。局面の実体は wasm 側に1つだけある。

export const BLACK = 0 as const; // 先手（cppshogi の Color）
export const WHITE = 1 as const; // 後手
export type FusekiColor = typeof BLACK | typeof WHITE;

export type Role = 'pawn' | 'lance' | 'knight' | 'silver' | 'bishop' | 'rook' | 'gold' | 'king';

// cppshogi の PieceType。布石で打てるのはこの8種。USI 文字との対応は load 時に照合する。
const PIECE_TYPES: ReadonlyArray<{ pt: number; usi: string; role: Role }> = [
  { pt: 1, usi: 'P', role: 'pawn' },
  { pt: 2, usi: 'L', role: 'lance' },
  { pt: 3, usi: 'N', role: 'knight' },
  { pt: 4, usi: 'S', role: 'silver' },
  { pt: 5, usi: 'B', role: 'bishop' },
  { pt: 6, usi: 'R', role: 'rook' },
  { pt: 7, usi: 'G', role: 'gold' },
  { pt: 8, usi: 'K', role: 'king' },
];
const ROLE_OF_PT = new Map(PIECE_TYPES.map((p) => [p.pt, p.role]));
export const USI_OF_ROLE = new Map(PIECE_TYPES.map((p) => [p.role, p.usi]));
export const ROLE_OF_USI = new Map(PIECE_TYPES.map((p) => [p.usi, p.role]));

export interface Drop {
  pt: number;
  sq: number;
  role: Role;
  /** "P*7g" 形式 */
  usi: string;
  /** "7g" */
  square: string;
}

export const FEATURE_PLANES = { input1: 62, input2: 59, squares: 81 } as const;

// Emscripten モジュールのうち使う部分だけ。
interface EmModule {
  ccall(name: string, ret: 'number', argTypes: string[], args: unknown[]): number;
  ccall(name: string, ret: 'string', argTypes: string[], args: unknown[]): string;
  ccall(name: string, ret: null, argTypes: string[], args: unknown[]): void;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
}

export class Fuseki {
  private constructor(private readonly M: EmModule) {
    this.reset();
  }

  /**
   * @param moduleUrl public/wasm/fuseki.mjs の URL。バンドルに巻き込むと .wasm の解決先が
   *   壊れるため、動的 import で読む（vite には無視させる）。
   */
  static async load(moduleUrl: string): Promise<Fuseki> {
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as { default: (arg?: object) => Promise<EmModule> };
    const M = await mod.default({});
    M.ccall('fw_init', null, [], []);
    const f1 = M.ccall('fw_features1_len', 'number', [], []);
    const f2 = M.ccall('fw_features2_len', 'number', [], []);
    const want1 = FEATURE_PLANES.input1 * FEATURE_PLANES.squares;
    const want2 = FEATURE_PLANES.input2 * FEATURE_PLANES.squares;
    if (f1 !== want1 || f2 !== want2) {
      throw new Error(`特徴量の形が合わない: features1=${f1}(期待${want1}) features2=${f2}(期待${want2})`);
    }
    for (const { pt, usi } of PIECE_TYPES) {
      const got = M.ccall('fw_move_to_usi', 'string', ['number', 'number'], [pt, 0]);
      if (got[0] !== usi) throw new Error(`PieceType の対応がズレている: pt=${pt} は '${got[0]}'`);
    }
    return new Fuseki(M);
  }

  reset(): void {
    this.M.ccall('fw_reset', null, [], []);
  }

  get ply(): number {
    return this.M.ccall('fw_ply', 'number', [], []);
  }

  get turn(): FusekiColor {
    return this.M.ccall('fw_turn', 'number', [], []) === 0 ? BLACK : WHITE;
  }

  get isPlacementDone(): boolean {
    return this.M.ccall('fw_is_placement_done', 'number', [], []) === 1;
  }

  /** 色 c の玉が相手の利きに当たっているか。41手目の裁定に使う。 */
  isKingAttacked(color: FusekiColor): boolean {
    return this.M.ccall('fw_is_king_attacked', 'number', ['number'], [color]) === 1;
  }

  /** 手番側の合法な駒打ち。 */
  legalDrops(): Drop[] {
    const M = this.M;
    const n = M.ccall('fw_legal_drops', 'number', [], []);
    const ptPtr = M.ccall('fw_drops_pt_ptr', 'number', [], []);
    const sqPtr = M.ccall('fw_drops_sq_ptr', 'number', [], []);
    // ALLOW_MEMORY_GROWTH で HEAP のビューは差し替わりうるので、都度取り直す。
    const pts = M.HEAP32.subarray(ptPtr >> 2, (ptPtr >> 2) + n);
    const sqs = M.HEAP32.subarray(sqPtr >> 2, (sqPtr >> 2) + n);
    const out: Drop[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const pt = pts[i]!;
      const sq = sqs[i]!;
      const usi = M.ccall('fw_move_to_usi', 'string', ['number', 'number'], [pt, sq]) as string;
      out[i] = { pt, sq, role: ROLE_OF_PT.get(pt)!, usi, square: usi.slice(2) };
    }
    return out;
  }

  /** 駒を打つ。USI 文字列は合法手の一覧と照合してから打つ（人間の入力はここを通す）。 */
  drop(move: string | Drop): Drop {
    const found: Drop = typeof move === 'string' ? this.findDrop(move) : move;
    this.M.ccall('fw_do_drop', null, ['number', 'number'], [found.pt, found.sq]);
    return found;
  }

  private findDrop(usi: string): Drop {
    for (const d of this.legalDrops()) if (d.usi === usi) return d;
    throw new Error(`布石フェーズの合法手ではない: ${usi}`);
  }

  /** 色 c の持ち駒の残数。 */
  remaining(color: FusekiColor): Map<Role, number> {
    const hand = new Map<Role, number>();
    for (const { pt, role } of PIECE_TYPES) {
      const n = this.M.ccall('fw_remaining', 'number', ['number', 'number'], [color, pt]);
      if (n > 0) hand.set(role, n);
    }
    return hand;
  }

  /** 40手完了後の SFEN。通常フェーズへそのまま渡せる。 */
  toSfen(): string {
    return this.M.ccall('fw_to_sfen', 'string', [], []) as string;
  }

  /** 「手番側が相手玉を取れる」局面を弾く検査。通常フェーズへ渡す前の最後の門。 */
  verifyFinalSfen(sfen: string): boolean {
    return this.M.ccall('fw_verify_final_sfen', 'number', ['string'], [sfen]) === 1;
  }

  /** 方策・価値ネットの入力（input1 62面 + input2 59面）。HEAP のビューではなくコピーを返す。 */
  policyInputs(): { input1: Float32Array; input2: Float32Array } {
    const M = this.M;
    M.ccall('fw_make_features', null, [], []);
    const p1 = M.ccall('fw_features1_ptr', 'number', [], []) >> 2;
    const p2 = M.ccall('fw_features2_ptr', 'number', [], []) >> 2;
    return {
      input1: M.HEAPF32.slice(p1, p1 + FEATURE_PLANES.input1 * FEATURE_PLANES.squares),
      input2: M.HEAPF32.slice(p2, p2 + FEATURE_PLANES.input2 * FEATURE_PLANES.squares),
    };
  }

  /** 駒打ち (pt, sq) が布石専用ネットの 648 次元のどこに載るか。 */
  compactLabel(pt: number, sq: number, color: FusekiColor): number {
    return this.M.ccall('fw_compact_label', 'number', ['number', 'number', 'number'], [pt, sq, color]);
  }

  /** USI の駒打ち（例 K*5i）を (pt, sq) に。読めなければ null */
  parseUsi(usi: string): { pt: number; sq: number } | null {
    for (const d of this.legalDrops()) if (d.usi === usi) return { pt: d.pt, sq: d.sq };
    return null;
  }
}
