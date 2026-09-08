# デスクトップ版のモデル配布（検討、2026-09-08）

対象: `tenbin-shogi-desktop` を配布物（Windows のインストーラ等）にするとき、学習済みモデルと
本将棋のエンジン（水匠5）をどう扱うか。**GPU は今回は対象外**（利用者の決定、2026-09-08）。
やねうら王の wasm 版は弱いので使わない。41 手目以降は利用者が用意した本物の水匠5だけが指す。読んだもの: 開発リポジトリの `THIRD_PARTY.md`・`docs/degct_plan.md`・
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
3. **41 手目以降は水匠5。利用者が自分でダウンロードし、決まったフォルダに置く。** GUI はその
   フォルダを見て、CPU に合う実行ファイルを選び、`usi` で本物かを確かめ、本将棋のエンジンとして自動で
   登録する（第 7 節）。やねうら王の wasm 版は使わない。水匠5が無ければ 41 手目以降の検討は
   「水匠5を入れてください」で止まり、弱い代替で誤魔化さない。
   **同梱しないもの**: 水匠5、やねうら王本体、GCT 由来の重み、CUDA / cuDNN / TensorRT。
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
| 本将棋の検討 | 水匠5（評価関数を埋め込んだ実行ファイル、または `nn.bin` + やねうら王） | 66MB | GPL-3.0（配布物に Copying.txt と source.rar が同梱） | **利用者が決まったフォルダに置く**（第 7 節） |
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

### 2.4 GPU のランタイムを同梱する場合の条件（今回は対象外。将来のための記録）

GPU は今回の配布の対象外（利用者の決定）。内蔵評価は CPU（wasm）で足り、`rollout` は将来の話。
必要になったときの条件だけ残す。

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
7. 水匠5の置き場所と自動登録（第 7 節）。評価値の倍率 1.5 の一次近似を入れ、較正の測り直しはマシンが空いたときに 1 回。

## 7. 水匠5の置き場所と使い方

### 7.1 配布物は 2 種類ある（両方を受ける）

| 経路 | 中身 | 評価値の目盛り |
|---|---|---|
| **A. たややん配布の水匠5**（2021-11） | `Suisho5-AVX2.exe` / `Suisho5-ZEN2.exe`（やねうら王の実行ファイルに評価関数を埋め込んだもの。65.9MB）、`Readme.txt`、`Copying.txt`（GPLv3 全文）、`source.rar` | **FV_SCALE 24 に固定**（Readme: 2021.8 に 20→24）。`FV_SCALE` オプションは無い（この版のやねうら王にはまだ無かった。GUI のログでも確認） |
| **B. やねうら王公式の `suisho5` リリース** | `Suisho5.7z`（`nn.bin` 24MB、たややん氏提供）＋ やねうら王 V8.30 の実行ファイル（`eval/nn.bin` の一つ上に置く） | 既定 16。公式の推奨は `FV_SCALE 24` |

利用者の手元にあるのは A（`/mnt/e/shogi/水匠5/`）。A は評価関数を別ファイルとして持たないので、
EvalDir の指定が要らない。**GUI は A と B の両方を認識する**: フォルダに `Suisho5-*.exe` があれば A、
`eval/nn.bin` と `YaneuraOu*.exe`（Linux なら実行可能な `YaneuraOu*`）があれば B。

A の SHA-256（手元の配布物。本物かの確認に使う。別の版が出たら足す）:

```
f692304dbed5acc2d7c940177b64359ed0edf053b903b29457a5c0b347c07964  Suisho5-AVX2.exe
b0076c0fe3618a61bdf9d8e87c230311b9e1a0cc291029eb5d2372c8d8083d64  Suisho5-ZEN2.exe
```

一致しなくても拒まない（版が違うだけかもしれない）。一致すれば「確認済みの水匠5」と表示し、
しなければ `usi` の `id name` と `isready` の成否だけで判断して「水匠5らしき実行ファイル」と表示する。

### 7.2 置き場所

Tauri の `appDataDir` の下に固定する。管理者権限が要らず、アプリを入れ直しても残る。

