// 内蔵の布石評価。公開サイトの policy.js / value.js / kings.js を型を付けて移植したもの。
//
// 方策（候補の絞り込み）・価値ネット（候補の採点）・両玉の価値表（天秤将棋の 1〜2 手目）を
// onnxruntime-web（wasm、1 スレッド）で動かす。ルールと特徴量は cppshogi の wasm。
// 盤は自分専用の wasm インスタンスを持つので、対局中の盤（Game が持つもの）と干渉しない。
//
// 採点の決めごとは開発リポジトリの scripts/fuseki_usi_server.py と同じ:
//   - 候補は方策の上位 N 手（既定 16）に絞ってから採点する（合法手を全部採点すると、方策が選ばない
//     手の中から価値ネットの盲点を突く手が上に来る）
//   - 価値ネットの教師は t=2〜40。t=1 は教師に無いので 1 手目は応手まで進めた t=2 の盤で採点する
//   - 天秤将棋の 1〜2 手目は両玉の価値表を引く（実対局の勝率）
//   - 40 手目で後手玉が先手の利きに当たる形は勝率 0
import * as ort from 'onnxruntime-web/wasm';
import { t } from '../i18n.ts';
import { BLACK, FEATURE_PLANES, Fuseki, type Drop, type FusekiColor } from '../rules/fuseki.ts';
import type { EngineConfig, EngineState, LogDirection, Thinker } from '../usi/engine.ts';
import type { Bestmove, UsiInfo } from '../usi/parse.ts';
import type { EvalScale } from '../usi/evalscale.ts';

export type BuiltinMethod = 'value' | 'twoply';
const CANDIDATES = 16;
const TOTAL_PLIES = 40;
/** 内蔵の擬似 cp の目盛り（41 手目の較正と同じ） */
export const BUILTIN_EVAL: EvalScale = { scale: 435, offsetCp: 34 };

export interface ModelManifest {
  format: string;
  generation: string;
  policy: { file: string; sha256?: string };
  kings: { file: string; sha256?: string };
  value: { file: string; sha256?: string; net?: string };
}

interface KingPairTable {
  format: string;
  model: string;
  band: string[];
  pairs: Record<string, { v: number }>;
}

const POOL_SIZE = 48;

/** 天秤将棋の両玉の価値表（公開サイトの kings.js と同じ規則） */
export class KingTable {
  constructor(readonly data: KingPairTable, modelFile?: string) {
    if (data?.format !== 'king_pair_table/1') throw new Error(t('bi_table_format', { format: String(data?.format) }));
    if (!data.pairs || !Array.isArray(data.band)) throw new Error(t('bi_table_fields'));
    if (modelFile) {
      const gen = (s: string) => (String(s).match(/iter(\d+)/) ?? [])[1];
      if (gen(modelFile) !== gen(data.model)) throw new Error(t('bi_table_gen', { table: data.model, model: modelFile }));
    }
  }

  /** 先手玉 kb・後手玉 kw のときの先手勝率 */
  v(kb: string, kw: string): number | null {
    return this.data.pairs[`${kb},${kw}`]?.v ?? null;
  }

  balancedPool(): string[] {
    const dist = (k: string) => Math.abs(this.data.pairs[k]!.v - 0.5);
    const band = this.data.band.filter((k) => this.data.pairs[k]);
    return [...band].sort((a, b) => dist(a) - dist(b)).slice(0, Math.min(POOL_SIZE, band.length));
  }

  /** 置く役。釣り合う組から一様に 1 組。[先手玉, 後手玉] */
  placerPick(rng: () => number = Math.random): [string, string] {
    const pool = this.balancedPool();
    if (!pool.length) {
      let best: { key: string; v: number } | null = null;
      for (const [key, p] of Object.entries(this.data.pairs)) if (!best || Math.abs(p.v - 0.5) < Math.abs(best.v - 0.5)) best = { key, v: p.v };
      return best!.key.split(',') as [string, string];
    }
    return pool[Math.floor(rng() * pool.length)]!.split(',') as [string, string];
  }

