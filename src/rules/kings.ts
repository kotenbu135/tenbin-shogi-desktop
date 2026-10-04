// 天秤将棋の 1〜2 手目（両玉）をエンジンに置かせるときの決めごと。公開サイト（tenbinshogi.com）の
// AI と、Libra 0.3 以降（`Fuseki_Mode` を名乗るエンジン。自分で読んで置く）と同じ形にする:
//   - 先手玉は合法なマスから一様に選ぶ。ただし六段目（自陣の 4 段目）は除く
//   - 後手玉は四段目（自陣の 4 段目）を除く候補ごとに両玉を置いた局面を読み、先手の勝率が 0.5 にいちばん近いマス
// 探索に玉の手そのものを選ばせないのは、2 手目で後手の得を最大にする（選ぶ側に都合のよい片寄った組を置く）ため。
// 後手玉の四段目は 3 手目の桂打ちで遮断できず先手の勝ちがほぼ決まる。先手玉の六段目は、どの後手玉でも先手の勝率が低く釣り合わない。
//
// 玉配置表（両玉の価値表・scale.json）は 0.11.0 で使うのをやめた。

/** 1 手目の先手玉（`K*5h`）。六段目を除く合法なマスから一様に選ぶ。無ければ null */
export function randomSenteKing(squares: Iterable<string>, random: () => number = Math.random): string | null {
  const cands = [...squares].filter((sq) => !sq.endsWith('f')).sort();
  if (cands.length === 0) return null;
  return `K*${cands[Math.min(cands.length - 1, Math.floor(random() * cands.length))]}`;
}

/** 2 手目に読む後手玉の候補（`K*5a` の形）。四段目を除く */
export function goteKingCandidates(squares: Iterable<string>): string[] {
  return [...squares].filter((sq) => !sq.endsWith('d')).sort().map((sq) => `K*${sq}`);
}

/** 候補ごとの先手の勝率から、0.5 にいちばん近い手。差が同じならマスの並びの前（公開サイト・Libra の match と同じ）。無ければ null */
export function nearestToEven(rates: ReadonlyMap<string, number>): string | null {
  let best: { usi: string; gap: number } | null = null;
  for (const [usi, rate] of rates) {
    const gap = Math.abs(rate - 0.5);
    if (!best || gap < best.gap || (gap === best.gap && usi < best.usi)) best = { usi, gap };
  }
  return best?.usi ?? null;
}

/** 先後の選択。両玉を置いた局面（先手の番）の先手の勝率が半分以上なら先手を持つ。読めなければ先手 */
export function chooseSide(senteWinRate: number | null): 'sente' | 'gote' {
  return senteWinRate !== null && senteWinRate < 0.5 ? 'gote' : 'sente';
}
