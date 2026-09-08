# 天秤将棋デスクトップGUIの検討（新規プロジェクト）

2026-09-08。目的は3つ。

1. Webではないデスクトップの天秤将棋GUI（ShogiGUI・将棋所・ShogiHome の系統）を作る
2. **布石の段階から評価値を出す**
3. PCのスペック（16コア/32スレッド・RTX 5070 Ti）を使い切って**検討**できるようにする

本書は「何を作るか」「何で作るか」「何を先に測るか」を決めるための検討で、コードは書いていない。
既存ソフトの状況は 2026-09-08 時点の Web 調査（出典は末尾）。

---

## 0. 要点

- **GUI とエンジンを USI 拡張で切り離す。** 布石フェーズを扱える USI（`position fuseki`）は
  フォーク済みの dlshogi にすでにある。これを「布石中も `info ... score` を返す」まで伸ばせば、
  GUI は何で作ってもよくなり、41手目以降は市販 GUI からもそのまま使える。
- **布石中の「評価値」は価値ネット V(s_t) の手番側勝率を先手視点に直したもの**にする。
  41手目以降のやねうら王の cp は、41手目局面で実勝率に較正した式（S=435, offset +34cp）で
  勝率に直す。両者は「実際の勝敗」で較正された同じ量になるので、**目盛りが繋がる**。
  段差が残るかは既存の 77,642 局で先に測る（対局不要・GPU だけ）。
- **PC スペックの使い道は「深い検討」。** 即答の V に加えて、2手読み（K²）と
  「ロールアウトを 41 手目まで回してやねうら王で採点する」審判方式を GUI から選べるようにする。
  後者は学習で使っている終端採点そのもので、ブラウザでは絶対にできない。
- **GUI は Electron + TypeScript を推奨。** 公開版サイトの盤・布石・天秤の UI と cppshogi の
  wasm をそのまま持ち込める。ShogiHome（MIT）が同じ構成で成功しており、借りられるものが多い。
  Tauri でも成立し、フロントエンドは共通なので後から乗り換えられる。
- **ShogiHome のフォークは主経路にしない。** tsshogi の持ち駒に玉のスロットが無く、
  棋譜モデルにフェーズや「先後の選択」が無い。3,500 コミットの本体に手を入れると上流に追随できない。
- **GPU は当面 WSL 側で回す。** Windows の GUI から `wsl.exe` でエンジンを起動すれば、
  いま動いている CUDA 13.1 + TensorRT の環境をそのまま使える。配布版は ふかうら王と同じく
  CPU / DirectML / TensorRT の3系統に分ける。

---

## 1. 「布石中の評価値」を何と定義するか

前回の整理（4つの壁）を、デスクトップでどう越えるかに読み替える。

| 壁 | 中身 | 越え方 |
|---|---|---|
| 配線 | 布石中は `Position` が無く SFEN が作れない | エンジン側が `FusekiPosition` を持つ。USI は `position fuseki moves ...` で既に通る |
| 非合法 | 40手完了時に 13.7% で相手玉が取れる。やねうら王には渡せない | 布石中はやねうら王に渡さない。価値ネットはこの分布で学習しているので問題ない |
| 別のゲーム | 未配置の駒を通常将棋の持ち駒と見なすと値付けが狂う | 同上。やねうら王を使うのは 41 手目の裁定を通した局面だけ |
| 価値ヘッド無し | 公開ネットは方策のみ | 中間局面の価値ネット `value_mid_v2_10x128`（GCT フリー・12.75MB）を使う |

### 何を「評価」と呼ぶか（フェーズごと）

| フェーズ | 手 | 出すもの | 源 |
|---|---|---|---|
| 両玉 | 1〜2 | 玉の組の先手勝率 V(kb, kw)、置く候補ごとの値 | `king_pairs_*.json`（価値表） |
| 選択 | choose | どちらを持つと有利か（同じ V） | 同上 |
| 布石 | 3〜40 | 現局面の勝率 V(s_t)。候補（合法な打ち場所すべて）ごとの V(s_{t+1}) | 価値ネット |
| 通常 | 41〜 | やねうら王の cp と MultiPV | やねうら王 |

価値ネットの held-out AUC（`docs/plan-search-at-playtime.md`）:

| 手番 t | AUC |
|---|---|
| 2〜5 | 0.590 |
| 10〜13 | 0.617 |
| 18〜21 | 0.689 |
| 26〜29 | 0.776 |
| 34〜39 | 0.798 |