  chooserPick(kb: string, kw: string): 'sente' | 'gote' {
    return (this.v(kb, kw) ?? 0.5) > 0.5 ? 'sente' : 'gote';
  }
}

export interface Candidate {
  usi: string;
  /** 手番側（置く側）の勝率 */
  p: number;
  prior: number;
}

export interface BuiltinResult {
  method: 'kingtable' | 'value' | 'twoply';
  candidates: Candidate[];
  ply: number;
}

/**
 * 内蔵の布石評価。`position fuseki moves …` の局面を受け、候補ごとの勝率を返す。
 * Thinker として検討パネルと対局に載る。
 */
export class BuiltinEvaluator implements Thinker {
  readonly config: EngineConfig;
  state: EngineState = 'stopped';
  idName = t('bi_name');
  onLog: ((dir: LogDirection, text: string) => void) | null = null;
  onStateChange: ((s: EngineState) => void) | null = null;
  method: BuiltinMethod = 'value';
  private generation = 0;

  private constructor(
    readonly fuseki: Fuseki,
    private readonly policy: ort.InferenceSession,
    private readonly value: ort.InferenceSession,
    readonly kings: KingTable | null,
    readonly manifest: ModelManifest,
    /** 盤も模型も 1 つしか無いので、重い計算はここに並べて順に走らせる（手の間で共有する） */
    private readonly shared: { chain: Promise<unknown> } = { chain: Promise.resolve() },
  ) {
    this.config = { id: 'builtin', name: t('bi_name'), path: '', kind: 'fuseki', options: {}, eval: { ...BUILTIN_EVAL } };
  }

  /**
   * @param modelsUrl `/models/` のような、manifest と重みの置き場所
   * @param wasmUrl cppshogi の wasm（`/wasm/fuseki.mjs`）
   * @param ortDir onnxruntime-web の wasm の置き場所（`/vendor/ort/`）
   */
  static async load(modelsUrl: string, wasmUrl: string, ortDir: string): Promise<BuiltinEvaluator> {
    const base = modelsUrl.endsWith('/') ? modelsUrl : modelsUrl + '/';
    const res = await fetch(base + 'models.json');
    if (!res.ok) throw new Error(t('bi_models_unreadable', { status: res.status, url: `${base}models.json` }));
    const manifest = (await res.json()) as ModelManifest;
    if (manifest.format !== 'tenbin-models/1') throw new Error(t('bi_models_format', { format: manifest.format }));
    ort.env.wasm.wasmPaths = { wasm: ortDir + 'ort-wasm-simd-threaded.wasm', mjs: ortDir + 'ort-wasm-simd-threaded.mjs' };
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const fuseki = await Fuseki.load(wasmUrl);
    const [policy, value] = await Promise.all([
      ort.InferenceSession.create(base + manifest.policy.file, { executionProviders: ['wasm'] }),
      ort.InferenceSession.create(base + manifest.value.file, { executionProviders: ['wasm'] }),
    ]);
    for (const [s, what] of [[policy, t('bi_policy')], [value, t('bi_value')]] as const) {
      for (const name of ['input1', 'input2']) if (!s.inputNames.includes(name)) throw new Error(t('bi_missing_input', { what, name }));
    }
    if (!policy.outputNames.includes('output_policy')) throw new Error(t('bi_missing_policy_out'));
    if (!value.outputNames.includes('output_value')) throw new Error(t('bi_missing_value_out'));
    let kings: KingTable | null = null;
    try {
      const kr = await fetch(base + manifest.kings.file);
      if (kr.ok) kings = new KingTable((await kr.json()) as KingPairTable, manifest.policy.file);
    } catch (e) {
      console.warn(t('bi_table_unreadable'), e);
    }
    return new BuiltinEvaluator(fuseki, policy, value, kings, manifest);
  }

  /**
   * 同じ模型を使う別の手。検討の欄ごと・棋譜解析ごとに分けて持つと、世代の数え札と
   * ルール（Fuseki_Mode）が混ざらず、片方の探索がもう片方を黙って打ち消さない。
   */
  view(): BuiltinEvaluator {
    const v = new BuiltinEvaluator(this.fuseki, this.policy, this.value, this.kings, this.manifest, this.shared);
    v.method = this.method;
    return v;
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.onStateChange?.(s);
  }

