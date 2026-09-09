# 天秤将棋GUI

一方が両方の玉を置き、もう一方が好きな方を持つ。先手番の得を、先手玉の薄さで釣り合わせる将棋のアプリ。
現在対応しているのはWindowsのみです。

## インストール＆セットアップ

1. [Releases](https://github.com/kotenbu135/tenbin-shogi-desktop/releases/latest) から
   `tenbin-shogi-gui_x.y.z_x64-setup.exe` を落として実行します。
2. 「**Windows によって PC が保護されました**」が出たら「詳細情報」→「実行」。
   有料の署名を付けていないため、初回だけこの画面が出ます。
3. 初めて開くと「はじめに」が出るので、**「エンジンを自動で入れる」を 1 回押します**。
   やねうら王＋水匠5（約 40MB）を公式の配布先から取得して、 PC に合うファイルを自動で登録します。

布石の評価はアプリの中に入っているので、エンジンが無くても布石の検討と AI との対局はできます。
41手目からの本将棋にだけエンジンが要ります。

## 使い方

- **新しい対局** … ルール（天秤将棋 / 布石将棋 / 本将棋）と、どちらを人が持つかを選びます。
  段階ごとに担当を分けられます（布石は自分で置いて、41手目からはエンジンに任せる、など）。
- **検討** … 押すと対局は止まり、盤の駒は自分で動かせます。変化を並べながら候補手を見られます。
- **グラフ** … 評価値（±2000）と期待勝率（0〜100%）。押すとその局面へ飛びます。
- **棋譜** … KIF の保存と読み込み。本将棋の部分だけを普通の KIF で出せば、将棋所や ShogiHome で開けます。
- 画面のレイアウトは変更できます。タブを掴んで別の欄へ運べます（欄の見出しを右クリックでひな形）。

### キー操作

| キー | すること |
|---|---|
| ← → / Home End | 棋譜を戻る・進む・最初・最新 |
| Backspace | 待った（1 手戻す） |
| Space | 一時停止・再開 |
| F | 盤面反転 |
| Ctrl+V | 棋譜を貼り付けて開く |
| Ctrl+C | 棋譜を写す |
| Ctrl+N / Ctrl+O / Ctrl+S | 新しい対局 / 開く / 保存 |

## 表示の言葉（日本語 / English）

画面は日本語と英語のどちらでも出せます。初めて起動したときは端末の言語に合わせ、
以後はツールバー右の **English / 日本語** のボタンで切り替えます（覚えるので次からその言葉で開きます）。
切り替えは窓を読み込み直すので、対局中は確かめてから切り替えます。

英語にすると符号も西洋式（`P-76`、`S*45`）になり、盤の段も数字になります。
**KIF は言葉に関わらず日本語のまま**書き出します（将棋所・ShogiHome で開ける書式のため）。

The interface is available in English. It follows your system language on first launch;
after that, use the **English / 日本語** button on the right of the toolbar. Game records are
always written as Japanese KIF so that Shogidokoro and ShogiHome can open them.

## 更新

起動のたびに新しい版を見に行き、見つかったら知らせます。**承諾したときだけ**入れ替えて再起動します。
「はじめに」→「更新を確認」でいつでも確認できます。

## アンインストール

Windows の「設定 → アプリ」から「天秤将棋GUI」を消します。
設定と入れたエンジンは `%APPDATA%\com.fusekishogi.tenbin` に残るので、そこも消せば何も残りません。
設定だけまっさらにしたいときも、このフォルダを消してから起動します。

## エンジンを手動で入れる

「エンジン」→「実行ファイルを選んで追加」か「フォルダから取り込む」。USI 対応なら何本でも登録できます。
起動して `usi` の申告を読み、設定画面を申告どおりに作ります。

- やねうら王: https://github.com/yaneurao/YaneuraOu/releases/tag/V9.00
  （`yaneuraou-V900-git-win64-all.7z` の中の `NNUE_halfkp_256x2_32_32/…_AVX2.exe` が水匠5 用）
- 水匠5 の評価関数: https://github.com/yaneurao/YaneuraOu/releases/tag/suisho5
  （展開した `nn.bin` を実行ファイルの隣の `eval/` へ。勝率の目盛りは **652 / +51**）

エンジンが起動しないときは「エンジン」→「USI ログ」で生のやり取りを見られます。

## 開発

Tauri v2 + TypeScript（フレームワーク無し）。ルールは wasm（cppshogi）、本将棋は shogiops。

```bash
npm install
npm test                 # USI の分解のテスト
cargo test -p usi-host   # プロセス管理のテスト
npm run tauri dev        # アプリとして起動
```

- 配布の手順と署名の鍵: [docs/release.md](docs/release.md)
- 設計と検証: [docs/plan-desktop-gui.md](docs/plan-desktop-gui.md) ·
  [docs/review-vs-existing-gui.md](docs/review-vs-existing-gui.md) ·
  [docs/design.md](docs/design.md) · [docs/usi-fuseki-extension.md](docs/usi-fuseki-extension.md)

## ライセンス

GPL-3.0-only。wasm は dlshogi（GPL-3.0）由来。shogiops は GPL-3.0-or-later。詳しくは THIRD_PARTY.md。