序盤は弱い。**弱いことを画面で隠さない**（信頼帯を出す。後述）。

### 目盛りを統一する

- 価値ネットは実際の勝敗で学習した**手番側の勝率**を出す。先手視点に直してグラフに載せる。
- やねうら王の cp は 41 手目局面 4,765 局で較正済み（`yaneuraou_scorer.py` のコメント。
  ロジスティック **S=435、offset +34cp**）。これで cp を「実勝率」に直す。
- 両方が「この分布の実勝率」の推定になるので、41 手目で量が変わらない。
- 数字としての「評価値」が欲しい人向けに、勝率を同じ S で逆変換した擬似 cp を併記する
  （ShogiHome も勝率⇄評価値の係数を設定で持っている。同じ流儀）。

**残る段差は測ってから決める。** 既存 77,642 局の held-out で、40 手完了局面の V と
41 手目の較正済み p(cp) の差の分布を出す。平均差が数 pt なら V 側に定数補正、
広がりが大きいなら「41 手目の印」をグラフに入れて段差を正直に見せる。
この検証は GPU と既存ログだけで済み、対局を1局も要らない。

---

## 2. 既存ソフトの現状（2026-09-08 時点）

### GUI

| ソフト | 最新 | 基盤 | ライセンス | 検討まわり | 変則ルール |
|---|---|---|---|---|---|
| 将棋所 | 5.7.0 | Windows / .NET | 非公開 | USI の事実上の参照実装。検討・棋譜解析・グラフ | 不可 |
| ShogiGUI | 0.0.8.8（2026-07-01） | Windows | 非公開 | **複数エンジン同時検討**、MultiPV 10、線形/非線形グラフ、Web 棋譜取込、矢印表示 | 不可 |
| ShogiHome（旧 Electron 将棋） | 1.29.0（2026-08-01） | Electron + Vue 3 + tsshogi | **MIT** | 検討・連続解析・評価値グラフ・勝率換算係数の設定・**レイアウトを JSON で定義**・分岐ツリー・次の一手作成・.ybb 定跡・CSA 通信 | 不可（局面編集はある） |
| MyShogi（将棋神やねうら王） | 停滞 | C# / Windows | オープン | やねうら王向け | 不可 |
| lishogi | 継続 | Web | オープン | Fairy-Stockfish / やねうら王で解析 | minishogi 等。中将棋は解析エンジン無し |
| cshogi | 1.0.4 | Python | MIT | Flask の簡易 Web 表示 | ライブラリ |

読み取れること:

- 「布石つき」を扱える GUI は存在しない。**ルールを持つのは常にエンジン側**で、
  GUI は SFEN と USI の指し手しか知らない。この分業を壊さないのが正しい。
- ShogiHome だけがオープンかつ現役で、やねうら王の作者も「エンジン側から見て望ましい設計」と評価している。
  拡張機能の設計文書（2022-11。子プロセスに JSON でイベントを流す案）はあるが、
  渡るのは `{{position.usi}}` だけで、布石の状態は運べない。issue 本体は取得できず、実装の有無は未確認。
- ShogiGUI の「複数エンジンで同時検討」は、天秤将棋なら「価値ネット即答」と「審判方式」を並べる形で
  そのまま真似できる。

### エンジンと推論基盤

| もの | 状況 |
|---|---|
| やねうら王 | V9.70（2026-07-31）。NNUE/SFNN の形状拡張、複数定跡、`.ybb`。V9.20 で halfKA 系対応 |
| ふかうら王（dlshogi 互換） | V9.40（2026-06-03）。配布は **ORT-CPU / ORT-DirectML / TensorRT** の3系統、Windows のみ |
| dlshogi | 最終リリース 2024-05（WCSC32 版）。リポジトリは 2026-09-05 に push あり |
| 水匠 | 水匠 11 系が WCSC36。開発版は支援者向け配布。**本プロジェクトは水匠 5 を採点器に固定**（変えると測定の基準が取り直し） |
| onnxruntime-node | 1.29.0。**Windows は DirectML / WebGPU、Linux は CUDA / TensorRT**。Electron で backend 検出に失敗した事例あり |
| onnxruntime-web | 1.29.0。公開版サイトが wasm EP で使用中 |
| TensorRT-RTX EP | Ampere 以降の RTX 向けの新しい EP。JIT で起動が速い。**まだソースビルドのみ**（PyPI/NuGet は予告） |
| RTX 50（sm_120）× Windows | TensorRT 10.8 で未対応エラーの報告。onnxruntime-gpu の Windows 対応も issue（2026-03）で問い合わせ中 |
| この WSL | CUDA 13.1、TensorRT（dlshogi の usi バイナリが `-lnvinfer` でビルド済み）、torch CUDA 動作中。venv の onnxruntime は CPU のみ |

