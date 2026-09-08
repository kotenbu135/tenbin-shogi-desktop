# 第三者の成果物

## 駒の画像

`public/pieces/*.svg`（30枚）は lishogi の駒セット **kanji_light** をそのまま使っている。
公開版サイト（fuseki-shogi-web）と同じ駒。

- 作者: [Ka-hu](https://github.com/Ka-hu)
- ライセンス: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- 出所: <https://github.com/WandererXII/lishogi> の
  `ui/@build/pieces/assets/standard/kanji_light`（同リポジトリの `COPYING.md`）

ファイル名の `0`/`1` は先手/後手で、後手の駒は**回転済みの別ファイル**として入っている。
CSS で回してはいけない。玉将（GY）は先手、王将（OU）は後手が持つ（上位者が王将を持つ慣習）。

盤の画像は取り込んでいない。lishogi の盤画像は AGPLv3+ で、GPL-3.0-only の配布物に混ぜられない。
盤の木目は公開版サイトと同じく CSS の縞で描いている。

## ルールと特徴量（wasm）

`public/wasm/fuseki.{mjs,wasm}` は dlshogi（GPL-3.0）のフォーク
[kotenbu135/DeepLearningShogi](https://github.com/kotenbu135/DeepLearningShogi) の
`cppshogi` を Emscripten でビルドしたもの。ビルド手順は公開版サイトの `wasm/build.sh`。

## 学習済みモデル（`public/models/`）

`models.json` に一覧と SHA-256 がある。三つとも乱数初期化から自分の対局記録だけで学習した自作物で、
第三者の学習済みモデルを初期値にしていない（GCT 由来のパラメータを含まない）。公開サイト
[fuseki-shogi-web](https://github.com/kotenbu135/fuseki-shogi-web) の `models/` と同じファイルで、
由来の詳細はそちらの `models/README.md` にある。アプリと同じ GPL-3.0-only で配る。

| ファイル | 中身 | 教師 |
|---|---|---|
| `fuseki_degct_b3_iter1177.onnx` | 布石の方策（候補の絞り込み、AI の布石） | やねうら王（開発機の水匠5）の 41 手目の評価値によるロールアウト学習 |
| `value_mid_iter1400_t40.onnx` | 布石の価値ネット（1〜40 手目の評価） | 昇格ゲートの実対局の勝敗（対局は やねうら王 + 水匠5） |
| `king_pairs_iter1177_games.json` | 天秤将棋の両玉の価値表 | 帯の 48 組は実対局の勝敗（Háo）、残りはロールアウト採点 |

**同梱しないもの**: やねうら王・水匠5などのエンジンと評価関数（利用者が置く）、GCT 由来の重み。

## 推論ランタイム

`public/vendor/ort/` は [onnxruntime-web](https://github.com/microsoft/onnxruntime) 1.29.0 の wasm（MIT）。
布石の方策と価値ネットをブラウザ側（webview）の CPU で動かす。GPU は使わない。

## ライブラリ

| もの | ライセンス | 用途 |
|---|---|---|
| shogiops | GPL-3.0-or-later | 本将棋の合法手・SFEN・日本語の符号。GPL-3.0-only のこのアプリに同梱できる |
| onnxruntime-web | MIT | 布石の方策・価値ネットの推論 |
| Tauri と各プラグイン | MIT / Apache-2.0 | デスクトップの殻 |
| Vite / TypeScript | MIT / Apache-2.0 | ビルド |