| OS | フォルダ |
|---|---|
| Windows | `%APPDATA%\com.fusekishogi.tenbin\engines\suisho5\` |
| Linux（開発機） | `~/.local/share/com.fusekishogi.tenbin/engines/suisho5/`（やねうら王のビルド + `eval/nn.bin`） |

GUI の「水匠5を入れる」画面がすること:

1. このフォルダの絶対パスを表示し、「フォルダを開く」ボタンで開く（`opener` プラグイン）。
2. 入手先を示す。**A の配布元は X の投稿経由で恒久的な URL が無い**ので、安定して案内できるのは B の
   <https://github.com/yaneurao/YaneuraOu/releases/tag/suisho5>（`nn.bin`）と
   <https://github.com/yaneurao/YaneuraOu/releases/tag/v8.30git>（本体）。A を持っている人は
   zip の中身をそのまま置けばよい、と書く。
3. 「確認」で検出 → CPU に合う実行ファイルを選ぶ（7.3）→ `usi` を送って `id name` を読む →
   `isready` が `readyok` を返す（評価関数の読み込みとハッシュ検証はエンジン自身がする）→
   登録名「水匠5」・種別「本将棋（41 手目以降）」で自動登録し、検討の既定にする。
4. 無いときの文言: 「41 手目以降の検討には水匠5が必要です。上のフォルダに置いて『確認』を押してください」。
   弱いエンジンで代用しない。

汎用の「エンジンを追加」（任意の実行ファイルと EvalDir）はそのまま残す。水匠5は
その特別扱いであって、別の仕組みではない。

### 7.3 実行ファイルの選び方（CPU）

A には AVX2 と ZEN2 の 2 本がある。Readme の指示は「通常は AVX2、Ryzen の ZEN2 シリーズだけ ZEN2」。
Rust 側で `is_x86_feature_detected!("avx2")` と CPUID のベンダ・ファミリを読み、
AMD ファミリ 0x17（Zen / Zen+ / Zen2）なら ZEN2、それ以外で AVX2 があれば AVX2、AVX2 が無ければ
「この CPU では動きません」と出す。利用者の 9950X3D（Zen5）は AVX2 版。
B は利用者が置いた実行ファイルを 1 本だけ想定し、複数あれば名前で選ばせる。

### 7.4 評価値の目盛り（FV_SCALE 24 と較正のずれ）

勝率の較正 S=435・offset +34cp（`src/usi/parse.ts`）は、開発機のやねうら王（FV_SCALE 16）で
41 手目局面の実勝敗から取ったもの。**A の実行ファイルは FV_SCALE 24 なので、同じ局面で cp が
1.5 倍大きく出る。** 何もしないと勝率が過大に振れる（+300cp が 71% ではなく 78% に見える）。

対処は 2 段:

1. **まず一次近似で吸収する。** エンジンごとに「評価値の倍率」を持ち、水匠5 A と、B で `FV_SCALE 24` に
   したものは 24/16 = 1.5 とする。勝率の換算は `cp / 1.5` に S=435・+34 を当てる（S=652・+51 と同じ）。
   `score cp` の表示はエンジンが出した値のまま。B で `FV_SCALE 16` を送れば倍率 1 で開発機と同じになるが、
   公式の推奨（24）から外れるので既定にしない。
2. **一度だけ較正し直す。** 開発リポジトリの 41 手目局面 5,569 件（`data/cp_ply41.npz` の SFEN）を
   水匠5 A で 10k ノード採点し、開発機の cp との線形関係（傾きが 1.5 か）と、実勝敗に対する
   S・offset を出す。1 分ほどの CPU 仕事。**マシンを使ってよいと言われたときに回す。**
   勝敗は必ずアリーナ JSON の `games[].result` から取る（`win` 列ではない）。

### 7.5 41 手目の切り替え

いまは検討エンジンを利用者が選ぶ。水匠5が自動登録されたら、**検討は局面で自動に切り替える**:
1〜40 手目は内蔵の布石評価（第 4 節）、41 手目からは水匠5。利用者が別のエンジンを選んだときだけ
その選択を尊重する。外部の布石エンジン（USI 拡張）が 41 手目以降を自分で中継する仕組みは
そのまま残すが、既定の経路では使わない。

### 7.6 ライセンス上の扱い

A の配布物には GPLv3 の全文（`Copying.txt`）と `source.rar` が同梱されている。実行ファイルは
やねうら王の派生物として GPL で配られており、評価関数はそれに埋め込まれている。埋め込まれた
評価関数そのものに独立のライセンス表記は無い。**このアプリは水匠5を再配布しない**（利用者が
置く）ので、必要なのは「利用者が自分で入手して置く」案内だけで、ライセンス表記の義務は生じない。
開発リポジトリの `THIRD_PARTY.md` の判断（配らない）と同じ。

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