### 変則将棋の前例: Fairy-Stockfish

`variants.ini` に **`mustDrop`（持ち駒がある間は打つしかない）、`dropRegionWhite/Black`（打てる範囲）** があり、
シットゥインの「配置フェーズ」はこれで表現されている。布石将棋の骨格（20 枚を自陣 4 段に交互に打つ）は
書ける。しかし:

- 「筋の 4 マスを非歩で埋める手の禁止」「40 手目の制限」「41 手目の裁定」は表現できない
- 玉を持ち駒から打つ形は想定外（王手判定が玉の存在を前提）
- 評価は汎用で、この配置分布を学習していない

**近い前例はあるが、天秤将棋のルールと評価は自前エンジンが要る**という判断は変わらない。

### デスクトップの枠組み

| 枠組み | 最新 | 向き |
|---|---|---|
| Electron | 44.2.0 | JS/TS 一枚で済む。ShogiHome の前例。onnxruntime-node を main プロセスに入れられる |
| Tauri | 2.11.5（2026-07-01） | 小さく速い。サイドカー（`externalBin` + shell plugin）で stdio 接続。Rust が要る |

2026 年の一般論は「新規なら Tauri」だが、本件は**エンジンが別プロセス**なので枠組みの差は小さい。

---

## 3. 手元の資産（作らなくてよいもの）

| 資産 | 場所 | 使い道 |
|---|---|---|
| 布石のルール・特徴量（C++） | `engine/dlshogi/cppshogi/fuseki.*` | エンジンと GUI の両方の真実。wasm 化済み |
| wasm ビルド | `fuseki-shogi-web/wasm/build.sh` | GUI の合法手・禁じ手・特徴量。**TS で書き直さない**（ズレると方策が劣化する） |
| USI `position fuseki` | `engine/dlshogi/usi/main.cpp` | 布石中の局面をエンジンに運ぶ入口。`goFuseki` は方策サンプリングのみ |
| 方策ネット（GCT フリー） | `fuseki_degct_b3_iter1177.onnx` | 候補の事前確率、ロールアウト |
| 価値ネット（GCT フリー） | `models/value_mid_v2_10x128.onnx`（12.75MB）、6x64（2.42MB） | 布石中の評価 |
| 両玉の価値表 | `king_pairs_iter1177_games.json` | 1〜2 手目と選択 |
| best-of-K 探索 | `scripts/search_sim.py`、公開版 `policy.js` | 候補列挙と V での順位づけ |
| やねうら王プール | `scripts/yaneuraou_scorer.py`（USI_Hash 64MB、1本 176MB） | 審判方式の採点、通常フェーズ |
| cp→勝率の較正 | S=435 / offset +34cp（41 手目 4,765 局） | 目盛りの統一 |
| USI クライアント | `webapp/backend/engine_client.py`、`scripts/fuseki_arena.py` | 別スレッド readline 方式。select の罠を踏み済み |
| 盤・布石・天秤の UI | `fuseki-shogi-web/src/{board,fuseki,kings,game,heat,i18n}.js` | GUI の中身。評価グラフも第2弾で実装済み |
| 棋譜の書式 | `K*5i K*5a choose:sente ...`（`game.js`） | 天秤将棋の棋譜。エンジンは `choose:` を読み飛ばせばよい |

---

## 4. 設計

### 4.1 最重要の決定: エンジンと GUI を USI 拡張で切る

GUI にルールも評価も持たせない。持たせると、Web 版・アリーナ・学習と**4 つ目の実装**が生まれ、
ズレの検出に対局が要るようになる。GUI が持つのは「表示」と「wasm による入力の合法性チェック」だけ。

分ける利点:

- エンジンは Python で今日書き始められる（既存スクリプトの組み合わせ）。速さが要るときだけ C++ に下ろす
- 41 手目以降は普通の USI なので、**ShogiHome / ShogiGUI に SFEN を貼れば市販 GUI でも検討できる**（追加コストゼロ）
- GUI の枠組み（Electron / Tauri）は後から替えられる
- GPL（dlshogi・やねうら王）はエンジンのプロセスに閉じる。GUI は wasm を含む時点で GPL になるが、公開版サイトが既に GPL-3.0-only なので変わらない

