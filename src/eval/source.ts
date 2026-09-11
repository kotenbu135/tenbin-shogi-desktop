// 模型一式（方策・両玉の価値表・価値ネット）の読み口。
//
// 同梱ぶんは webview から見える URL（`/models/`）で、差し替えぶんは利用者が指したフォルダで読む。
// フォルダ側でも `fetch` を使わないのは、`convertFileSrc` で読ませると
// `tauri.conf.json` の `connect-src` を開けることになるため。**CSP は触らない**。
// 代わりに Rust の `read_binary_file`（生バイトを返す）を呼び、ONNX は `Uint8Array` のまま
// onnxruntime に渡す。

import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n.ts';

export interface ModelSource {
  /** 出どころのフォルダ。同梱なら null */
  readonly dir: string | null;
  text(file: string): Promise<string>;
  /** onnxruntime に渡す形。同梱は URL のまま（streaming で読める）、フォルダはバイト列 */
  model(file: string): Promise<string | Uint8Array>;
}

/**
 * manifest に書かれたファイル名は、そのフォルダの中の 1 つでなければならない。
 * `../` や絶対パスをそのまま繋ぐと、模型の一覧を持ってきただけで別の場所を読ませられる。
 */
export function plainName(file: unknown): string {
  const s = String(file ?? '');
  if (!s || /[\\/]/.test(s) || s === '.' || s === '..') throw new Error(t('bi_bad_filename', { file: s }));
  return s;
}

/** 同梱（`/models/`）。webview の中なので fetch で読む */
export function urlSource(base: string): ModelSource {
  const root = base.endsWith('/') ? base : base + '/';
  return {
    dir: null,
    async text(file) {
      const url = root + plainName(file);
      const res = await fetch(url);
      if (!res.ok) throw new Error(t('bi_models_unreadable', { status: res.status, url }));
      return res.text();
    },
    async model(file) {
      return root + plainName(file);
    },
  };
}

/** 差し替え（利用者が指したフォルダ）。Tauri の中でだけ使える */
export function dirSource(dir: string): ModelSource {
  const root = dir.replace(/[\\/]+$/, '');
  const sep = root.includes('\\') ? '\\' : '/';
  const at = (file: string) => `${root}${sep}${plainName(file)}`;
  return {
    dir: root,
    async text(file) {
      return invoke<string>('read_text_file', { path: at(file) });
    },
    async model(file) {
      const buf = await invoke<ArrayBuffer>('read_binary_file', { path: at(file) });
      return new Uint8Array(buf);
    },
  };
}
