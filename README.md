# 天秤将棋 デスクトップ

天秤将棋（布石将棋）のデスクトップ GUI。Tauri v2 + TypeScript。
布石の段階から評価値を出し、手元の PC のエンジンで検討する。

- 設計の検討: [docs/plan-desktop-gui.md](docs/plan-desktop-gui.md)
- 布石 USI 拡張: [docs/usi-fuseki-extension.md](docs/usi-fuseki-extension.md)
- 画面の設計: [docs/design.md](docs/design.md)

エンジンと評価関数は**同梱しない**。各自で用意し、「エンジン」から場所を指定する。

## いま動くもの（v0）

- 天秤将棋の手順（両玉 → 先後の選択 → 布石 38 手 → 本将棋）と布石将棋。ルールは wasm（cppshogi）が持つ
- 盤・駒台・棋譜・待った・投了、41 手目の裁定
- USI エンジンの登録（実行ファイル・EvalDir・スレッド・ハッシュ・MultiPV・追加 setoption）
- 検討: 現局面を `position` で渡して `go infinite`、MultiPV を候補表に。勝率は 41 手目の較正式で換算
- 天秤グラフ（先手勝率の折れ線と、現局面で傾く梁）
- USI ログ（生の往復を見る・手で送る）
- 明／暗テーマ

布石中の検討は「布石にも対応」と登録したエンジンだけが受ける。そのエンジン（開発リポジトリの
dlshogi フォークを伸ばしたもの）はまだ無い。仕様は `docs/usi-fuseki-extension.md`。

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

### WSL / Ubuntu で `tauri dev` するには

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Windows で使うには

Windows 側に Rust と Node.js を入れて `npm run tauri dev`。
エンジンはこのアプリから `wsl.exe` 経由でも起動できる。実行ファイルに `C:\Windows\System32\wsl.exe`、
起動時の引数に `-d Ubuntu-24.04 -- /home/you/engine/usi` を入れる。GPU を使う布石エンジンを WSL 側で回す想定。

## エンジンの登録

「エンジン」→「エンジンを追加」。

| 項目 | 例 |
|---|---|
| 実行ファイル | `C:\shogi\YaneuraOu_NNUE.exe` |
| 評価関数のフォルダ | `C:\shogi\eval`（`nn.bin` の入ったフォルダ。`setoption name EvalDir` で渡す） |
| 使える局面 | やねうら王は「本将棋（41手目以降）だけ」 |

## ライセンス

GPL-3.0-only。wasm は dlshogi（GPL-3.0）由来。shogiops は MIT。
