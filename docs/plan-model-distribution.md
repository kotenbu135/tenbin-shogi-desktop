# デスクトップ版のモデル配布（検討、2026-09-08）

対象: `tenbin-shogi-desktop` を配布物（Windows のインストーラ等）にするとき、学習済みモデルを
どう扱うか。読んだもの: 開発リポジトリの `THIRD_PARTY.md`・`docs/degct_plan.md`・
`docs/plan-search-at-playtime.md`・`docs/setup.md`、公開サイトの `THIRD_PARTY.md`・`models/README.md`・
`build.mjs`、DirectML / CUDA / ort の配布条件（一次資料は末尾）。**測定はしていない。**

## 結論

1. **配るモデルは公開サイトと同じ 3 ファイルで、アプリに同梱する。** 布石方策
   `fuseki_degct_b3_iter1177.onnx`（1.98MB）、両玉の価値表 `king_pairs_iter1177_games.json`（0.3MB）、
   価値ネット `value_mid_iter1400_t40.onnx`（6x64、2.42MB）。合計 4.7MB。三つとも乱数初期化から
   自分の対局記録だけで学習した自作物で、GCT 由来のパラメータを含まない。アプリと同じ GPL-3.0-only で配る。
2. **布石中の評価（`value` / `twoply` / 両玉の表）は GUI に内蔵する。** 公開サイトの `value.js` /
   `policy.js` / `kings.js`（合計 14KB）を onnxruntime-web（MIT）ごと移植する。cppshogi の wasm と
   特徴量抽出はデスクトップにもう入っている。**Python の布石エンジンは配らない**（開発機で動かす
   外部 USI エンジンとして残す）。
3. **同梱しないもの**: やねうら王本体、水匠5 の `nn.bin`、GCT 由来の重み、CUDA / cuDNN / TensorRT。
   本将棋の検討は現状どおり利用者がエンジンと評価関数を用意する。
4. **配布の前に直すこと**: `THIRD_PARTY.md` の shogiops の表記（MIT と書いてあるが実際は
   GPL-3.0-or-later）、リポジトリの公開（GPL §6 の対応するソース）、モデルの manifest、
   公開サイト側の教師信号の記述の矛盾（後述）。

## 1. 機能ごとに何が要るか

| 機能 | 要るもの | 大きさ | 由来 | 配布 |
|---|---|---|---|---|
| 布石のルール・特徴量 | `public/wasm/fuseki.{mjs,wasm}` | 0.27MB | dlshogi フォーク（GPL-3.0、公開） | 同梱済み |
| 両玉の置き方・選び方 | `king_pairs_iter1177_games.json` | 0.3MB | 自作（実対局の勝敗とロールアウト採点） | 同梱 |
| 布石の候補の絞り込み | `fuseki_degct_b3_iter1177.onnx` | 1.98MB | 自作（乱数初期化、教師はやねうら王の探索結果） | 同梱 |
| 布石の評価 `value` / `twoply` | `value_mid_iter1400_t40.onnx`（6x64） | 2.42MB | 自作（乱数初期化、教師は実対局の勝敗） | 同梱 |
| 同上、精密版 | `value_mid_v3_10x128_t40`（要 ONNX 書き出し） | 12.7MB | 同上 | 任意 |
| 推論ランタイム | onnxruntime-web の wasm | 14〜28MB | MIT | 同梱 |
| 本将棋の検討 | やねうら王 + `nn.bin` | 〜64MB | GPL-3.0 / 水匠5は明文の許諾なし | **利用者が用意** |
| 布石の `rollout` | 方策の大量推論 + やねうら王の採点 | | | 外部エンジン（後述） |

6x64 と 10x128 の差は小さい。iter1400 以降の held-out で全体 AUC は 0.6945 と 0.7015、実対局の
強さでは区別できない（`docs/plan-search-at-playtime.md`「5分の1のサイズで実質同じ」）。
CPU の推論費用は 10x128 が約 6.6 倍（1 局面あたりの積和 239M 対 36M）で、`twoply` の 256 局面を
wasm の 1 スレッドで回すと 6x64 が 1 秒前後、10x128 は数秒かかる見込み。**内蔵は 6x64 にし、
公開サイトと同じファイルを使う**。10x128 は外部エンジン（Python）側の既定のままでよい。

## 2. 由来とライセンスの棚卸し

### 2.1 学習済みモデル（すべて自作）

| ファイル | 初期値 | 教師信号 | GCT 由来 |
|---|---|---|---|
| 布石方策 iter1177 | 乱数（`rand6x64.npz`） | やねうら王（開発機の水匠5 `nn.bin`、FV_SCALE 16）の 41 手目の評価値。ロールアウト学習 | 無し |
| 価値ネット 6x64 / 10x128（t40） | 乱数 | 昇格ゲートの実対局の勝敗（iter1001〜1399、37,523 局）。対局はやねうら王 200k ノード + 水匠5 | 無し |
| 両玉の価値表 iter1177 | — | 帯の 48 組は実対局の勝敗（Háo、GPL-3.0）、残り 1,248 組はロールアウト採点（水匠5） | 無し |

