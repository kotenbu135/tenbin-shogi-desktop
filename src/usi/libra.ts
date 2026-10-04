// 天秤将棋の AI「Libra」（https://github.com/kotenbu135/LibraShogi）の版の見分け。
//
// 自動で入れる Libra は GitHub の最新のリリース（タグ v0.3 など）。エンジンは `id name LibraShogi 0.3.0` と名乗る。
// 0.3 から玉配置表（scale.json）を配らず、両玉は Libra が読んで置く。0.2 以前はサポートを終えた（0.11.0）。

export type Version = [number, number, number];

/** これより古い Libra はサポートしない */
export const MIN_LIBRA: Version = [0, 3, 0];

/** `0.3`・`v0.3`・`0.3.1` を数の組に。読めなければ null */
export function parseVersion(s: string | undefined | null): Version | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(s ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** 名乗り（`id name`）が Libra なら版。Libra でなければ null */
export function libraVersionOf(idName: string | undefined | null): Version | null {
  const m = /^LibraShogi\s+(\S+)/.exec(String(idName ?? '').trim());
  return m ? parseVersion(m[1]) : null;
}

export function compareVersion(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** サポートを終えた Libra（0.2 以前）の登録か */
export function libraUnsupported(cfg: { idName?: string }): boolean {
  const v = libraVersionOf(cfg.idName);
  return v !== null && compareVersion(v, MIN_LIBRA) < 0;
}

/** リリースの添付から Windows 版の zip を選ぶ（`libra-v0.3-windows-x64.zip`） */
export function windowsAsset<T extends { name: string }>(assets: T[]): T | null {
  return assets.find((a) => /^libra-v[\d.]+-windows-x64\.zip$/i.test(a.name)) ?? null;
}