### 4.2 布石 USI 拡張（案）

既存の `position fuseki` を伸ばす。新しい語彙は最小にする。

```
position fuseki moves K*5i K*5a choose:sente P*7g P*3c ...
go infinite            # 布石中も受ける
go nodes 20000         # 通常フェーズはそのまま やねうら王 に転送
info depth 1 multipv 1 score cp 118 winrate 0.612 pv P*7g
info depth 1 multipv 2 score cp  96 winrate 0.591 pv S*6h
info string phase fuseki ply 12 method value    # 表示の切り替え用
bestmove P*7g
```

- `choose:sente|gote` は**エンジンは読み飛ばす**（盤面も手番も変わらない）。
  現状のパーサは解釈できないトークンで再生を打ち切るので、明示的に skip を足す。
- `score cp` は勝率を S=435 で逆変換した擬似 cp。既存 GUI のパーサが `score cp` を期待するため。
  `winrate` は独自語で、自前 GUI だけが読む。
- `setoption`:
  - `Fuseki_Method` = `value` | `twoply` | `rollout`（後述の検討方式）
  - `Fuseki_Value_Model`、`Fuseki_Rollouts`、`Fuseki_Judge_Nodes`（審判のノード数。既定 10k）
  - `Normal_Engine` = やねうら王のパス（通常フェーズは USI をそのまま中継する）
- エンジンは 1 プロセスで両フェーズを受け、41 手目で内部的にやねうら王へ切り替える。
  GUI からは「1 本の USI エンジン」に見える。ShogiGUI の複数エンジン検討のように
  **同じエンジンを方式違いで 2 本起動**すれば、即答と審判を並べられる。

### 4.3 検討の方式（PC スペックの使い道）

| 方式 | 何をするか | 計算量 / 1局面 | 向き |
|---|---|---|---|
| `value` | 合法な打ち場所すべて（最大約 250）を置いた直後の局面を **1 バッチで** V に通す | 前向き計算 ≤250 回。GPU なら一瞬 | 即答。グラフの線 |
| `twoply` | 候補ごとに相手の応手すべてを V で評価し、min を取る | ≤ 250² ≈ 6 万回。GPU バッチで数百 ms 級の見込み（**未計測**） | 悪手弾きの精度を上げる |
| `rollout` | 候補ごとに方策で 41 手目までロールアウト R 本、41 手目の裁定を通し、**やねうら王 10k ノードで採点** | R × 候補 × 10k ノード。32 スレッドで並列 | 学習の終端採点そのもの。最も信用できるが遅い |

`rollout` は「V の食い破り」に対する保険でもある。対局時探索の実測で、V を強く最適化すると
K=8 を越えて勝率が**下がる**ことが3回別々の形で観測されている（`docs/plan-search-at-playtime.md`）。
検討でも「V が高いが実際には勝てない配置」を上位に出す危険があるので、
**上位候補だけ `rollout` で裏を取る**のを既定の重い設定にする。

信頼帯: V の AUC は序盤 0.59。候補間の差が V の分解能より小さいときは「差なし」と表示する。
閾値は held-out の較正表（`eval_value_net.py` が出す）から取る。

通常フェーズはやねうら王の MultiPV をそのまま出す。ノード数・スレッド数は GUI から渡す。

### 4.4 GUI の実装方式

| 案 | 中身 | 利点 | 欠点 |
|---|---|---|---|
| A. ShogiHome をフォーク | Vue 3 + tsshogi に布石フェーズを足す | 検討・棋譜・レイアウト・通信対局が最初からある | tsshogi の `Hand` に玉のスロットが無い（確認済み）。`Record`/USI にフェーズと選択が無い。本体 3,500 コミットへの改変で上流に追随できなくなる |
| **B. Electron + 公開版 UI（推奨）** | 公開版 `src/` と wasm をそのまま renderer に、main で USI プロセス管理 | UI・ルール・i18n・評価グラフを再利用。ShogiHome の前例と MIT コードを参照できる。onnxruntime-node を予備の推論に使える | バンドルが大きい。Linux 開発は WSLg で動くが確認は要る |
| C. Tauri + 公開版 UI | 同上をサイドカーで | 小さく速い。プロセス管理が Rust で堅い | Rust の toolchain を新たに持つ。Linux の WebKitGTK は Chromium と挙動が違う。onnxruntime を in-process に置けない |
| D. Python バックエンド + 薄い殻 | `webapp/backend`（FastAPI）を拡張し、pywebview 等で包む | 分析コードが全部 Python なので最短 | 配布が重い（CUDA 込みの PyInstaller）。2 つのランタイム |