「GCT 由来を含まない」の根拠は開発リポジトリの `docs/degct_plan.md` と公開サイトの
`models/README.md`。学習の起動コマンドに GCT 派生の重みを指す引数が無いこと、V\*（GCT の価値ヘッド）は
測定の審判にしか使っていないことが記録されている。

**教師信号としての水匠5。** 三つとも「やねうら王＋水匠5が出した評価値、またはそれで指した対局の
勝敗」を教師にしている。開発リポジトリの `THIRD_PARTY.md` はこれを「プログラムの出力の利用であって
パラメータの流用ではない。GCT と違い、やねうら王・水匠側には追加学習や流用を禁じる明文が無い」と
整理している。この整理を踏襲する。弱点も同じ: 水匠5 の `nn.bin` にはライセンス表記そのものが無く、
書面の許諾に基づく判断ではない。**だから `nn.bin` は配らない**（利用者がやねうら王公式の
`suisho5` リリースから取る）。

### 2.2 公開サイト側の記述の矛盾（要修正、`fuseki-shogi-web`）

公開サイトの `THIRD_PARTY.md` は布石方策について「やねうら王（`yaneuraou.k-p` 同梱の
SuishoPetite）の探索結果だけを教師信号にして学習した」と書いている。しかし同じ文書の
「水匠5 `nn.bin`」の節と開発リポジトリの記録では、教師を作ったのは開発機の水匠5であり、
SuishoPetite はブラウザで 41 手目以降を指す評価関数にすぎない。**教師は水匠5、対局相手は SuishoPetite**
と書き分けるのが正しい。ライセンス上の結論（自作物として GPL-3.0 で配る）は変わらないが、
由来の記述が事実と違うのは配布物の説明として直すべき。デスクトップ側の文書は上の表のとおり書く。

### 2.3 デスクトップの部品

| 部品 | ライセンス | 備考 |
|---|---|---|
| cppshogi の wasm | GPL-3.0 | 対応するソースは公開フォーク `kotenbu135/DeepLearningShogi` とビルド手順（公開サイトの `wasm/build.sh`） |
| shogiops | **GPL-3.0-or-later** | `THIRD_PARTY.md` に MIT と書いてあるのは誤り（`node_modules/shogiops/package.json`）。GPL-3.0-only のアプリに同梱できる |
| onnxruntime-web | MIT | 著作権表示を同梱する |
| Tauri と各プラグイン | MIT / Apache-2.0 | |
| 駒の画像 kanji_light | CC BY 4.0 | 表示済み |
| 学習済みモデル 3 点 | 自作。アプリと同じ GPL-3.0-only | manifest に由来と SHA-256 を書く |

アプリ全体は GPL-3.0-only のまま（公開サイトと同じ。wasm と shogiops が GPL）。

### 2.4 GPU のランタイムを同梱する場合の条件（将来のため）

内蔵評価は CPU（wasm）で足りるので、いまは何も同梱しない。必要になったときの条件だけ記す。

| ランタイム | 再配布 | 制約 |
|---|---|---|
| DirectML（`Microsoft.AI.DirectML` NuGet） | 可 | Windows / Xbox 上のアプリの一部としてのみ。改変・リバースエンジニアリング禁止。単体配布不可 |
| CUDA ランタイム（cudart, cublas 等） | 可（EULA Attachment A） | アプリに実質的な追加機能があること、表示文の同梱 |
| cuDNN | Attachment A に**無い**。別ライセンスの確認が要る | onnxruntime の CUDA EP に必須。数百 MB〜GB |
| TensorRT | 別ライセンス。ふかうら王は同梱して配っている前例あり | GB 級、GPU 世代と版の依存が強い |

GPU が要るのは `rollout`（方策の大量推論）だけで、それは C++ の外部エンジンの話（第 3 節 E）。
GUI 本体に CUDA を入れる案は取らない。

## 3. 配り方の選択肢

| 案 | 中身 | 判断 |
|---|---|---|
| **A. アプリに同梱** | `public/models/` に 3 ファイルと manifest。webview から wasm と同じ経路で読む | **採用**。自作物なので配ってよく、オフラインで動き、公開サイトと同じ物 |
| B. 利用者が用意（EvalDir 方式） | エンジンと同じく場所を指定させる | 不採用。自作物を配らない理由が無い。ただし**差し替え口**として設定に「モデルのフォルダ」を残す（新世代の検証、9/30 の最終版） |
| C. 初回起動時にダウンロード | 公開サイトに既にある | 不採用。初回にオフラインで動かず、更新経路が増える |
| D. Python の布石エンジンを PyInstaller で配る | torch + CUDA で 2〜4GB | 不採用。cuDNN の別ライセンス、Windows の GPU で DirectML が使えない、2 つのランタイム |
| E. C++ の布石 USI エンジン | dlshogi フォークの `usi` に布石拡張を足し、ORT-CPU / ORT-DirectML で配る。Tauri のサイドカー（`externalBin`）で同梱 | `rollout` が要ると分かってから。M3 の結果待ち |