  async start(): Promise<void> {
    if (this.state === 'stopped') this.setState('ready');
  }

  async quit(): Promise<void> {
    this.generation++;
    this.setState('stopped');
  }

  send(line: string): void {
    this.onLog?.('sys', t('bi_no_usi', { line }));
  }

  async newGame(): Promise<void> {
    await this.stop();
  }

  /** ルール。天秤将棋なら 1〜2 手目を両玉の置き場として扱う。position 行からは区別できないので受け取る */
  private fusekiMode: 'tenbin' | 'fuseki' | null = null;

  setOption(name: string, value: string | number): void {
    if (name === 'Fuseki_Mode') this.fusekiMode = value === 'tenbin' ? 'tenbin' : 'fuseki';
  }

  hasOption(name: string): boolean {
    return name === 'Fuseki_Mode';
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.state === 'thinking') this.setState('ready');
  }

  /** `position fuseki moves …` → 駒打ちの列（choose: は読み飛ばす）。本将棋の局面なら null */
  static tokensOf(positionCmd: string): string[] | null {
    const t = positionCmd.trim().split(/\s+/);
    if (t[0] !== 'position' || t[1] !== 'fuseki') return null;
    const i = t.indexOf('moves');
    return i < 0 ? [] : t.slice(i + 1).filter((x) => !x.startsWith('choose:'));
  }

  async goInfinite(positionCmd: string, onInfo: (info: UsiInfo) => void): Promise<void> {
    if (this.state === 'stopped') throw new Error(t('bi_not_ready'));
    const tokens = BuiltinEvaluator.tokensOf(positionCmd);
    if (!tokens) throw new Error(t('bi_fuseki_only'));
    await this.stop();
    const gen = ++this.generation;
    this.setState('thinking');
    const t0 = performance.now();
    try {
      // ルールが渡されていないときだけ、手数から推し量る（布石将棋の 1〜2 手目を玉置きと誤るので、渡すのが本筋）
      const tenbin = this.fusekiMode ? this.fusekiMode === 'tenbin' : /choose:/.test(positionCmd) || tokens.length < 2;
      const r = await this.evaluate(tokens, this.method, { tenbin });
      if (gen !== this.generation) return;
      const ms = Math.round(performance.now() - t0);
      // 後ろから流す。1 位の info が来た時点で全候補が揃っているので、受け手が 1 位だけを合図にしても取りこぼさない
      [...r.candidates.keys()].reverse().forEach((i) => {
        const c = r.candidates[i]!;
        onInfo({
          depth: r.method === 'twoply' ? 2 : 1,
          multipv: i + 1,
          // cp は出さない。この評価は勝率そのもので、cp は受け手が目盛りで換算した目安として扱う
          winrate: c.p,
          nodes: r.candidates.length,
          time: ms,
          pv: [c.usi],
          string: `method ${r.method} prior ${c.prior.toFixed(3)}`,
        } as UsiInfo);
      });
    } finally {
      if (gen === this.generation && this.state === 'thinking') this.setState('ready');
    }
  }

  async go(positionCmd: string, _goArgs: string, onInfo?: (info: UsiInfo) => void): Promise<Bestmove> {
    const tokens = BuiltinEvaluator.tokensOf(positionCmd);
    if (!tokens) throw new Error(t('bi_fuseki_only'));
    let best: string | null = null;
    await this.goInfinite(positionCmd, (info) => {
      if (info.multipv === 1 && info.pv?.[0]) best = info.pv[0];
      onInfo?.(info);
    });
    if (!best) return { move: 'resign' };
    return { move: best };
  }

  // ---- 盤の準備 ----
  private setPosition(tokens: string[]): void {
    this.fuseki.reset();
    for (const tok of tokens) this.fuseki.drop(tok);
  }

  private async runPolicy(inputs: { input1: Float32Array; input2: Float32Array }[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const n = inputs.length;
    const a = new Float32Array(n * FEATURE_PLANES.input1 * 81);
    const b = new Float32Array(n * FEATURE_PLANES.input2 * 81);
    inputs.forEach((x, i) => {
      a.set(x.input1, i * FEATURE_PLANES.input1 * 81);
      b.set(x.input2, i * FEATURE_PLANES.input2 * 81);
    });
    const out = await this.policy.run({
      input1: new ort.Tensor('float32', a, [n, FEATURE_PLANES.input1, 9, 9]),
      input2: new ort.Tensor('float32', b, [n, FEATURE_PLANES.input2, 9, 9]),
    });
    const y = out.output_policy!.data as Float32Array;
    const dim = out.output_policy!.dims[1]!;
    return Array.from({ length: n }, (_, i) => y.subarray(i * dim, (i + 1) * dim));
  }

  /** 手番側の勝率（価値ネットは手番側視点で学習してある） */
  private async runValue(inputs: { input1: Float32Array; input2: Float32Array }[]): Promise<Float32Array> {
    if (inputs.length === 0) return new Float32Array(0);
    const out = new Float32Array(inputs.length);
    const BATCH = 64;
    for (let s = 0; s < inputs.length; s += BATCH) {
      const chunk = inputs.slice(s, s + BATCH);
      const n = chunk.length;
      const a = new Float32Array(n * FEATURE_PLANES.input1 * 81);
      const b = new Float32Array(n * FEATURE_PLANES.input2 * 81);
      chunk.forEach((x, i) => {
        a.set(x.input1, i * FEATURE_PLANES.input1 * 81);
        b.set(x.input2, i * FEATURE_PLANES.input2 * 81);
      });
      const r = await this.value.run({
        input1: new ort.Tensor('float32', a, [n, FEATURE_PLANES.input1, 9, 9]),
        input2: new ort.Tensor('float32', b, [n, FEATURE_PLANES.input2, 9, 9]),
      });
      const y = r.output_value!.data as Float32Array;
      for (let i = 0; i < n; i++) out[s + i] = 1 / (1 + Math.exp(-y[i]!));
    }
    return out;
  }

  private priors(logits: Float32Array, legal: Drop[], color: FusekiColor): Float64Array {
    const z = new Float64Array(legal.length);
    let max = -Infinity;
    for (let i = 0; i < legal.length; i++) {
      z[i] = logits[this.fuseki.compactLabel(legal[i]!.pt, legal[i]!.sq, color)]!;
      if (z[i]! > max) max = z[i]!;
    }
    let sum = 0;
    for (let i = 0; i < z.length; i++) {
      z[i] = Math.exp(z[i]! - max);
      sum += z[i]!;
    }
    for (let i = 0; i < z.length; i++) z[i] = z[i]! / sum;
    return z;
  }

  /** 候補の勝率。呼び出しは直列にする（盤が 1 つしか無い） */
  evaluate(tokens: string[], method: BuiltinMethod, opts: { tenbin: boolean }): Promise<BuiltinResult> {
    const run = () => this.evaluateNow(tokens, method, opts);
    const next = this.shared.chain.then(run, run);
    this.shared.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async evaluateNow(tokens: string[], method: BuiltinMethod, opts: { tenbin: boolean }): Promise<BuiltinResult> {
    this.setPosition(tokens);
    const ply = this.fuseki.ply;
    const color = this.fuseki.turn;
    let legal = this.fuseki.legalDrops();
    const kingsPhase = opts.tenbin && ply < 2;
    if (kingsPhase) legal = legal.filter((d) => d.role === 'king');
    if (legal.length === 0) return { method: 'value', candidates: [], ply };

    // 両玉の価値表（天秤将棋の 1〜2 手目）
    if (kingsPhase && this.kings) {
      const cands: Candidate[] = [];
      if (ply === 1) {
        const kb = tokens[0]!.slice(2);
        for (const d of legal) {
          const v = this.kings.v(kb, d.square);
          if (v === null) break;
          cands.push({ usi: d.usi, p: 1 - v, prior: 0 });
        }
      } else {
        const worst = new Map<string, number>();
        for (const [key, ent] of Object.entries(this.kings.data.pairs)) {
          const kb = key.split(',')[0]!;
          worst.set(kb, Math.min(worst.get(kb) ?? 1, ent.v));
        }
        for (const d of legal) {
          const w = worst.get(d.square);
          if (w === undefined) break;
          cands.push({ usi: d.usi, p: w, prior: 0 });
        }
      }
      if (cands.length === legal.length) {
        cands.sort((a, b) => b.p - a.p);
        return { method: 'kingtable', candidates: cands, ply };
      }
    }

    // 方策で候補を絞る
    const [logits] = await this.runPolicy([this.fuseki.policyInputs()]);
    const prior = this.priors(logits!, legal, color);
    let order = [...legal.keys()].sort((a, b) => prior[b]! - prior[a]!);
    if (!kingsPhase && order.length > CANDIDATES) order = order.slice(0, CANDIDATES);
    const cands = order.map((i) => legal[i]!);
    const candPrior = order.map((i) => prior[i]!);

    // 置いた直後の盤を採点（相手番なので 1 − v）
    const feats: { input1: Float32Array; input2: Float32Array }[] = [];
    const lost: boolean[] = [];
    const done: boolean[] = [];
    for (const c of cands) {
      this.setPosition(tokens);
      this.fuseki.drop(c);
      const isDone = this.fuseki.isPlacementDone;
      done.push(isDone);
      lost.push(isDone && !this.fuseki.verifyFinalSfen(this.fuseki.toSfen()));
      feats.push(this.fuseki.policyInputs());
    }
    const vOpp = await this.runValue(feats);
    const scores = cands.map((_, i) => (lost[i] ? 0 : 1 - vOpp[i]!));

    // 1 手目は t=1 の盤が教師に無いので、応手まで進めた t=2 で採点する
    const useTwoply = (method === 'twoply' || ply === 0) && ply < TOTAL_PLIES - 1;
    let used: BuiltinResult['method'] = 'value';
    if (useTwoply) {
      used = 'twoply';
      const replyFeats: { input1: Float32Array; input2: Float32Array }[] = [];
      const owner: number[] = [];
      const fixed = new Map<number, number>();
      // 応手の絞り込み用に、候補を置いた盤の方策をまとめて引く
      const candBoards: { input1: Float32Array; input2: Float32Array }[] = [];
      const candLegal: Drop[][] = [];
      const candColor: FusekiColor[] = [];
      for (let i = 0; i < cands.length; i++) {
        this.setPosition(tokens);
        this.fuseki.drop(cands[i]!);
        let replies = this.fuseki.legalDrops();
        if (opts.tenbin && ply + 1 < 2) replies = replies.filter((d) => d.role === 'king');
        candLegal.push(replies);
        candColor.push(this.fuseki.turn);
        candBoards.push(this.fuseki.policyInputs());
      }
      const candLogits = await this.runPolicy(candBoards.filter((_, i) => !lost[i] && !done[i]));
      let k = 0;
      for (let i = 0; i < cands.length; i++) {
        if (lost[i] || done[i]) continue;
        const replies = candLegal[i]!;
        const rp = this.priors(candLogits[k++]!, replies, candColor[i]!);
        const top = [...replies.keys()].sort((a, b) => rp[b]! - rp[a]!).slice(0, CANDIDATES);
        for (const j of top) {
          this.setPosition(tokens);
          this.fuseki.drop(cands[i]!);
          this.fuseki.drop(replies[j]!);
          if (this.fuseki.isPlacementDone && !this.fuseki.verifyFinalSfen(this.fuseki.toSfen())) {
            // 相手の最終手で相手玉が取れる形: 相手の負け
            fixed.set(replyFeats.length, 1);
            replyFeats.push({ input1: new Float32Array(0), input2: new Float32Array(0) });
          } else {
            replyFeats.push(this.fuseki.policyInputs());
          }
          owner.push(i);
        }
      }
      const real = replyFeats.map((f, idx) => ({ f, idx })).filter((x) => !fixed.has(x.idx));
      const vMe = await this.runValue(real.map((x) => x.f));
      const all = new Float64Array(replyFeats.length);
      real.forEach((x, i) => (all[x.idx] = vMe[i]!));
      for (const [idx, v] of fixed) all[idx] = v;
      const worst = new Map<number, number>();
      owner.forEach((i, idx) => worst.set(i, Math.min(worst.get(i) ?? 1, all[idx]!)));
      for (const [i, w] of worst) scores[i] = w;
    }
    this.fuseki.reset();
    const result = cands.map((c, i) => ({ usi: c.usi, p: scores[i]!, prior: candPrior[i]! }));
    result.sort((a, b) => b.p - a.p || b.prior - a.prior);
    return { method: used, candidates: result, ply };
  }

  /**
   * 対局の 1 手。方策の温度でサンプリングし、search を付けると K 本引いて価値ネットで最善を選ぶ
   * （公開サイトのレベルと同じ流儀。温度 1.0 → 0.4 で強くなる）。
   */
  async pickMove(tokens: string[], opts: { temperature: number; search: number; tenbin: boolean; rng?: () => number }): Promise<string> {
    const rng = opts.rng ?? Math.random;
    const run = async (): Promise<string> => {
      this.setPosition(tokens);
      const ply = this.fuseki.ply;
      const color = this.fuseki.turn;
      let legal = this.fuseki.legalDrops();
      if (opts.tenbin && ply < 2) {
        legal = legal.filter((d) => d.role === 'king');
        if (this.kings) {
          if (ply === 0) return `K*${this.kings.placerPick(rng)[0]}`;
          const kb = tokens[0]!.slice(2);
          const pool = this.kings.balancedPool().filter((k) => k.startsWith(kb + ','));
          if (pool.length) return `K*${pool[Math.floor(rng() * pool.length)]!.split(',')[1]}`;
          // 先手玉が帯に無ければ、その先手玉に対して最も釣り合う後手玉
          let best: { sq: string; d: number } | null = null;
          for (const d of legal) {
            const v = this.kings.v(kb, d.square);
            if (v === null) continue;
            const dist = Math.abs(v - 0.5);
            if (!best || dist < best.d) best = { sq: d.square, d: dist };
          }
          if (best) return `K*${best.sq}`;
        }
      }
      if (legal.length === 0) throw new Error(t('bi_no_legal'));
      const [logits] = await this.runPolicy([this.fuseki.policyInputs()]);
      const raw = legal.map((d) => logits![this.fuseki.compactLabel(d.pt, d.sq, color)]!);
      const max = Math.max(...raw);
      const w = raw.map((x) => Math.exp((x - max) / opts.temperature));
      const total = w.reduce((a, b) => a + b, 0);
      const sample = (): number => {
        let r = rng() * total;
        for (let i = 0; i < w.length; i++) {
          r -= w[i]!;
          if (r <= 0) return i;
        }
        return w.length - 1;
      };
      const K = Math.max(1, opts.search);
      if (K === 1) return legal[sample()]!.usi;
      const picks = [...new Set(Array.from({ length: K }, sample))];
      const feats: { input1: Float32Array; input2: Float32Array }[] = [];
      const lost: boolean[] = [];
      for (const i of picks) {
        this.setPosition(tokens);
        this.fuseki.drop(legal[i]!);
        lost.push(this.fuseki.isPlacementDone && !this.fuseki.verifyFinalSfen(this.fuseki.toSfen()));
        feats.push(this.fuseki.policyInputs());
      }
      const vOpp = await this.runValue(feats);
      let bi = 0;
      let bs = -1;
      picks.forEach((i, k) => {
        const s = lost[k] ? 0 : 1 - vOpp[k]!;
        if (s > bs) {
          bs = s;
          bi = i;
        }
      });
      return legal[bi]!.usi;
    };
    const next = this.shared.chain.then(run, run);
    this.shared.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 天秤将棋の選ぶ役 */
  choose(kb: string, kw: string): 'sente' | 'gote' {
    return this.kings ? this.kings.chooserPick(kb, kw) : 'sente';
  }
}

export { BLACK };