B を推す理由は、動く UI がすでに JS で存在し、ShogiHome が同じ構成で成功しているから。
C との差はフロントエンドに無く、プロセス管理層だけ。**B で始めて C に移る費用は小さい**。
D はエンジン側（4.2）として吸収する。GUI としては採らない。

再利用の境界: 公開版の `game.js` は勝敗と棋譜を持ち、`main.js` が画面遷移と AI 呼び出しを持つ。
デスクトップでは AI 呼び出しを USI クライアントに差し替え、`policy.js`（onnxruntime-web）は
オフライン時の予備として残す。

### 4.5 GPU の現実

- **この PC**: Windows の GUI から `wsl.exe -d Ubuntu-24.04 -- <エンジン>` で起動し stdio を繋ぐ。
  CUDA 13.1 + TensorRT + sm_120 は WSL でいま動いている。移植ゼロ。
- **配布版**: ふかうら王 V9.40 の配り方（ORT-CPU / ORT-DirectML / TensorRT）が答え。
  DirectML は DX12 の GPU なら何でも動く。RTX 50 の Windows TensorRT は版に注意
  （10.8 で sm_120 未対応の報告）。TensorRT-RTX EP は将来の本命だが、いまはソースビルドのみ。
- 価値ネット 10x128 は 12.75MB。CPU でも `value` 方式（≤250 回の前向き）なら実用速度の見込み。
  `twoply` と `rollout` は GPU / 多コアが効く。

### 4.6 ライセンス

| 部品 | ライセンス | 影響 |
|---|---|---|
| dlshogi フォーク（cppshogi・usi） | GPL-3.0 | エンジンと wasm は GPL |
| やねうら王 | GPL-3.0 | 別プロセス。同梱配布時は GPL 表記 |
| 水匠 5 `nn.bin` | 配布条件を同梱前に再確認 | 現状は `vendor/yaneuraou_eval` にある |
| ShogiHome / tsshogi | MIT | 借用は自由。著作権表示のみ |
| 学習済み重み | GCT 由来を排除済み（`docs/degct_plan.md`） | 公開版と同じ重みだけを載せる |

---

## 5. ロードマップ

学習は 2026-09-30 まで回し続ける方針（CPU を止めない）。**M0〜M2 は CPU を要らない**。
アリーナ級の測定（M3 の審判方式の速度と一致率）は 9/30 以降か、学習と同居できる `--jobs 8` 相当で回す。

| 段 | 成果物 | 測ること（合否） |
|---|---|---|
| M0 設計 | 4.2 の USI 拡張仕様を `docs/` に固定。41 手目の段差の較正（既存 77,642 局、GPU のみ） | V(s_40) と p(cp_41) の差の平均と標準偏差。平均差が 3pt 超なら定数補正を入れる |
| M1 エンジン（Python） | `scripts/fuseki_usi_server.py`。`value` / `twoply`、`choose:` の読み飛ばし、41 手目でやねうら王へ中継。`test_fuseki_usi.py` 相当のテスト | 布石 40 手 + 通常 10 手を USI 往復で通す。`value` の応答が 100ms 未満（GPU） |
| M2 GUI 骨格 | Electron。公開版 UI の移植、エンジン登録、対局/検討モード、勝率グラフ（フェーズ印つき）、候補一覧 | 天秤将棋 1 局を最初から最後まで検討つきで指せる。棋譜の保存と読み込み（自前書式） |
| M3 深い検討 | `rollout` 方式、上位候補の裏取り、MultiPV、ノード/スレッド指定。WSL 経由の GPU | `rollout` の順位と `value` の順位の一致率（上位 3 候補）。1 局面の所要時間 |
| M4 配布 | Windows ネイティブ（DirectML）ビルド、インストーラ、KIF 書き出し（布石は独自拡張）、C++ への下ろし（必要なら） | 別 PC で起動して 1 局指せる |

