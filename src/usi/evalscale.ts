// 評価値（cp）と勝率の換算は**エンジンごと**に持つ。
//
// やねうら王 NNUE は FV_SCALE（16 / 20 / 24）で cp の目盛りが変わり、dlshogi 系は勝率を
// 600·ln(p/(1−p)) で cp に直して出す。共通の通貨は勝率で、グラフと天秤は勝率で繋ぐ。
// cp は「そのエンジンの目盛り」として候補表に添えるだけ。
//
// 開発機の実測（41 手目局面 5,569 局の実際の勝敗、やねうら王 + 水匠5、FV_SCALE 16、10k ノード）は
// S=435・offset +34cp。他のエンジンには当てはまらないので、目盛りを持たないエンジンは
// 一般的な 600 / 0 で始め、利用者が変えられる。

import type { Key } from '../i18n.ts';

export interface EvalScale {
  /** ロジスティックの幅。p = 1 / (1 + exp(−(cp − offset) / scale)) */
  scale: number;
  /** 勝率がちょうど 50% になる cp */
  offsetCp: number;
}

export const DEFAULT_EVAL: EvalScale = { scale: 600, offsetCp: 0 };

export function cpToP(cp: number, e: EvalScale = DEFAULT_EVAL): number {
  return 1 / (1 + Math.exp(-(cp - e.offsetCp) / e.scale));
}

export function pToCp(p: number, e: EvalScale = DEFAULT_EVAL): number {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.round(e.scale * Math.log(q / (1 - q)) + e.offsetCp) || 0;
}

export interface EvalPreset {
  id: string;
  /** 文言は画面の言語で引く（i18n.ts の鍵） */
  labelKey: Key;
  eval: EvalScale;
  noteKey: Key;
}

/** 設定画面の選択肢。値はここに閉じ、画面はこの表を並べるだけ */
export const EVAL_PRESETS: EvalPreset[] = [
  { id: 'generic', labelKey: 'ep_generic_label', eval: { scale: 600, offsetCp: 0 }, noteKey: 'ep_generic_note' },
  { id: 'suisho5-fv16', labelKey: 'ep_fv16_label', eval: { scale: 435, offsetCp: 34 }, noteKey: 'ep_fv16_note' },
  { id: 'suisho5-fv24', labelKey: 'ep_fv24_label', eval: { scale: 652, offsetCp: 51 }, noteKey: 'ep_fv24_note' },
];

export function presetOf(e: EvalScale): EvalPreset | null {
  return EVAL_PRESETS.find((p) => p.eval.scale === e.scale && p.eval.offsetCp === e.offsetCp) ?? null;
}

export interface Recipe {
  /** `id name` に当てる */
  test: RegExp;
  /** 表示名の候補 */
  name: string;
  eval: EvalScale;
  kind: 'normal' | 'fuseki';
  noteKey: Key;
}

/**
 * 既知のエンジンの型。`id name` が一致したときに名前・目盛り・種別を**提案するだけ**で、
 * 一致しなくても普通に動く。追加はこの表に 1 行足す。
 */
export const RECIPES: Recipe[] = [
  { test: /Tenbin Fuseki Engine/i, name: '布石エンジン', eval: { scale: 435, offsetCp: 34 }, kind: 'fuseki', noteKey: 'rc_fuseki_note' },
  { test: /Suisho\s*5|水匠5/i, name: '水匠5', eval: { scale: 652, offsetCp: 51 }, kind: 'normal', noteKey: 'rc_suisho_note' },
  { test: /YaneuraOu/i, name: 'やねうら王', eval: { scale: 600, offsetCp: 0 }, kind: 'normal', noteKey: 'rc_yane_note' },
  { test: /dlshogi|Fukauraou|ふかうら王/i, name: 'ふかうら王', eval: { scale: 600, offsetCp: 0 }, kind: 'normal', noteKey: 'rc_dl_note' },
];

export function recipeFor(idName: string): Recipe | null {
  return RECIPES.find((r) => r.test.test(idName)) ?? null;
}
