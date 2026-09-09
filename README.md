# 天秤将棋 デスクトップ

天秤将棋（布石将棋）のデスクトップ GUI。Tauri v2 + TypeScript。
布石の段階から評価値を出し、手元の PC のエンジンで検討する。

- 設計の検討: [docs/plan-desktop-gui.md](docs/plan-desktop-gui.md)
- 既存の GUI との比較と問題点: [docs/review-vs-existing-gui.md](docs/review-vs-existing-gui.md)
- 布石 USI 拡張: [docs/usi-fuseki-extension.md](docs/usi-fuseki-extension.md)
- 画面の設計: [docs/design.md](docs/design.md)
- モデルの配布: [docs/plan-model-distribution.md](docs/plan-model-distribution.md)

エンジンと評価関数は**同梱しない**。各自で用意し、「エンジン」から場所を指定する。

## いま動くもの（v0）

- 天秤将棋の手順（両玉 → 先後の選択 → 布石 38 手 → 本将棋）と布石将棋。ルールは wasm（cppshogi）が持つ
- 盤・駒台・名札・棋譜（連盟の符号、局面の移動、分岐）・待った・投了、41 手目の裁定。駒は公開版と同じ kanji_light
- USI エンジンの登録。何本でも。`usi` の申告から設定画面を作る（Threads・USI_Hash・EvalDir も申告の 1 項目）。エンジンのフォルダから一括で取り込める。評価値→勝率の目盛りはエンジンごと
- 布石の評価を内蔵（方策・価値ネット・両玉の価値表を onnxruntime-web で）。エンジンが無くても 1〜40 手目の検討と AI の布石が動く
- 画面の割りつけは ShogiHome の標準レイアウトと同じ。上に盤と棋譜、下にタブの欄（検討 / 評価値 / 期待勝率）。仕切りは掴んで動かせる
- 検討: 枠を足して複数のエンジンで同じ局面を並べて検討できる。「自動」の枠は布石中は内蔵、41 手目からは既定のエンジンに切り替わる。候補の行き先を盤に矢印と印で示す。終局した局面も検討できる
- 候補の表は 順位 / 深さ / Node数 / **評価値** / **期待勝率** / 読み筋。評価値と期待勝率はどちらも先手から見た値
- 対局中の読み: 手番のエンジンの読み筋・深さ・ノード数を検討パネルの「対局の枠」に出す（ShogiHome と同じく、思考と検討は同じ欄）
- 棋譜解析: 棋譜の局面を順に評価してグラフを埋める（範囲と 1 局面の秒数を指定。布石は内蔵、41 手目からは既定のエンジン）
- 対局: 席ごとに人かエンジンか。布石は内蔵の方策（強さ 1〜5）か布石対応のエンジン、本将棋は登録したどのエンジンでも
- 評価グラフは 2 種（評価値 ±2000 / 期待勝率 0〜100%）。系列は先手・後手・検討の 3 本。押すとその手数の局面へ移る。
  cp を持たないエンジン（内蔵の布石評価）の点は中を抜いた丸で描き、勝率からの換算だと分かるようにする
- 対局時計（持ち時間と秒読み。消費時間を棋譜に残す）
- KIF の保存と読み込み。対局全体（布石を含む、このアプリの方言）と、本将棋の部分だけ（局面図つきの普通の KIF。将棋所や ShogiHome で開ける）
- 局面編集（任意の局面から本将棋を始める）、盤面反転
- USI ログ（生の往復を見る・手で送る）
- 明／暗テーマ

布石中の検討は内蔵の評価が受ける（公開サイトと同じ 3 つのモデル。`public/models/models.json`）。
外部の布石エンジン（USI 布石拡張。開発リポジトリの `scripts/fuseki_usi_server.py`）も登録できる。
仕様は `docs/usi-fuseki-extension.md`。

## 構成

```
src/            フロントエンド（TypeScript、フレームワーク無し）
  rules/        wasm の呼び出し規約（布石のルール）
  state/        対局の状態（布石は wasm、本将棋は shogiops）
  usi/          USI の分解とエンジンの状態機械
  ui/           盤・棋譜・検討・グラフ・ログ・エンジン登録
public/wasm/    cppshogi の wasm（開発リポジトリ engine/dlshogi/cppshogi をビルドしたもの）
src-tauri/      Tauri（Rust）。コマンドとイベントの橋渡しだけ
crates/usi-host USI プロセスの起動・行の送受信（Tauri 非依存。単体テストあり）
docs/           設計
```

## 開発

必要なもの: Node.js 22 以上、Rust（stable）、Tauri v2 の OS 依存パッケージ。

```bash
npm install
npm test                 # USI の分解のテスト
cargo test -p usi-host   # プロセス管理のテスト
npm run dev              # ブラウザでプレビュー（盤と棋譜は動く。エンジンは起動できない）
npm run tauri dev        # アプリとして起動
npm run tauri build      # 配布物
```

### 動作の確かめ方（自動）

```bash
npm run build && npm run preview          # http://localhost:4173
node scripts/smoke-preview.mjs /tmp       # ブラウザで両玉→布石→本将棋→待ったを通す
node scripts/smoke-builtin.mjs /tmp       # 内蔵の布石評価・複数枠の検討・内蔵同士の自動対局
node scripts/smoke-review.mjs /tmp        # 割りつけ・対局の枠・2 種のグラフ・終局後の検討・棋譜解析・狭い窓
WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9222 npm run tauri dev   # 別の端末で
node scripts/drive-app.mjs /tmp           # 動いているアプリを操作し、登録済みエンジンで検討まで通す
node scripts/drive-engines.mjs /tmp <エンジン>  # 申告の読み取り→登録→エンジン同士の対局→複数枠の検討
```

`drive-app.mjs` は Linux（WebKitGTK）向け。Windows の WebView2 では動かない。

### WSL / Ubuntu で `tauri dev` するには

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev fonts-noto-cjk
```

`fonts-noto-cjk` は日本語の書体。無いと符号や駒台の文字が代替フォントで崩れる。

### Windows で使うには

Windows 側に Rust と Node.js を入れて `npm run tauri dev`。
エンジンはこのアプリから `wsl.exe` 経由でも起動できる。実行ファイルに `C:\Windows\System32\wsl.exe`、
起動時の引数に `-d Ubuntu-24.04 -- /home/you/engine/usi` を入れる。GPU を使う布石エンジンを WSL 側で回す想定。

## エンジンの登録

「エンジン」→「実行ファイルを選んで追加」か「フォルダから取り込む」。起動して `usi` の申告を読み、
設定画面を申告どおりに作る。エンジンのフォルダ（アプリのデータフォルダの `engines/`）に置けばまとめて拾える。

| 項目 | 中身 |
|---|---|
| 実行ファイル | 例: `C:\shogi\YaneuraOu_NNUE.exe`、`Suisho5-AVX2.exe`。Windows の実行ファイルは WSL の Linux 版アプリからも動く |
| エンジンの設定 | 申告された option（Threads・USI_Hash・EvalDir・MultiPV …）。変えた値だけ保存する |
| 勝率の目盛り | cp→勝率の S と offset。既定 600 / 0。水匠5（FV_SCALE 16）は 435 / +34、水匠5の実行ファイル（FV_SCALE 24）は 652 / +51 |
| 使える局面 | 本将棋（41手目以降）だけ / 布石にも対応。`Fuseki_*` の申告があれば後者を提案 |

## ライセンス

GPL-3.0-only。wasm は dlshogi（GPL-3.0）由来。shogiops は GPL-3.0-or-later。詳しくは THIRD_PARTY.md。