A で内蔵する範囲は `value` / `twoply` / 両玉の表。これは公開サイトが 2026-09-08 に動かした
`src/value.js`（`InferenceSession` を 1 つ足し、方策と同じ `input1`/`input2` を渡す）そのもので、
新しい仕組みは要らない。

## 4. 実装の輪郭

- 置き場所: `public/models/` に 3 ファイルと `models.json`（世代 `iter1177` / `iter1400`、SHA-256、
  由来、ライセンス）。**名前で開ける**（公開サイトの `.gitignore` と `build.mjs` の流儀。ワイルドカードにすると
  次に置いた重みが黙って配布経路に混ざる）。開発機の `models/` には GCT 由来の重みが同居しているので、
  ビルドの入力は必ず `public/models/` に限る。
- 推論: `onnxruntime-web` を依存に足し、wasm は `public/vendor/ort/` に置く。CSP は既に
  `wasm-unsafe-eval` を許している。スレッド化（SharedArrayBuffer）は webview の cross-origin isolation が
  要るので、まずは 1 スレッドで動かす（6x64 なら足りる）。
- コード: `src/eval/{policy,value,kings}.ts` に公開サイトの JS を型付きで移植。検討パネルには
  「内蔵（布石の価値ネット）」を `kind: 'fuseki'` の疑似エンジンとして最初から登録し、外部エンジンが
  無くても布石中の検討が動くようにする。外部の布石エンジン（USI 拡張）はそのまま選べる。
- 世代の整合: 両玉の表は方策の世代に従属する。`kings.js` と同じくファイル名の `iterN` を突き合わせ、
  ずれていれば天秤将棋の両玉だけを閉じる。価値ネットは独立。
- 差し替え口: 設定に「モデルのフォルダ」（既定は同梱）。manifest の形式が合わなければ既定に戻す。

## 5. 配布の前に済ませること

1. `THIRD_PARTY.md`: shogiops を GPL-3.0-or-later に直す。onnxruntime-web とモデル 3 点の節を足す。
2. **リポジトリを公開する**（または配布物にソースを同梱する）。GPL のバイナリ配布には対応する
   ソースの提供が要る。いまは private だが重みは入っていないので、公開の障害は無い。公開前に
   個人のパス（`settings.json` の類）がコミットに無いことを確認する。
3. manifest と SHA-256。公開サイトと同じファイルなら SHA-256 も一致するはず。一致を CI で確かめる。
4. 10x128 を配るなら ONNX の書き出しと数値パリティの確認（開発リポジトリに書き出しの道具がある）。
   配らないなら外部エンジンの既定のままでよい。
5. 公開サイトの `THIRD_PARTY.md` の教師信号の記述を直す（2.2）。デスクトップの文書と食い違わせない。
6. Windows ネイティブのビルドで wasm と onnxruntime-web が WebView2 で動くことの確認（M4）。

## 6. 学習の凍結（9/30）との関係

最終版は 9/27〜30 の「畳む期間」に 1 回だけ作る（方策 iterN、その世代の両玉の表、t=40 を含む
価値ネット）。**デスクトップと公開サイトで同じ 3 ファイル・同じ manifest** にすれば、由来の説明も
SHA-256 も一度書けば済む。

## 一次資料

- DirectML の配布条件: NuGet `Microsoft.AI.DirectML` の License（Windows / Xbox 上のアプリの一部として再配布可、改変不可）
  <https://www.nuget.org/packages/Microsoft.AI.DirectML/1.15.4/License>
- CUDA Toolkit EULA Attachment A（再配布できるランタイムの一覧。cuDNN は含まれない）
  <https://docs.nvidia.com/cuda/eula/index.html>
- ort（Rust の ONNX Runtime バインディング）: Apache-2.0 / MIT <https://github.com/pykeio/ort>
- onnxruntime-web の WebGPU: Chromium 113 以降。WebView2 では有効化の手順が定まっていない
  <https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html>, <https://github.com/tauri-apps/tauri/issues/6381>
- 公開サイトの配布方針: `fuseki-shogi-web/models/README.md`, `THIRD_PARTY.md`, `build.mjs`
- 開発リポジトリ: `THIRD_PARTY.md`（GCT の調査と水匠5の判断）, `docs/degct_plan.md`, `docs/setup.md`（`nn.bin` の取り出し）
