# Windows ネイティブビルドの確認（Windows の Claude Code セッションに渡すプロンプト）

以下をそのまま貼る。

---

天秤将棋のデスクトップ GUI `tenbin-shogi-desktop`（Tauri v2 + TypeScript）を **Windows でネイティブに動かし、
配布物（NSIS インストーラ）まで作る**のがこのセッションの仕事です。設計や画面は変えません。
Windows で動かすために必要な修正だけをします。

## 前提

- リポジトリ: https://github.com/kotenbu135/tenbin-shogi-desktop （private。`gh auth login` 済みのはず。
  済んでいなければ止まって私に言う）
- これまでは WSL（Ubuntu）の WebKitGTK で開発・確認してきた。Windows では WebView2 になる。
- 作業場所は Windows のローカルドライブ（例 `C:\work\tenbin-shogi-desktop`）。`\\wsl$` や `/mnt/` 越しに
  ビルドしない（遅いうえに Rust のビルドが壊れる）。
- 手元の水匠5は `E:\shogi\水匠5\Suisho5-AVX2.exe`（評価関数を埋め込んだ配布物。EvalDir 不要）。
  CPU は Ryzen 9 9950X3D なので AVX2 版を使う。
- **マシンで重い測定はしない。** エンジンを動かすのは動作確認の数十秒だけ。
- 開発リポジトリ `fuseki-shogi-ai` はこの仕事に要らない。触らない。

## 読むもの（最初に）

`README.md`、`THIRD_PARTY.md`、`docs/plan-model-distribution.md`（第 7 節「エンジンの扱い」が要件）。
`docs/design.md` に画面の決めごと（駒の画像は lishogi の kanji_light、段は右、筋は上、後手の駒は回転済みの別ファイル）。
**駒の画像や盤の見た目は触らない。**

## 手順

1. 必要なもの: Node.js 22 以上、Rust stable（MSVC）、Visual Studio Build Tools の C++ ワークロード、
   WebView2 ランタイム（Windows 11 なら入っている）。無いものは入れる手順を私に示す（私が入れる）。
2. `git clone`（無理なら私に言う）→ `npm install` → `npm test` → `npm run build`。
   ここで落ちたらまずそれを直す。`npm test` は node の `--test` で `src/**/*.test.ts` を走らせる
   （TypeScript の strip-only モード。`constructor(public x)` のようなパラメータプロパティは書けない）。
3. `npm run tauri dev` で起動して、次を目で確かめる（画面のスクリーンショットを撮って残す）:
   - 起動直後に「USI ログ」を開くと `内蔵の布石評価: 方策 fuseki_degct_b3_iter1177.onnx / 価値ネット …` が出る
     （onnxruntime-web の wasm が WebView2 で読めているか。CSP は `src-tauri/tauri.conf.json` の
     `wasm-unsafe-eval`。読めなければ USI ログにエラーが出る）
   - 「検討を始める」で 1 手目の候補（両玉の価値表）が並ぶ。両玉を置いて先後を選ぶと 3 手目の候補が
     価値ネットで並び、盤に矢印が出る
   - 「エンジン」→「実行ファイルを選んで追加」で `E:\shogi\水匠5\Suisho5-AVX2.exe` を選ぶ。起動して申告を読み、
     名前「水匠5」・目盛り 652 / +51 が提案される。保存する
   - 「新しい対局」で席 A・席 B ともに「エンジン」、本将棋は水匠5、布石は内蔵、1 手 1 秒。
     布石 40 手が内蔵で進み、41 手目から水匠5が指す。名札の下に思考の行が出る。数手見たら「新しい対局」で止める
   - 41 手目以降で「検討を始める」→「自動」の枠が水匠5になり候補が並ぶ。「＋ エンジンを足す」で 2 枠目を
     出し、同じ局面で並ぶ
   - 「エンジン」→「フォルダから取り込む」→ フォルダを開くボタンで `%APPDATA%\com.fusekishogi.tenbin\engines`
     が開く。そこに水匠5のフォルダを置いて取り込めるか
   - 「保存」→ KIF が書けて、「開く」で読める（天秤将棋は形が 1 つ。布石将棋のときだけ 対局全体 / 本将棋だけ を選ぶ）
4. `npm run tauri build` → `src-tauri\target\release\bundle\nsis\*.exe`。インストールして 3 の起動確認だけを繰り返す。
   インストーラの大きさと、初回起動の時間を記録する。
5. 直したことは **ブランチ `windows-build`** にコミットして push する（main に直接は入れない）。
   コミットメッセージは日本語で、何が Windows で壊れていたかを書く。
   `git push` で LFS のフックが空振りする環境があるので、その場合は `git -c core.hooksPath=/dev/null push`。

## 報告

最後に次を書く。私は WSL 側の記録と突き合わせる。

- 通ったもの / 通らなかったもの（エラーは文言そのまま）
- 直したファイルと理由
- インストーラのパスと大きさ、初回起動の秒数
- WebView2 で wasm と onnxruntime-web が動いたか（動かなければ USI ログの文言）
- 水匠5の申告（`id name` の行）と、検討の候補が並んだときの深さ・ノード数

## やらないこと

- 画面や駒や設計の変更。ライセンス表記の変更。モデルファイルの差し替え
- Linux 用の確認スクリプト（`scripts/drive-app.mjs`, `scripts/drive-engines.mjs`）の Windows 対応。
  これらは WebKitGTK 専用なので、Windows では目視で確かめる
- 重い計算。GPU は今回の配布の対象外