M1 は既存スクリプトの再配線なので、着手から動くまでが短い。**GUI より先にエンジンを動かす**。
エンジンが動けば、M2 の前に ShogiHome で 41 手目以降の検討が試せる。

---

## 6. リスクと未決

- **序盤の評価は弱い**（AUC 0.59）。数字を出すこと自体が「もっともらしい嘘」になりうる。
  信頼帯の表示と、`rollout` で裏を取る導線を最初から入れる。
- **食い破り**。検討の上位が「V を騙す配置」になっていないかは、`rollout` との一致率で監視する。
- **41 手目の段差**。M0 で測るまで大きさが分からない。測ってから表示方針を決める。
- **Windows の GPU**。RTX 50 × TensorRT の版依存。当面は WSL 経由で逃げる。
- **水匠 5 の同梱可否**。配布前に条件を確認する。
- **ブラウザ版との関係**。`value` 方式だけなら公開版に 2.4MB の 6x64 を足せば載る。
  デスクトップ固有の価値は `twoply` / `rollout` / MultiPV / 多コアなので、
  公開版に `value` を先に載せて反応を見る手もある（本書の範囲外）。

---

## 出典

- ShogiGUI: https://shogigui.siganus.com/ / https://shogigui.siganus.com/download.html
- 将棋所: https://softaro.jp/shogidokoro/ / USI: http://shogidokoro.starfree.jp/usi.html
- ShogiHome: https://sunfish-shogi.github.io/shogihome/ / https://github.com/sunfish-shogi/shogihome / リリース API（v1.29.0 2026-08-01）
- ShogiHome カスタムレイアウト: https://note.com/ryosuke_kubo/n/n0008cb4f87ca
- Electron 将棋の拡張機能設計（2022-11）: https://gist.github.com/sunfish-shogi/6ff7bae2fc81e819b5f620206ca89d51
- やねうら王による Electron 将棋の評価: https://yaneuraou.yaneu.com/2024/06/08/electron-shogi-is-amazing/
- USI の現状調査（sunfish-shogi）: https://qiita.com/sunfish-shogi/items/3efcd3a727c04ada020d
- tsshogi: https://github.com/sunfish-shogi/tsshogi（`src/hand.ts` に玉なし）
- やねうら王 更新履歴 2026: https://github.com/yaneurao/YaneuraOu/wiki/やねうら王の更新履歴2026
- やねうら王リリース（ふかうら王 V9.40 の配布物）: https://github.com/yaneurao/YaneuraOu/releases
- WCSC36 と水匠 11: https://yaneuraou.yaneu.com/2026/05/07/wcsc36-petashock-suisho11/
- dlshogi リリース: https://github.com/TadaoYamaoka/DeepLearningShogi/releases
- dlshogi の評価値スケール: https://tadaoyamaoka.hatenablog.com/entry/2021/10/19/230601
- Fairy-Stockfish variants.ini（`mustDrop` / `dropRegion`）: https://github.com/fairy-stockfish/Fairy-Stockfish/blob/master/src/variants.ini
- Fairy-Stockfish placement issue #10: https://github.com/ianfab/Fairy-Stockfish/issues/10
- lishogi の解析エンジン: https://lishogi.org/blog/post/YvWYwxEAACIAFxSZ / https://lishogi.org/forum/lishogi-feedback/chushogi-analysis
- cshogi: https://github.com/TadaoYamaoka/cshogi
- onnxruntime-node（EP の OS 別対応）: https://www.npmjs.com/package/onnxruntime-node / Electron での不具合: https://github.com/microsoft/onnxruntime/issues/17678
- TensorRT-RTX EP: https://onnxruntime.ai/docs/execution-providers/TensorRTRTX-ExecutionProvider.html
- RTX 50 × Windows onnxruntime-gpu: https://github.com/microsoft/onnxruntime/issues/27875
- TensorRT 10.8 sm_120 未対応: https://forums.developer.nvidia.com/t/tensorrt-10-8-on-windows-api-usage-error-target-gpu-sm-120-is-not-supported-by-this-tensorrt-release/323431
- Tauri サイドカー: https://v2.tauri.app/develop/sidecar/ / リリース: https://tauri.app/release/core/
- Tauri vs Electron 2026: https://www.buildmvpfast.com/blog/tauri-v2-vs-electron-desktop-apps-2026
- npm 最新版（registry API、2026-09-08）: electron 44.2.0 / onnxruntime-node 1.29.0 / onnxruntime-web 1.29.0 / tsshogi 2.3.4
