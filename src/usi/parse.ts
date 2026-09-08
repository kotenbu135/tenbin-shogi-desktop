// USI の行を分解する。解釈はここに閉じ、他のモジュールは文字列を触らない。
// 将棋所・ShogiGUI・ShogiHome で `info` の語順や `score mate` の書き方に差があるので、
// 語の位置に依存しない読み方をする（sunfish-shogi の「USI の現状調査」に倣う）。

export interface UsiInfo {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  /** 手番側から見た評価値（centipawn） */
  scoreCp?: number;
  /** 詰みまでの手数。符号は手番側の勝ち／負け。手数不明の「+」「-」は ±0 の代わりに ±999 */
  scoreMate?: number;
  bound?: 'lower' | 'upper';
  nodes?: number;
  nps?: number;
  /** ミリ秒 */
  time?: number;
  hashfull?: number;
  currmove?: string;
  pv?: string[];
  /** `info string ...` の本文 */
  string?: string;
  /** 布石拡張。手番側の勝率 0..1 */
  winrate?: number;
}

const NUMERIC_KEYS = new Set([
  'depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time', 'hashfull', 'currmovenumber', 'cpuload',
]);

/** `info ...` を分解する。info 行でなければ null。 */
export function parseInfo(line: string): UsiInfo | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  const info: UsiInfo = {};
  let i = 1;
  while (i < t.length) {
    const key = t[i]!;
    if (key === 'string') {
      info.string = t.slice(i + 1).join(' ');
      break;
    }
    if (key === 'pv') {
      // pv は末尾が正式だが、末尾でない実装もある。次の既知キーまでを読み筋とする。
      const pv: string[] = [];
      i++;
      while (i < t.length && !isInfoKey(t[i]!)) pv.push(t[i++]!);
      info.pv = pv;
      continue;
    }
    if (key === 'score') {
      const kind = t[i + 1];
      const raw = t[i + 2] ?? '';
      i += 3;
      if (kind === 'cp') {
        info.scoreCp = Number(raw);
      } else if (kind === 'mate') {
        if (raw === '+') info.scoreMate = 999;
        else if (raw === '-') info.scoreMate = -999;
        else info.scoreMate = Number(raw);
      }
      if (t[i] === 'lowerbound') { info.bound = 'lower'; i++; }
      else if (t[i] === 'upperbound') { info.bound = 'upper'; i++; }
      continue;
    }
    if (key === 'winrate') {
      info.winrate = Number(t[i + 1]);
      i += 2;
      continue;
    }
    if (key === 'currmove') {
      info.currmove = t[i + 1];
      i += 2;
      continue;
    }
    if (NUMERIC_KEYS.has(key)) {
      const v = Number(t[i + 1]);
      if (key === 'depth') info.depth = v;
      else if (key === 'seldepth') info.seldepth = v;
      else if (key === 'multipv') info.multipv = v;
      else if (key === 'nodes') info.nodes = v;
      else if (key === 'nps') info.nps = v;
      else if (key === 'time') info.time = v;
      else if (key === 'hashfull') info.hashfull = v;
      i += 2;
      continue;
    }
    // 知らない語は読み飛ばす（値を伴うかは分からないので1語だけ進める）。
    i++;
  }
  return info;
}

function isInfoKey(s: string): boolean {
  return NUMERIC_KEYS.has(s) || s === 'score' || s === 'pv' || s === 'string' || s === 'currmove' || s === 'winrate';
}

export type UsiOptionType = 'check' | 'spin' | 'combo' | 'button' | 'string' | 'filename';

export interface UsiOption {
  name: string;
  type: UsiOptionType;
  default?: string;
  min?: number;
  max?: number;
  vars?: string[];
}

/** `option name X type T default D min M max N var A var B` を分解する。 */
export function parseOption(line: string): UsiOption | null {
  const s = line.trim();
  if (!s.startsWith('option ')) return null;
  const m = /^option\s+name\s+(.+?)\s+type\s+(\S+)(.*)$/.exec(s);
  if (!m) return null;
  const opt: UsiOption = { name: m[1]!, type: m[2] as UsiOptionType };
  const rest = m[3] ?? '';
  const dm = /\sdefault\s+(.*?)(?=\s(?:min|max|var)\s|$)/.exec(rest);
  if (dm) opt.default = dm[1]!.trim() === '<empty>' ? '' : dm[1]!.trim();
  const mn = /\smin\s+(-?\d+)/.exec(rest);
  if (mn) opt.min = Number(mn[1]);
  const mx = /\smax\s+(-?\d+)/.exec(rest);
  if (mx) opt.max = Number(mx[1]);
  const vars = [...rest.matchAll(/\svar\s+(\S+)/g)].map((v) => v[1]!);
  if (vars.length) opt.vars = vars;
  return opt;
}

export interface Bestmove {
  move: string;
  ponder?: string;
}

export function parseBestmove(line: string): Bestmove | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'bestmove' || !t[1]) return null;
  const b: Bestmove = { move: t[1] };
  const p = t.indexOf('ponder');
  if (p >= 0 && t[p + 1]) b.ponder = t[p + 1];
  return b;
}

/** `id name X` / `id author Y` */
export function parseId(line: string): { name?: string; author?: string } | null {
  const m = /^id\s+(name|author)\s+(.+)$/.exec(line.trim());
  if (!m) return null;
  return m[1] === 'name' ? { name: m[2] } : { author: m[2] };
}

/**
 * 評価値（手番側 cp）→ 手番側の勝率。
 * 既定の S=435, offset=+34cp は 41 手目局面 4,765 局の実測較正（開発リポジトリ yaneuraou_scorer.py）。
 * 2026-09-08 に iter1177 の 5,569 局の実際の勝敗で再確認した（logloss 0.4967。最良の S=460/+70cp と 0.0006 差）。
 * 採点器の既定 S=600/0 はいちばん悪い。data/cp_ply41.npz の win 列は σ(cp/600) であって勝敗ではないので、
 * それで較正すると必ず S=600 が出る。勝敗はアリーナ JSON の games[].result から取る。
 */
export function cpToWinrate(cp: number, scale = 435, offsetCp = 34): number {
  return 1 / (1 + Math.exp(-(cp - offsetCp) / scale));
}

/** 勝率 → 擬似 cp（cpToWinrate の逆） */
export function winrateToCp(p: number, scale = 435, offsetCp = 34): number {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  // `|| 0` は -0 を 0 に揃えるため（表示で "-0" が出る）
  return Math.round(scale * Math.log(q / (1 - q)) + offsetCp) || 0;
}
