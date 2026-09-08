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

## ライブラリ

| もの | ライセンス | 用途 |
|---|---|---|
| shogiops | GPL-3.0-or-later | 本将棋の合法手・SFEN・日本語の符号。GPL-3.0-only のこのアプリに同梱できる |
| Tauri と各プラグイン | MIT / Apache-2.0 | デスクトップの殻 |
| Vite / TypeScript | MIT / Apache-2.0 | ビルド |
