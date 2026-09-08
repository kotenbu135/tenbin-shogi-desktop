# 布石 USI 拡張（仕様 v0）

2026-09-08。エンジンと GUI を切り離すための約束事。既存の USI に**最小の語彙**を足す。
開発リポジトリ（fuseki-shogi-ai）の dlshogi フォークにある `position fuseki` を出発点にする。

## 目的

- 布石中（1〜40手目）の局面をエンジンに運び、**候補ごとの評価**を受け取る
- 41手目以降は素の USI。市販の GUI からもそのまま使える
- GUI はルールも評価も持たない。持つのは表示と、wasm による入力の合法性チェックだけ

## 局面

```
position fuseki
position fuseki moves K*5i K*5a P*7g P*3c ...
position sfen <41手目のSFEN> moves 7g7f ...      # 通常フェーズ（素の USI）
```

- 布石の指し手は駒打ち表記 `X*sq`。打つ駒の文字は手番に関わらず大文字（`Move::toUSI()` と同じ）。
- 天秤将棋の「先後の選択」`choose:sente` / `choose:gote` は**エンジンに送らない**。
  盤面も手番も変えないので、エンジンは知らなくてよい。GUI の棋譜にだけ残す。
  （送られた場合に備えて、エンジンは `choose:` で始まる語を読み飛ばすのが望ましい。
  現行のフォークは解釈できない語で再生を打ち切るので、そこは直す。）
- 40手完了時点でエンジンは 41手目の裁定（手番側が相手玉を取れるなら手番側の勝ち）を自分で判定する。
  裁定に当たる局面には `go` に対して `bestmove win` を返す（探索しない）。

## 思考

```
go infinite
go nodes N            # 通常フェーズはやねうら王へそのまま中継
go movetime T
stop
```

布石中の `go` は候補を評価して `info` を流し、`stop`（または規定量の計算が終わったら）`bestmove` を返す。

## 出力

```
info depth 1 multipv 1 score cp 118 winrate 0.612 pv P*7g
info depth 1 multipv 2 score cp  96 winrate 0.591 pv S*6h
info string phase fuseki ply 12 method value
bestmove P*7g
```

| 語 | 意味 |
|---|---|
| `score cp` | 手番側の擬似 cp。勝率を S=435・offset=+34cp の逆ロジスティックで変換したもの。既存 GUI が `score cp` を期待するため必ず出す |
| `winrate` | 手番側の勝率 0..1。布石拡張の独自語。自前 GUI はこちらを優先して読む |
| `pv` | 布石中は候補の1手だけ。`twoply` 以上なら応手を続けてよい |
| `info string phase ... method ...` | 表示の切り替え用。`phase` は `fuseki`/`normal`、`method` は下の方式名 |

勝率と cp の換算は GUI 側の設定と同じ式を使う（`src/usi/parse.ts` の `cpToWinrate`）。
**目盛りは「この分布の実勝率」で統一**する。cp を通常将棋の感覚で読まない。

## オプション

| `setoption name` | 値 | 既定 |
|---|---|---|
| `Fuseki_Method` | `value` / `twoply` / `rollout` | `value` |
| `Fuseki_Value_Model` | 価値ネットの ONNX パス | 同梱の既定 |
| `Fuseki_Rollouts` | `rollout` のロールアウト本数（候補ごと） | 8 |
| `Fuseki_Judge_Nodes` | `rollout` の審判（やねうら王）のノード数 | 10000 |
| `Normal_Engine` | 通常フェーズを中継するやねうら王の実行ファイル | 空（中継しない） |
| `Normal_EvalDir` | その EvalDir。各自が用意する | 空 |
| `MultiPV` | 布石中も同じ語で候補数を決める | 1 |

### 方式

| 方式 | 何をするか |
|---|---|
| `value` | 合法な打ち場所すべてを置いた直後の局面を1バッチで価値ネットに通す |
| `twoply` | 候補ごとに相手の応手すべてを評価し、最小値を候補の値にする |
| `rollout` | 候補ごとに方策で 41手目までロールアウトし、41手目の裁定を通してやねうら王で採点する。学習の終端採点と同じ |

## GUI 側の扱い（このリポジトリ）

- エンジン登録の「使える局面」で `布石にも対応` を選んだものだけが布石中に `go` を受ける。
  それ以外は 41手目以降だけ。布石中に選ぶと「布石中はこのエンジンでは評価できません」と出す。
- `info` は `winrate` があればそれを、無ければ `score cp` を換算して**先手の勝率**に直し、
  天秤グラフと候補表に載せる（`src/ui/analysis.ts`）。

## 実装（2026-09-08）

開発リポジトリ fuseki-shogi-ai の `scripts/fuseki_usi_server.py`。テストは `scripts/test_fuseki_usi_server.py`。

- `value` と `twoply` を実装。`rollout` は未実装（オプションは受けるが `value` で動く）
- 候補は方策（公開版と同じ `fuseki_degct_b3_iter1177.onnx`）の上位 `Fuseki_Candidates`（既定 16）手に絞ってから
  価値ネット `value_mid_v2_10x128`（GCT フリー）で採点する。合法手すべてを採点すると、方策が選ばない手の中から
  価値ネットの盲点を突く手が上に来る（開発リポジトリ `docs/plan-search-at-playtime.md` の食い破り）
- 天秤将棋（`Fuseki_Mode=tenbin`）の 1〜2 手目は玉だけを候補にし、2 手目は両玉の価値表 `king_pairs_iter1177_games.json` を引く
- `info` に独自語 `prior`（方策の確率）を足している。GUI は知らない語を読み飛ばす
- 40 手目の候補で後手玉が先手の利きに当たる形は勝率 0。41 手目の裁定に当たる局面の `go` は `bestmove win`
- 41 手目からは `Normal_Engine`（既定は開発リポジトリの vendor のやねうら王）へ中継

GUI への登録: 実行ファイル `fuseki-shogi-ai/.venv/bin/python`、引数 `scripts/fuseki_usi_server.py`、
作業フォルダ `fuseki-shogi-ai`、使える局面「布石にも対応」。

## 未決

- `Fuseki_Method=rollout` の所要時間と `value` との順位一致率は未計測（開発リポジトリ M3）。
- 41手目の段差（V(s_40) と p(cp_41) の差）は未計測（M0）。測ってから定数補正の有無を決める。
