// 推論の実行プロバイダ（CUDA / DirectML / CPU）を見て、CUDA 版への切り替えを案内するかを決める。
//
// Libra（天秤将棋の USI 拡張エンジン）の配布物は DirectML 版の ONNX Runtime を同梱する。
// NVIDIA の GPU なら DLL を CUDA 版に差し替えると約 4 倍速いが、CUDA・cuDNN は利用者が用意する
// （このアプリにも Libra にも同梱しない）。持っている人にだけ知らせる（Issue #2、2026-09-14 決定）。
// 画面にも Tauri にも触らない（node --test で確かめる）。

import type { InferenceProvider, ProviderFallback, ProviderLine } from './parse.ts';

/** isready の間に集めた、エンジン 1 本ぶんの推論の申告 */
export interface ProviderReport extends ProviderLine {
  /** 先に試して使えなかったプロバイダ（出た順） */
  fallbacks: ProviderFallback[];
}

/**
 * 出す案内。
 * - `fallback`: CUDA に切り替えようとして DLL が足りない（エラー文に足りない DLL の名前が入っている）
 * - `switch`: NVIDIA の GPU があるのに DirectML か CPU で読んでいる
 */
export type CudaAdvice = 'fallback' | 'switch';

export function cudaAdvice(r: ProviderReport, hasNvidia: boolean): CudaAdvice | null {
  if (r.provider === 'cuda') return null;
  // CUDA を試して落ちたのなら NVIDIA の GPU の調べ方に関係なく知らせる（本人が切り替えようとしている）
  if (r.fallbacks.some((f) => f.from === 'cuda')) return 'fallback';
  return hasNvidia ? 'switch' : null;
}

/** CUDA を試して使えなかったときのエラー文（無ければ null） */
export function cudaFallbackError(r: ProviderReport): string | null {
  return r.fallbacks.find((f) => f.from === 'cuda')?.error ?? null;
}

/** NVIDIA の PCI ベンダー ID */
export const NVIDIA_VENDOR_ID = 0x10de;

export const PROVIDER_LABELS: Record<InferenceProvider, string> = { cuda: 'CUDA', dml: 'DirectML', cpu: 'CPU' };
