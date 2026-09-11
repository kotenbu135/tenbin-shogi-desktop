// 画面の文言。日本語と英語の2つを持ち、設定 `lang` で選ぶ。
//
// 公開サイト（fuseki-shogi-web の src/i18n.js）と同じ形にしてある。辞書は
// { 鍵: { ja, en } } で、引くのは t()。鍵は型で縛ってあるので、綴りを間違えると
// tsc が落ちる＝訳し漏れの検査になる。用語（Balance Shogi / Sente / Gote、
// 「玉を置く」「先後を選ぶ」の言い回し）はサイト側の訳をそのまま使う。
//
// 訳さないもの:
//   * KIF の中身（見出しも符号も日本語が書式。将棋所・ShogiHome で開けなくなる）
//   * ソースの注釈（製品が英語を話せばよく、コードを英語にする話ではない）
//
// 言語を切り替えると窓を読み込み直す（main.ts）。組み立て直しの効かない部品
// （検討の枠はエンジンを抱えている）があるので、作り直すほうが確かなため。

export type Lang = 'ja' | 'en';

type Entry = { ja: string; en: string };

const DICT = {
  // ---- 共通の語 ----
  app_name: { ja: '天秤将棋GUI', en: 'Balance Shogi GUI' },
  side_sente: { ja: '先手', en: 'Sente' },
  side_gote: { ja: '後手', en: 'Gote' },
  draw: { ja: '引き分け', en: 'Draw' },
  cancel: { ja: 'やめる', en: 'Cancel' },
  close: { ja: '閉じる', en: 'Close' },
  ok: { ja: 'OK', en: 'OK' },

  // ---- 棋譜の手・終局（state/game.ts） ----
  move_take_sente: { ja: '先手を持つ', en: 'Takes Sente' },
  move_take_gote: { ja: '後手を持つ', en: 'Takes Gote' },
  move_resign: { ja: '投了', en: 'Resigns' },
  move_timeout: { ja: '切れ負け', en: 'Time forfeit' },
  over_resign: { ja: '{side}の投了', en: '{side} resigns' },
  over_timeout: { ja: '{side}の時間切れ', en: '{side} loses on time' },
  over_ruling41: {
    ja: '41手目の裁定（後手玉が先手の利きに当たっている）',
    en: 'Move-41 ruling (the Gote king stands in Sente’s attack)',
  },
  over_mate: { ja: '詰み', en: 'Checkmate' },
  over_other: { ja: '終局', en: 'Game over' },
  err_game_over: { ja: '対局は終わっている', en: 'The game is already over' },
  err_not_choose: { ja: 'いまは先後を選ぶ場面ではない', en: 'Not the moment to pick a side' },
  err_choose_format: { ja: '選択の書式が違う: {token}', en: 'Malformed choice: {token}' },
  err_choose_first: { ja: '先に先手か後手かを選ぶ', en: 'Pick Sente or Gote first' },
  err_illegal_drop: { ja: '合法な駒打ちではない: {token}', en: 'Not a legal placement: {token}' },
  err_illegal_move: { ja: '合法手ではない: {token}', en: 'Not a legal move: {token}' },
  err_read_position: { ja: '局面を読めない: {msg}', en: 'Cannot read the position: {msg}' },
  err_read_41: { ja: '41手目の局面を読めない: {msg}', en: 'Cannot read the move-41 position: {msg}' },
  err_rewind: { ja: 'wasm の局面を戻せない: {usi}', en: 'Cannot rewind the wasm position: {usi}' },

  // ---- 局面の案内（下の帯） ----
  st_place_sente: { ja: '置く人が、先手陣に先手玉を置きます', en: 'The placer puts the Sente king in Sente’s camp' },
  st_place_gote: { ja: '続けて、後手陣に後手玉を置きます', en: 'Now the Gote king, in Gote’s camp' },
  st_choose: { ja: '選ぶ人が、先手を持つか後手を持つかを決めます', en: 'The chooser decides whether to take Sente or Gote' },
  st_fuseki: { ja: '布石 {n}手目 · {turn}が置きます（残り {left}手）', en: 'Placement, move {n} · {turn} places ({left} to go)' },
  st_normal: { ja: '本将棋 {n}手目 · {turn}番', en: 'Shogi, move {n} · {turn} to play' },
  st_over: { ja: '終局 · {result}（{reason}）', en: 'Game over · {result} ({reason})' },
  st_past: { ja: '{phase} · 過去の局面（→ か End で最新へ）', en: '{phase} · past position (→ or End for the latest)' },
  st_paused: { ja: '{phase} · 一時停止中（「再開」で続きます）', en: '{phase} · paused (press Resume to continue)' },
  win_of: { ja: '{side}の勝ち', en: '{side} wins' },
  kifu_viewing: { ja: '{n}手目の局面を表示中', en: 'Showing the position after move {n}' },

  // ---- 役と対局の名前 ----
  // 役の名前は付けない（「置く人」「選ぶ人」でなく、していることで呼ぶ）
  role_placer: { ja: '玉を置く', en: 'places the kings' },
  role_chooser: { ja: '先後を選ぶ', en: 'picks the side' },
  name_with_role: { ja: '{name}（{role}）', en: '{name} ({role})' },
  game_tenbin: { ja: '天秤将棋', en: 'Balance Shogi' },
  game_fuseki: { ja: '布石将棋', en: 'Fuseki Shogi' },
  game_normal: { ja: '本将棋', en: 'Shogi' },
  game_normal_pos: { ja: '本将棋（任意の局面から）', en: 'Shogi (from a set position)' },

  // ---- 棋譜の欄の脇 ----
  branch_btn: { ja: 'この局面から指し直す', en: 'Play on from here' },
  branch_confirm: {
    ja: '{n}手目以降の {k} 手を消して、ここから指し直しますか',
    en: 'Discard the {k} moves after move {n} and play on from here?',
  },
  result_head: { ja: '終局', en: 'Game over' },
  result_hint: {
    ja: '棋譜解析で振り返るか、局面を選んで検討できます',
    en: 'Review it with game analysis, or pick a position and analyse it',
  },
  choose_prompt: {
    ja: '両玉が置かれました。選ぶ人はどちらを持ちますか。',
    en: 'Both kings are placed. Which side does the chooser take?',
  },
  choose_sente_btn: { ja: '☗ 先手を持つ', en: '☗ Take Sente' },
  choose_gote_btn: { ja: '☖ 後手を持つ', en: '☖ Take Gote' },
  chosen_note: { ja: '選ぶ人は{side}を持ちました', en: 'The chooser took {side}' },

  // ---- ツールバー ----
  tb_new: { ja: '新しい対局', en: 'New game' },
  tb_new_title: { ja: '新しい対局（Ctrl+N）', en: 'New game (Ctrl+N)' },
  tb_undo: { ja: '待った', en: 'Take back' },
  tb_undo_title: { ja: '待った・1 手戻す（Backspace）', en: 'Take back one move (Backspace)' },
  tb_resign: { ja: '投了', en: 'Resign' },
  tb_resign_title: { ja: '投了', en: 'Resign' },
  tb_pause: { ja: '一時停止', en: 'Pause' },
  tb_resume: { ja: '再開', en: 'Resume' },
  tb_pause_title: { ja: 'エンジンの思考と時計を止める（Space）', en: 'Stop the engines and the clock (Space)' },
  tb_flip: { ja: '盤面反転', en: 'Flip board' },
  tb_flip_title: { ja: '盤面反転（F）', en: 'Flip the board (F)' },
  tb_edit: { ja: '局面編集', en: 'Edit position' },
  tb_open: { ja: '開く', en: 'Open' },
  tb_open_title: {
    ja: '棋譜を開く（Ctrl+O）。貼り付け（Ctrl+V）でも読み込めます',
    en: 'Open a game record (Ctrl+O). Pasting (Ctrl+V) works too',
  },
  tb_save: { ja: '保存', en: 'Save' },
  tb_save_title: { ja: '棋譜を保存（Ctrl+S）。Ctrl+C で棋譜を写します', en: 'Save the game record (Ctrl+S). Ctrl+C copies it' },
  tb_setup: { ja: 'はじめに', en: 'Getting started' },
  tb_setup_title: { ja: 'はじめに（エンジンの入れ方・片づけ方）', en: 'Getting started (installing and removing engines)' },
  tb_engines: { ja: 'エンジン', en: 'Engines' },
  tb_engines_title: { ja: 'エンジンの登録（USI ログもここから）', en: 'Register engines (the USI log lives here too)' },
  tb_theme: { ja: 'テーマ', en: 'Theme' },
  tb_theme_title: { ja: '明るさを切り替える', en: 'Switch between light and dark' },
  tb_lang: { ja: 'English', en: '日本語' },
  tb_lang_title: {
    ja: '表示を英語に切り替える（読み込み直します）',
    en: '表示を日本語に切り替える / Switch the display to Japanese (reloads)',
  },
  confirm_lang: {
    ja: 'いまの対局を捨てて、表示の言葉を切り替えますか',
    en: 'Discard the current game and switch the display language?',
  },

  // ---- 棋譜の保存の窓 ----
  save_title: { ja: '棋譜を保存', en: 'Save the game record' },
  save_all: { ja: '対局全体（布石を含む）', en: 'The whole game (placement included)' },
  save_all_sub: {
    ja: 'このアプリで開ける KIF。布石の手と先後の選択も残る',
    en: 'A KIF this app can reopen; it keeps the placement moves and the side choice',
  },
  save_normal: { ja: '本将棋の部分だけ', en: 'The shogi part only' },
  save_normal_sub: {
    ja: '41手目の局面図から始まる普通の KIF。将棋所や ShogiHome で開ける',
    en: 'An ordinary KIF starting from the move-41 diagram; opens in Shogidokoro or ShogiHome',
  },
  kif_filter: { ja: 'KIF 棋譜', en: 'KIF game record' },

  // ---- 確かめ・知らせ ----
  confirm_new: { ja: 'いまの対局を捨てて新しく始めますか', en: 'Discard the current game and start a new one?' },
  confirm_paste: {
    ja: 'いまの対局を捨てて、貼り付けた棋譜を開きますか',
    en: 'Discard the current game and open the pasted record?',
  },
  confirm_resign: { ja: '{side}が投了しますか', en: 'Resign as {side}?' },
  confirm_promote: { ja: '{sq}へ 成りますか？（キャンセルで不成）', en: 'Promote on {sq}? (Cancel to decline)' },
  confirm_kifu_analysis: {
    ja: '対局中です。エンジンと解析で計算を取り合いますが、棋譜解析を始めますか',
    en: 'A game is running. Analysis and the engines will compete for CPU. Start the game analysis anyway?',
  },
  alert_not_your_turn: {
    ja: 'いまは相手の手番です。投げるなら「一時停止」してから押してください',
    en: 'It is the opponent’s turn. Press Pause first, then resign',
  },
  msg_no_kifu: { ja: '棋譜がまだありません', en: 'There is no game record yet' },
  msg_kifu_analysis_done: {
    ja: '棋譜解析: {n} 局面を {sec} 秒で評価しました',
    en: 'Game analysis: {n} positions evaluated in {sec} s',
  },
  msg_editor_hint: {
    ja: '局面編集中。駒を置いて「この局面から本将棋を始める」を押します',
    en: 'Editing the position. Place the pieces, then press “Start shogi from this position”',
  },
  msg_no_normal_kif: {
    ja: '本将棋がまだ始まっていないので、本将棋だけの棋譜は作れません',
    en: 'Shogi has not started yet, so there is no shogi-only record to save',
  },
  msg_save_tauri_only: { ja: '棋譜の保存は Tauri のアプリ内でだけできます', en: 'Saving works only inside the Tauri app' },
  msg_open_tauri_only: { ja: '棋譜を開くのは Tauri のアプリ内でだけできます', en: 'Opening works only inside the Tauri app' },
  msg_saved: { ja: '保存しました: {path}', en: 'Saved: {path}' },
  msg_opened: { ja: '開きました: {path}', en: 'Opened: {path}' },
  msg_kif_unreadable: { ja: '棋譜を読めない: {msg}', en: 'Cannot read the game record: {msg}' },
  msg_copied: { ja: '棋譜を写しました（Ctrl+V で他のソフトへ貼れます）', en: 'Record copied (Ctrl+V pastes it into other software)' },
  msg_copy_failed: { ja: '棋譜を写せません: {msg}', en: 'Cannot copy the record: {msg}' },
  msg_pasted: { ja: '貼り付けた棋譜を開きました（{n} 手）', en: 'Opened the pasted record ({n} moves)' },
  msg_paste_unreadable: { ja: '棋譜として読めません: {msg}', en: 'Not a readable game record: {msg}' },
  msg_settings_broken: {
    ja: '設定を読めなかったので既定のまま開いています（{msg}）。次に保存するとき、読めなかった設定は退避します',
    en: 'The settings could not be read, so defaults are in use ({msg}). The unreadable settings will be set aside on the next save',
  },
  msg_preview: {
    ja: 'ブラウザのプレビューです。盤と棋譜は動きますが、エンジンや棋譜のファイルは Tauri のアプリ内でだけ扱えます。',
    en: 'This is the browser preview. The board and the record work, but engines and record files need the Tauri app.',
  },
  msg_boot_failed: { ja: '起動できない: {msg}', en: 'Cannot start: {msg}' },
  msg_unexpected: { ja: '思わぬ失敗: {msg}', en: 'Unexpected failure: {msg}' },
  msg_builtin_loaded: {
    ja: '内蔵の布石評価: 方策 {policy} / 価値ネット {value}{kings}',
    en: 'Built-in placement evaluator: policy {policy} / value net {value}{kings}',
  },
  msg_builtin_kings: { ja: ' / 両玉の価値表', en: ' / king-pair table' },
  msg_builtin_failed: { ja: '内蔵の布石評価を読めない: {msg}', en: 'Cannot load the built-in placement evaluator: {msg}' },
  msg_models_loaded: {
    ja: '布石の模型 {name}（{dir}）: 方策 {policy} / 価値ネット {value}{kings}',
    en: 'Placement models {name} ({dir}): policy {policy} / value net {value}{kings}',
  },
  msg_models_no_kings: {
    ja: '布石の模型 {name}: 両玉の価値表を使えない（{msg}）。天秤将棋の 1〜2 手目は価値ネットで代用する',
    en: 'Placement models {name}: the king-pair table is unusable ({msg}); the first two moves of Balance Shogi fall back to the value net',
  },
  msg_models_failed: {
    ja: '布石の模型 {name}（{dir}）を読めない: {msg}',
    en: 'Cannot load placement models {name} ({dir}): {msg}',
  },

  // ---- 棋譜の欄 ----
  kifu_title: { ja: '棋譜', en: 'Record' },
  kifu_first: { ja: '最初へ', en: 'To the start' },
  kifu_prev: { ja: '1手戻る', en: 'Back one move' },
  kifu_next: { ja: '1手進む', en: 'Forward one move' },
  kifu_last: { ja: '最後へ', en: 'To the latest' },
  kifu_start_pos: { ja: '開始局面', en: 'Starting position' },
  phase_kings: { ja: '両玉', en: 'Kings' },
  phase_choose: { ja: '先後の選択', en: 'Side choice' },
  phase_fuseki: { ja: '布石', en: 'Placement' },
  phase_normal: { ja: '本将棋', en: 'Shogi' },
  phase_over: { ja: '終局', en: 'Game over' },

  // ---- グラフ ----
  graph_score: { ja: '評価値', en: 'Evaluation' },
  graph_winrate: { ja: '期待勝率', en: 'Win rate' },
  graph_title: { ja: '{kind}のグラフ', en: '{kind} graph' },
  graph_series_sente: { ja: '☗先手', en: '☗ Sente' },
  graph_series_gote: { ja: '☖後手', en: '☖ Gote' },
  graph_series_analysis: { ja: '検討', en: 'Analysis' },
  graph_current: { ja: '先手 {v}', en: 'Sente {v}' },
  graph_approx: { ja: '勝率からの換算', en: 'converted from the win rate' },

  // ---- USI ログ ----
  usi_log: { ja: 'USI ログ', en: 'USI log' },
  usi_clear: { ja: '消す', en: 'Clear' },
  usi_send_placeholder: { ja: 'エンジンへ送る行（例: isready）', en: 'A line to send to the engine (e.g. isready)' },
  usi_send: { ja: '送る', en: 'Send' },

  // ---- 盤 ----
  board_aria: { ja: '将棋盤', en: 'Shogi board' },
  hand_aria: { ja: '{side}の持ち駒 {role} {n}枚', en: '{side}’s hand: {role} ×{n}' },
  plate_thinking: { ja: '考え中', en: 'Thinking' },
  plate_to_move: { ja: '手番', en: 'To move' },
  plate_byoyomi: { ja: '秒読み {sec}', en: 'Byoyomi {sec}' },
  split_record: { ja: '棋譜の欄の幅', en: 'Width of the record pane' },
  split_bottom: { ja: '下の欄の高さ', en: 'Height of the bottom panes' },

  // ---- 下の欄の割りつけ ----
  tab_play: { ja: '候補手', en: 'Engine moves' },
  tab_analysis: { ja: '検討', en: 'Analysis' },
  tab_score: { ja: '評価値', en: 'Evaluation' },
  tab_winrate: { ja: '期待勝率', en: 'Win rate' },
  tabbar_title: {
    ja: 'タブは掴んで別の欄へ移せます（右クリックで配置の窓）',
    en: 'Drag a tab to another pane (right-click for the layout window)',
  },
  tab_drag_title: { ja: '{name}（掴んで別の欄へ移せます）', en: '{name} (drag it to another pane)' },
  pane_edge: { ja: '欄の境', en: 'Pane divider' },
  layout_title: { ja: '下の欄の配置', en: 'Bottom pane layout' },
  layout_hint: {
    ja: 'タブは掴んで別の欄へ移せます。欄の境と、盤・棋譜・下の欄の仕切りは掴むと動きます。',
    en: 'Drag tabs between panes. The pane dividers and the board / record / bottom splitters can be dragged too.',
  },
  layout_preset1: { ja: '1 欄', en: '1 pane' },
  layout_preset2: { ja: '2 欄（検討｜グラフ）', en: '2 panes (analysis | graph)' },
  layout_preset3: { ja: '3 欄', en: '3 panes' },
  layout_reset: { ja: '既定の配置に戻す', en: 'Back to the default layout' },
  layout_same_pane: { ja: '同じ欄', en: 'the only pane' },
  layout_nth_pane: { ja: '左から {n} 番目の欄', en: 'pane {n} from the left' },
  layout_move_left: { ja: '{name} を左の欄へ', en: 'Move {name} to the pane on the left' },
  layout_move_right: { ja: '{name} を右の欄へ', en: 'Move {name} to the pane on the right' },

  // ---- 棋譜解析 ----
  ka_no_engine: { ja: 'エンジンが登録から消えている', en: 'The engine is no longer registered' },
  ka_progress: {
    ja: '棋譜解析 {done} / {all} 局面 · {ply} 手目 · {engine}',
    en: 'Game analysis {done} / {all} positions · move {ply} · {engine}',
  },
  ka_error: { ja: '棋譜解析 {ply} 手目: {msg}', en: 'Game analysis, move {ply}: {msg}' },
  ka_label: { ja: '棋譜解析', en: 'Game analysis' },
  ka_skipped: {
    ja: '{n} 局面を飛ばした（その段階のエンジンが無い、または評価が返らない）',
    en: 'Skipped {n} positions (no engine for that stage, or no evaluation came back)',
  },
  ka_sec_row: { ja: '1 局面の秒数', en: 'Seconds per position' },

  // ---- 更新 ----
  up_preview_only: { ja: 'ブラウザのプレビューでは更新を確認できません', en: 'The browser preview cannot check for updates' },
  up_latest: { ja: 'いまの版（{version}）が最新です', en: 'You are on the latest version ({version})' },
  up_confirm: {
    ja: '新しい版 {version} があります。取り込んで再起動しますか\n\n{note}',
    en: 'Version {version} is available. Download it and restart?\n\n{note}',
  },
  up_later: {
    ja: '新しい版 {version} があります。「はじめに」→「更新を確認」でいつでも入れられます',
    en: 'Version {version} is available. You can install it any time from Getting started → Check for updates',
  },
  up_downloading: { ja: '更新を取り込んでいます…', en: 'Downloading the update…' },
  up_downloading_pct: { ja: '更新を取り込んでいます… {pct}%', en: 'Downloading the update… {pct}%' },
  up_downloading_kb: { ja: '更新を取り込んでいます… {kb} KB', en: 'Downloading the update… {kb} KB' },
  up_downloaded: { ja: '取り込みました。入れ替えます', en: 'Downloaded. Installing' },
  up_installing: { ja: '入れ替えています。再起動します', en: 'Installing. The app will restart' },
  up_failed: { ja: '更新を確認できません: {msg}', en: 'Cannot check for updates: {msg}' },

  // ---- 新しい対局の窓 ----
  ng_title: { ja: '新しい対局', en: 'New game' },
  ng_rule: { ja: 'ルール', en: 'Rules' },
  ng_rule_tenbin: {
    ja: '天秤将棋。一方が両方の玉を置き、もう一方が先後を選ぶ',
    en: 'Balance Shogi. One player places both kings, the other picks the side',
  },
  ng_rule_fuseki: {
    ja: '布石将棋。空の盤に交互に20枚ずつ打ってから指す',
    en: 'Fuseki Shogi. Each side places 20 pieces on an empty board, then plays',
  },
  ng_rule_position: { ja: '本将棋。ふつうの平手の将棋', en: 'Shogi. The ordinary even game' },
  ng_name: { ja: '名前', en: 'Name' },
  ng_human: { ja: '人', en: 'Person' },
  ng_engine: { ja: 'エンジン', en: 'Engine' },
  ng_normal_label: { ja: '本将棋（41手目から）', en: 'Shogi (from move 41)' },
  ng_engine_label: { ja: '使うエンジン', en: 'Engine to use' },
  ng_played_by_person: { ja: '人が指す', en: 'Played by a person' },
  ng_fuseki_label: { ja: '布石（40手）', en: 'Placement (40 moves)' },
  ng_placed_by_person: { ja: '人が置く', en: 'Placed by a person' },
  ng_builtin_policy: { ja: '内蔵の方策', en: 'Built-in policy' },
  ng_builtin_models: { ja: '内蔵の方策（{name}）', en: 'Built-in policy ({name})' },
  ng_strength: { ja: '強さ', en: 'Strength' },
  ng_strength_title: {
    ja: '内蔵の方策の温度。1 は気まぐれ、5 は価値ネットで最善を選ぶ',
    en: 'Temperature of the built-in policy. 1 wanders, 5 picks the value net’s best',
  },
  ng_level1: { ja: '1 · 気まぐれ', en: '1 · wandering' },
  ng_sec_per_move: { ja: '1手の秒数', en: 'Seconds per move' },
  ng_main_min: { ja: '持ち時間（分）', en: 'Main time (minutes)' },
  ng_byoyomi_sec: { ja: '秒読み（秒）', en: 'Byoyomi (seconds)' },
  ng_time_hint: {
    ja: '両方 0 なら時間は計らず、エンジンは「1手の秒数」で指す',
    en: 'With both at 0 the clock is off and engines use “seconds per move”',
  },
  ng_start: { ja: '対局を始める', en: 'Start the game' },

  // ---- 局面編集 ----
  ed_title: { ja: '局面編集', en: 'Edit position' },
  ed_hint: {
    ja: '駒を選んでマスへ。盤の駒を押すと手に持ち、もう一度同じマスを押すと成・不成が切り替わります。',
    en: 'Pick a piece, then a square. Pressing a piece on the board picks it up; pressing the same square again toggles promotion.',
  },
  ed_side_sente: { ja: '☗先手', en: '☗ Sente' },
  ed_side_gote: { ja: '☖後手', en: '☖ Gote' },
  ed_piece_title: { ja: '{side}の{role}', en: '{side} {role}' },
  ed_erase: { ja: '消す', en: 'Erase' },
  ed_holding: { ja: '手に持っている駒: {mark}{role}', en: 'Holding: {mark}{role}' },
  ed_erase_hint: { ja: '消す: 押したマスの駒を取り除きます', en: 'Erase: pressing a square removes the piece on it' },
  ed_turn: { ja: '手番', en: 'To move' },
  ed_hirate: { ja: '平手の初期配置', en: 'Standard starting position' },
  ed_clear: { ja: '盤を空にする', en: 'Clear the board' },
  ed_start: { ja: 'この局面から本将棋を始める', en: 'Start shogi from this position' },
  ed_need_kings: { ja: '玉は先手・後手に1枚ずつ置いてください', en: 'Place exactly one king for each side' },
  ed_bad_position: { ja: '局面として成り立ちません: {msg}', en: 'Not a valid position: {msg}' },

  // ---- 対局の進行 ----
  th_paused: { ja: '一時停止', en: 'Paused' },
  th_aborted: { ja: '中断', en: 'Interrupted' },
  th_moved: { ja: '指した', en: 'Moved' },
  th_stopped: { ja: '止まった', en: 'Stopped' },
  seat_placer: { ja: '{name}（玉を置く）', en: '{name} (places the kings)' },
  seat_chooser: { ja: '{name}（先後を選ぶ）', en: '{name} (picks the side)' },
  engine_word: { ja: 'エンジン', en: 'Engine' },
  pl_bad_move_log: { ja: '指せない手が返った: {token} · 局面 {pos}', en: 'An unplayable move came back: {token} · position {pos}' },
  pl_bad_move_retry: { ja: 'エンジンが指せない手を返しました。もう一度聞いています…', en: 'The engine returned an unplayable move. Asking again…' },
  pl_bad_move_twice_log: { ja: '2 度とも指せない手だった: {token}', en: 'Unplayable both times: {token}' },
  pl_bad_move_stop: {
    ja: 'エンジンが指せない手（{token}）を返しました。対局を止めます。「待った」で戻すか、新しい対局を始めてください',
    en: 'The engine returned an unplayable move ({token}). The game is stopped — take back a move or start a new game',
  },
  pl_engine_error: { ja: 'エンジンが指せない: {msg}', en: 'The engine cannot move: {msg}' },
  pl_engine_gone: { ja: 'エンジンが登録から消えている', en: 'The engine is no longer registered' },
  pl_starting: { ja: '{name} を起動しています…', en: 'Starting {name}…' },
  pl_starting_note: { ja: '{name}: {text}', en: '{name}: {text}' },
  pl_declare_win: {
    ja: '{name} が入玉宣言をしました（このアプリでは扱えないので投了として記録します）',
    en: '{name} declared an entering-king win (this app cannot judge it, so it is recorded as a resignation)',
  },
  pl_builtin_missing: { ja: '内蔵の布石評価が読み込まれていない', en: 'The built-in placement evaluator is not loaded' },
  pl_builtin_label: { ja: '内蔵の布石評価', en: 'Built-in placement evaluator' },
  pl_builtin_no_move: { ja: '候補を出せない: {msg}', en: 'No candidate move: {msg}' },

  // ---- USI エンジン ----
  eng_tauri_only: {
    ja: 'エンジンの起動は Tauri のアプリ内でだけできる（ブラウザのプレビューでは不可）',
    en: 'Engines can only be started inside the Tauri app (not in the browser preview)',
  },
  eng_started: { ja: '起動: {path}', en: 'Started: {path}' },
  eng_exited_log: { ja: '終了した', en: 'Exited' },
  eng_exited_code_log: { ja: '終了した（終了コード {code}）', en: 'Exited (exit code {code})' },
  eng_exited: { ja: 'エンジンが終了した', en: 'The engine exited' },
  eng_exited_code: {
    ja: 'エンジンが終了した（終了コード {code}）。GPU のエンジンなら CUDA・TensorRT・cuDNN の DLL が揃っているか確かめる',
    en: 'The engine exited (exit code {code}). For a GPU engine, check that the CUDA / TensorRT / cuDNN libraries are all present',
  },
  eng_loading: { ja: '準備しています（isready）…', en: 'Getting ready (isready)…' },
  eng_loading_gpu: {
    ja: '模型を GPU に載せています…（初回は数分〜十数分かかります）',
    en: 'Loading the network onto the GPU… (the first time takes several minutes)',
  },
  eng_ready_timeout: {
    ja: '準備（isready）が {sec} 秒で終わらなかった。GPU のエンジンは初回に時間がかかる。エンジンの設定の「準備を待つ秒数」を増やして試す',
    en: 'Getting ready (isready) did not finish within {sec} s. A GPU engine is slow the first time — raise “Seconds to wait for isready” in the engine settings and try again',
  },
  eng_gpu_busy: {
    ja: 'GPU を使うエンジンは同時に 1 本だけです。いま「{name}」が読んでいるので、そちらを止めてからにしてください',
    en: 'Only one GPU engine runs at a time, and “{name}” is thinking right now. Stop it first',
  },
  eng_gpu_starting: {
    ja: 'GPU を使うエンジンは同時に 1 本だけです。いま「{name}」が準備しているので、終わるまで待ってください',
    en: 'Only one GPU engine runs at a time, and “{name}” is still getting ready. Wait until it finishes',
  },
  eng_gpu_in_game: {
    ja: 'GPU を使うエンジンは同時に 1 本だけです。「{name}」が対局で使っているので、対局を終えてから検討してください',
    en: 'Only one GPU engine runs at a time, and “{name}” is playing the game. Finish the game before analysing with it',
  },
  eng_gpu_freed: { ja: 'GPU を空けています（「{name}」を終了）…', en: 'Freeing the GPU (closing “{name}”)…' },
  eng_gpu_freed_log: {
    ja: 'GPU は 1 本だけなので、空いていた「{name}」を終了した',
    en: 'Only one GPU engine can run, so the idle “{name}” was closed',
  },
  eng_stale_bestmove: { ja: '止めたあとに遅れて届いた bestmove を捨てた: {line}', en: 'Dropped a bestmove that arrived after the stop: {line}' },
  eng_extra_bestmove: { ja: '余計な bestmove を捨てた: {line}', en: 'Dropped an unexpected bestmove: {line}' },
  eng_no_response: { ja: 'エンジンが {sec} 秒応答しない', en: 'No answer from the engine for {sec} s' },
  eng_not_ready: { ja: 'エンジンが準備できていない', en: 'The engine is not ready' },
  eng_bad_bestmove: { ja: 'bestmove を読めない: {line}', en: 'Cannot read the bestmove: {line}' },
  eng_stop_ignored: { ja: 'エンジンが stop に応答しない', en: 'The engine does not answer stop' },
  eng_killed: { ja: 'エンジンを止めた', en: 'The engine was stopped' },

  // ---- 内蔵の布石評価 ----
  bi_name: { ja: '内蔵の布石評価', en: 'Built-in placement evaluator' },
  bi_table_format: { ja: '両玉の価値表の形式が違う: {format}', en: 'Wrong king-pair table format: {format}' },
  bi_table_fields: { ja: '両玉の価値表に pairs / band が無い', en: 'The king-pair table has no pairs / band' },
  bi_table_gen: {
    ja: '両玉の価値表（{table}）と布石ネット（{model}）の世代が違う',
    en: 'The king-pair table ({table}) and the placement net ({model}) are from different generations',
  },
  bi_table_unreadable: {
    ja: '両玉の価値表を読めない。天秤将棋の 1〜2 手目は価値ネットで代用する',
    en: 'Cannot read the king-pair table; the first two moves of Balance Shogi fall back to the value net',
  },
  bi_models_unreadable: { ja: 'モデルの一覧を読めない: {status} {url}', en: 'Cannot read the model list: {status} {url}' },
  bi_models_format: { ja: 'モデルの一覧の形式が違う: {format}', en: 'Wrong model-list format: {format}' },
  bi_bad_filename: {
    ja: 'モデルの一覧のファイル名が同じフォルダの中を指していない: {file}',
    en: 'The model list names a file outside its own folder: {file}',
  },
  bi_policy: { ja: '方策', en: 'the policy net' },
  bi_value: { ja: '価値ネット', en: 'the value net' },
  bi_missing_input: { ja: '{what}の ONNX に入力 {name} が無い', en: 'The ONNX for {what} has no input {name}' },
  bi_missing_policy_out: { ja: '方策の ONNX に output_policy が無い', en: 'The policy ONNX has no output_policy' },
  bi_missing_value_out: { ja: '価値ネットの ONNX に output_value が無い', en: 'The value-net ONNX has no output_value' },
  bi_no_usi: { ja: '内蔵の評価は USI の行を受けない: {line}', en: 'The built-in evaluator takes no USI lines: {line}' },
  bi_not_ready: { ja: '内蔵の評価が準備できていない', en: 'The built-in evaluator is not ready' },
  bi_fuseki_only: { ja: '内蔵の評価は布石の局面だけを受ける', en: 'The built-in evaluator only takes placement positions' },
  bi_no_legal: { ja: '布石で合法手が無い', en: 'No legal placement' },

  // ---- 勝率の目盛り ----
  ep_generic_label: { ja: '一般（600 / 0）', en: 'Generic (600 / 0)' },
  ep_generic_note: {
    ja: 'やねうら王系の慣例。dlshogi 系もこの目盛りで cp を出す',
    en: 'The YaneuraOu convention; dlshogi engines report cp on this scale too',
  },
  ep_fv16_label: { ja: '水匠5 · FV_SCALE 16（実測 435 / +34）', en: 'Suisho5 · FV_SCALE 16 (measured 435 / +34)' },
  ep_fv16_note: {
    ja: 'やねうら王に nn.bin を置いて FV_SCALE 16 で動かすとき。41 手目局面 5,569 局の実勝敗で較正',
    en: 'For YaneuraOu running nn.bin at FV_SCALE 16. Calibrated on the real results of 5,569 games from move-41 positions',
  },
  ep_fv24_label: { ja: '水匠5の実行ファイル · FV_SCALE 24（652 / +51）', en: 'The Suisho5 executable · FV_SCALE 24 (652 / +51)' },
  ep_fv24_note: {
    ja: '評価関数を埋め込んだ Suisho5-*.exe は FV_SCALE 24 固定。cp が 1.5 倍大きく出るぶんを比例で吸収した値（未実測）',
    en: 'Suisho5-*.exe embeds the evaluation function and fixes FV_SCALE 24, so cp comes out 1.5× larger; absorbed proportionally (not measured)',
  },
  eval_note_default: {
    ja: 'p = 1 / (1 + exp(−(cp − offset) / S))。エンジンの目盛りに合わせて決める',
    en: 'p = 1 / (1 + exp(−(cp − offset) / S)). Set it to match the engine’s scale',
  },
  rc_fuseki_note: { ja: '布石 USI 拡張。勝率を直接出す', en: 'The placement USI extension; reports the win rate directly' },
  rc_suisho_note: {
    ja: '評価関数を埋め込んだ配布物（FV_SCALE 24）',
    en: 'The distribution with the evaluation function built in (FV_SCALE 24)',
  },
  rc_yane_note: {
    ja: '評価関数は EvalDir。水匠5を FV_SCALE 16 で使うなら目盛りを 435 / +34 に',
    en: 'The evaluation function comes from EvalDir. For Suisho5 at FV_SCALE 16, set the scale to 435 / +34',
  },
  rc_dl_note: {
    ja: '勝率を Eval_Coef（既定 756）倍して cp に直して出す',
    en: 'Converts the win rate to cp by multiplying by Eval_Coef (756 by default)',
  },

  // ---- エンジンの窓 ----
  en_title: { ja: 'エンジン', en: 'Engines' },
  en_intro: {
    ja: 'USI 対応のエンジンなら何本でも登録できます。本体と評価関数はこのアプリには入っていません。エンジンのフォルダ',
    en: 'Register as many USI engines as you like. The engines and their evaluation functions do not ship with this app. Put them in the engine folder',
  },
  en_intro_tail: { ja: 'に置けばまとめて取り込めます。', en: 'to import them all at once.' },
  en_open_dir: { ja: 'フォルダを開く', en: 'Open the folder' },
  en_log: { ja: 'USI ログ', en: 'USI log' },
  en_log_title: {
    ja: 'エンジンとのやり取り（USI）をそのまま見る。起動しないときの手がかりになる',
    en: 'See the raw USI traffic. It is the first clue when an engine will not start',
  },
  en_import: { ja: 'フォルダから取り込む', en: 'Import from a folder' },
  en_add: { ja: '実行ファイルを選んで追加', en: 'Add by picking an executable' },
  en_empty: {
    ja: 'まだ登録がありません。布石の評価は内蔵のものが動きますが、41 手目以降の検討と対局にはエンジンが要ります。',
    en: 'Nothing registered yet. Placement uses the built-in evaluator, but analysis and play from move 41 need an engine.',
  },
  en_kind_fuseki: { ja: '布石にも対応', en: 'Placement too' },
  en_gpu_badge: { ja: 'GPU', en: 'GPU' },
  en_kind_normal: { ja: '本将棋', en: 'Shogi' },
  en_default_normal: { ja: '本将棋の既定', en: 'Default for shogi' },
  en_default_fuseki: { ja: '布石の既定', en: 'Default for placement' },
  en_opt_hash: { ja: 'ハッシュ', en: 'Hash' },
  en_opt_threads: { ja: 'スレッド', en: 'Threads' },
  en_opt_eval: { ja: '評価関数', en: 'Eval' },
  en_opt_model: { ja: '模型', en: 'Network' },
  en_opt_batch: { ja: 'バッチ', en: 'Batch' },
  en_noname: { ja: '(名前なし)', en: '(no name)' },
  en_scale_meta: { ja: '勝率の目盛り {scale} / {offset}', en: 'Win-rate scale {scale} / {offset}' },
  en_edit: { ja: '設定', en: 'Settings' },
  en_dup: { ja: '複製', en: 'Duplicate' },
  en_dup_suffix: { ja: '{name}（複製）', en: '{name} (copy)' },
  en_make_default_fuseki: { ja: '布石の既定にする', en: 'Make it the placement default' },
  en_models_title: { ja: '布石の模型（世代）', en: 'Placement models (generations)' },
  en_models_intro: {
    ja: '同梱の模型のほかに、書き出した世代のフォルダ（models.json と 3 つの重み）を足せる。足した世代は席と検討の欄で選べるので、世代どうしを戦わせられる。',
    en: 'Besides the bundled models you can add a folder holding an exported generation (models.json and the three weight files). Added generations can be picked per seat and per analysis pane, so generations can play each other.',
  },
  en_models_add: { ja: 'フォルダを足す…', en: 'Add a folder…' },
  en_models_bundled: { ja: '同梱', en: 'Bundled' },
  en_models_bundled_path: { ja: 'アプリに同梱', en: 'Shipped with the app' },
  en_models_broken: { ja: '読めない', en: 'Unreadable' },
  en_models_no_kings: { ja: '両玉の表なし', en: 'No king-pair table' },
  en_models_pick: { ja: 'models.json のあるフォルダ', en: 'Folder holding models.json' },
  en_models_loading: { ja: '布石の模型を読んでいる: {dir}', en: 'Loading placement models: {dir}' },
  en_models_add_failed: { ja: '足せない: {msg}', en: 'Cannot add: {msg}' },
  en_models_dup: { ja: 'そのフォルダはもう足してある', en: 'That folder is already added' },
  en_models_failed: { ja: '模型を読めない', en: 'Cannot load the models' },
  en_models_tauri_only: {
    ja: 'フォルダの差し替えはアプリでだけ使える（ブラウザのプレビューでは同梱のみ）',
    en: 'Swapping folders works only in the app (the browser preview has the bundled models only)',
  },
  en_make_default_normal: { ja: '本将棋の既定にする', en: 'Make it the shogi default' },
  en_remove: { ja: '削除', en: 'Remove' },
  en_remove_confirm: { ja: '「{name}」を削除しますか', en: 'Remove “{name}”?' },
  en_pick_exe: { ja: 'エンジンの実行ファイル', en: 'The engine executable' },
  en_pick_dir: { ja: 'エンジンを置いたフォルダ', en: 'The folder holding the engines' },
  en_pick_folder: { ja: 'フォルダ', en: 'Folder' },
  en_pick_file: { ja: 'ファイル', en: 'File' },
  en_probing: { ja: '{name} を起動して申告を読んでいます…', en: 'Starting {name} and reading what it declares…' },
  en_import_title: { ja: 'フォルダから取り込む', en: 'Import from a folder' },
  en_import_hint: { ja: '{dir} の下 2 段までの実行ファイル。', en: 'Executables up to two levels under {dir}.' },
  en_import_none: { ja: '新しく取り込めるものはありません。', en: 'Nothing new to import.' },
  en_import_pick: {
    ja: '取り込むものを選んでください。1 本ずつ起動して申告を読みます。',
    en: 'Pick what to import. Each one is started once to read what it declares.',
  },
  en_import_do: { ja: '取り込む', en: 'Import' },
  en_import_errors: {
    ja: '起動できなかったものがあります（登録していません）:\n{list}',
    en: 'Some would not start (they were not registered):\n{list}',
  },
  en_form_new: { ja: 'エンジンを追加', en: 'Add an engine' },
  en_form_edit: { ja: 'エンジンの設定', en: 'Engine settings' },
  en_name: { ja: '名前', en: 'Name' },
  en_name_placeholder: { ja: '例: 水匠5', en: 'e.g. Suisho5' },
  en_kind_legend: { ja: '使える局面', en: 'Where it can play' },
  en_kind_normal_label: { ja: '本将棋（41手目以降）', en: 'Shogi (from move 41)' },
  en_exe: { ja: '実行ファイル', en: 'Executable' },
  en_exe_placeholder: { ja: '例: C:\\shogi\\YaneuraOu.exe', en: 'e.g. C:\\shogi\\YaneuraOu.exe' },
  en_browse: { ja: '参照…', en: 'Browse…' },
  en_reprobe: { ja: '申告を読む', en: 'Read the declaration' },
  en_reprobe_title: { ja: '起動して申告を読み直す', en: 'Start it and read the declaration again' },
  en_advanced: { ja: '起動の細かい設定', en: 'Advanced startup settings' },
  en_args: {
    ja: '起動時の引数（ふつうは空。例: wsl.exe 経由なら <code>-d Ubuntu-24.04 -- /home/you/engine</code>）',
    en: 'Startup arguments (usually empty; for wsl.exe, e.g. <code>-d Ubuntu-24.04 -- /home/you/engine</code>)',
  },
  en_cwd: { ja: '作業フォルダ（空なら実行ファイルの場所）', en: 'Working folder (empty means where the executable is)' },
  en_gpu_legend: { ja: 'GPU で読むエンジン', en: 'Engine that thinks on the GPU' },
  en_gpu_label: { ja: 'GPU（DNN）を使う', en: 'Uses the GPU (DNN)' },
  en_gpu_hint: {
    ja: 'dlshogi・ふかうら王など。同時に 1 本だけ立てます（VRAM は席の数だけ増えません）。申告に DNN_ の項目があれば自動で付きます',
    en: 'dlshogi, Fukauraou and the like. Only one runs at a time (VRAM does not grow with the number of seats). It is set automatically when the engine declares DNN_ options',
  },
  en_ready_sec: { ja: '準備を待つ秒数（isready）', en: 'Seconds to wait for isready' },
  en_ready_sec_hint: {
    ja: '空なら GPU で {gpu} 秒、それ以外は {cpu} 秒。初回に模型を GPU 向けに組み直すエンジンはここを延ばします',
    en: 'Empty means {gpu} s for GPU engines and {cpu} s otherwise. Raise it for engines that rebuild the network for your GPU on first run',
  },
  en_eval_legend: { ja: '評価値から勝率への目盛り', en: 'Scale from evaluation to win rate' },
  en_preset: { ja: '型', en: 'Preset' },
  en_preset_custom: { ja: '手で指定', en: 'Set by hand' },
  en_scale_s: { ja: 'S（幅）', en: 'S (width)' },
  en_scale_offset: { ja: 'offset（50% の cp）', en: 'offset (cp at 50%)' },
  en_usi_legend: { ja: 'エンジンの設定（申告どおり）', en: 'Engine settings (as declared)' },
  en_no_declaration: {
    ja: '申告を読んでいません。「申告を読む」で起動して読むと、ここに項目が並びます。',
    en: 'Nothing read yet. Press “Read the declaration” and the options appear here.',
  },
  en_extra_setoption: { ja: '申告に無い setoption（1行に name=value）', en: 'setoption not declared (one name=value per line)' },
  en_save: { ja: '保存', en: 'Save' },
  en_probe_failed: { ja: '申告を読めない: {msg}', en: 'Cannot read the declaration: {msg}' },
  en_opt_button: { ja: '（実行の項目。ここでは設定できません）', en: '(an action; it cannot be set here)' },
  en_opt_reset: { ja: '既定', en: 'Default' },
  en_opt_reset_title: { ja: '申告の既定値 {value} に戻す', en: 'Back to the declared default {value}' },

  // ---- はじめの案内 ----
  su_title: { ja: 'はじめに', en: 'Getting started' },
  su_version: { ja: '版 {version}', en: 'Version {version}' },
  su_intro: {
    ja: '布石（1〜40手目）はアプリの中の評価で動きます。<b>41手目からの本将棋にはエンジンが要ります。</b>',
    en: 'Placement (moves 1–40) runs on the evaluator inside the app. <b>Shogi from move 41 needs an engine.</b>',
  },
  su_none_yet: { ja: 'まだ 1 本も登録されていません。', en: 'None registered yet.' },
  su_count: { ja: 'いま {n} 本登録されています。', en: '{n} registered right now.' },
  su_install: { ja: 'エンジンを自動で入れる', en: 'Install an engine automatically' },
  su_install_hint: {
    ja: 'やねうら王＋水匠5 を公式の配布先から取って登録します（約 40MB）',
    en: 'Downloads YaneuraOu + Suisho5 from their official releases and registers them (about 40 MB)',
  },
  su_install_gpu: { ja: 'GPU で読むエンジンを入れる', en: 'Install a GPU engine' },
  su_install_gpu_hint: {
    ja: 'dlshogi with GCT を公式の配布先から取って登録します（約 67MB）。DirectX 12 の GPU が要ります（NVIDIA でなくても動きます）。初回の起動は模型の読み込みで数分かかります',
    en: 'Downloads dlshogi with GCT from its official release and registers it (about 67 MB). It needs a DirectX 12 GPU (it does not have to be NVIDIA). The first start takes a few minutes while the network loads',
  },
  su_installed_gpu: {
    ja: '入りました。{name} を登録しました（初回の起動は模型の読み込みで数分かかります）',
    en: 'Installed. {name} is registered (its first start takes a few minutes while the network loads)',
  },
  su_manual_head: { ja: '自分で入れるなら', en: 'Installing it yourself' },
  su_manual_body: {
    ja: '実行ファイルをエンジンのフォルダに置いて「エンジン」→「フォルダから取り込む」。やねうら王なら隣に <code>eval/nn.bin</code>（水匠5）を置き、目盛りは <b>652 / +51</b>。',
    en: 'Put the executable in the engine folder, then Engines → Import from a folder. For YaneuraOu, put <code>eval/nn.bin</code> (Suisho5) beside it and set the scale to <b>652 / +51</b>.',
  },
  su_dir_engines: { ja: 'エンジン', en: 'Engines' },
  su_dir_data: { ja: 'データ', en: 'Data' },
  su_dir_unknown: { ja: '（アプリの中でだけ分かります）', en: '(only known inside the app)' },
  su_uninstall_head: { ja: 'アンインストール', en: 'Uninstalling' },
  su_uninstall_body: {
    ja: 'Windows の「設定 → アプリ」から「天秤将棋GUI」を消します。設定と入れたエンジンは下のフォルダに残るので、そこも消せば何も残りません（設定をまっさらにしたいときも、このフォルダを消してから起動します）。',
    // Windows の一覧に出るのは tauri.conf.json の productName（日本語のまま）。訳さずそのまま出す
    en: 'Remove “天秤将棋GUI” — that is how Windows lists it — from Settings → Apps. The settings and the engines you installed stay in the folder below; delete it too and nothing is left (deleting it also gives you a clean slate on the next start).',
  },
  su_open: { ja: '開く', en: 'Open' },
  su_engines_btn: { ja: 'エンジンの登録', en: 'Register engines' },
  su_update_btn: { ja: '更新を確認', en: 'Check for updates' },
  su_app_only: { ja: 'アプリの中でだけできます', en: 'Only possible inside the app' },
  su_stopping: { ja: '動いているエンジンを止めています…', en: 'Stopping the engines that are running…' },
  su_starting: { ja: '始めています…', en: 'Starting…' },
  su_registering: { ja: '登録しています…', en: 'Registering…' },
  su_note_percent: { ja: '{text}（{percent}%）', en: '{text} ({percent}%)' },
  su_installed_but_failed: { ja: '入れましたが、起動できませんでした: {msg}', en: 'Installed, but it would not start: {msg}' },
  su_installed: { ja: '入りました。{name} を本将棋の既定にしました', en: 'Installed. {name} is now the default for shogi' },
  su_say_failed: { ja: 'エンジンを入れましたが起動できません: {msg}', en: 'The engine was installed but will not start: {msg}' },
  su_say_installed: { ja: '{name} を入れました', en: 'Installed {name}' },
  su_install_failed: {
    ja: '入れられません: {msg} ／ 手でも入れられます: 「エンジン」→「実行ファイルを選んで追加」（配布元と手順は README の「エンジンを手動で入れる」）',
    en: 'Cannot install it: {msg} / You can also do it by hand: Engines → Add an executable (see "Installing an engine by hand" in the README).',
  },

  // ---- 検討の欄 ----
  an_slot_engine: { ja: 'この枠のエンジン', en: 'Engine for this pane' },
  an_slot_remove: { ja: 'この枠を外す', en: 'Remove this pane' },
  an_engine_missing: { ja: 'エンジンが見つからない', en: 'The engine cannot be found' },
  an_starting: { ja: '起動中…', en: 'Starting…' },
  an_seconds: { ja: '{sec} 秒', en: '{sec} s' },
  an_state_stopped: { ja: '停止', en: 'Stopped' },
  an_state_starting: { ja: '起動中', en: 'Starting' },
  an_state_ready: { ja: '待機', en: 'Idle' },
  an_state_thinking: { ja: '思考中', en: 'Thinking' },
  an_trust_early: { ja: '序盤の数字は当てにならない', en: 'early numbers are unreliable' },
  an_trust_mid: { ja: '中盤の数字は目安', en: 'mid-game numbers are a rough guide' },
  an_trust_late: { ja: '終盤の数字はおおむね当たる', en: 'late numbers are mostly right' },
  an_kings_table: { ja: '両玉の価値表 · 実対局の勝率', en: 'King-pair table · win rate from real games' },
  an_value_net: { ja: '布石の価値ネット · {trust}', en: 'Placement value net · {trust}' },
  an_nodes: { ja: '{n} ノード', en: '{n} nodes' },
  an_waiting_pv: { ja: '読み筋を待っています…', en: 'Waiting for a line…' },
  an_player_empty: { ja: 'エンジンが考え始めると、読み筋がここに出ます。', en: 'When the engine starts thinking, its line appears here.' },
  an_empty: {
    ja: '検討を始めると、候補手・評価値・期待勝率がここに並びます。',
    en: 'Start the analysis and the candidate moves, evaluations and win rates appear here.',
  },
  an_col_rank: { ja: '順位', en: '#' },
  an_col_depth: { ja: '深さ', en: 'Depth' },
  an_col_score: { ja: '評価値', en: 'Eval' },
  an_col_p: { ja: '期待勝率', en: 'Win rate' },
  an_col_pv: { ja: '読み筋', en: 'Line' },
  an_mate: { ja: '{sign}{n}詰', en: '{sign}M{n}' },
  an_approx_title: {
    ja: 'このエンジンは評価値を出さない。勝率から換算した目安',
    en: 'This engine reports no evaluation; converted from the win rate',
  },
  an_play_title: { ja: '対局中のエンジンの読み', en: 'What the playing engines see' },
  an_play_multipv_title: {
    ja: '対局中のエンジンに送る MultiPV。増やすと候補が並ぶが、読みは少し落ちる',
    en: 'MultiPV sent to the playing engines. More candidates, slightly shallower search',
  },
  an_candidates: { ja: '候補', en: 'Candidates' },
  an_play_empty: {
    ja: '対局を始めると、先手と後手の候補手がここに並びます。',
    en: 'Start a game and the candidate moves for both sides appear here.',
  },
  an_start: { ja: '検討を始める', en: 'Start the analysis' },
  an_stop: { ja: '検討を止める', en: 'Stop the analysis' },
  an_multipv_title: { ja: '候補の数（MultiPV）', en: 'Number of candidates (MultiPV)' },
  an_add_engine: { ja: '＋ エンジンを足す', en: '+ Add an engine' },
  an_add_engine_title: { ja: 'もう 1 本のエンジンで同じ局面を検討する', en: 'Analyse the same position with a second engine' },
  an_kifu_btn: { ja: '棋譜解析', en: 'Analyse the game' },
  an_kifu_title: { ja: '棋譜の各局面を順に評価してグラフに入れる', en: 'Evaluate each position in the record and fill the graph' },
  an_human_plays: { ja: '人が指します', en: 'A person plays' },
  an_engine_thinks: { ja: 'エンジンが考えます', en: 'An engine thinks' },
  an_stop_btn: { ja: '止める', en: 'Stop' },
  an_register_engine: { ja: 'エンジンを登録する', en: 'Register an engine' },
  an_need_engine: {
    ja: '布石は内蔵の評価で検討できます。41 手目以降には USI エンジンが要ります。',
    en: 'Placement can be analysed with the built-in evaluator. From move 41 you need a USI engine.',
  },
  an_auto: { ja: '自動（布石は内蔵、41手目から既定のエンジン）', en: 'Automatic (built-in for placement, the default engine from move 41)' },
  an_cannot_choose: { ja: '先手か後手かを選ぶと検討できます。', en: 'Pick Sente or Gote and the analysis can start.' },
  an_cannot_fuseki: {
    ja: '布石中はこのエンジンでは評価できません。布石対応のエンジンか内蔵の評価を選んでください。',
    en: 'This engine cannot evaluate placement. Pick a placement-capable engine, or the built-in evaluator.',
  },
  an_cannot_normal: {
    ja: '内蔵の評価は布石だけです。41 手目からは本将棋のエンジンを使います。',
    en: 'The built-in evaluator only handles placement. From move 41, use a shogi engine.',
  },
  an_no_normal_engine: {
    ja: '41 手目以降の既定エンジンがありません。エンジンを登録してください。',
    en: 'There is no default engine for move 41 onward. Register one.',
  },
  an_no_fuseki_engine: { ja: '布石を検討するものがありません。', en: 'Nothing available to analyse the placement.' },

  // ---- 布石の wasm ----
  fk_feature_shape: {
    ja: '特徴量の形が合わない: features1={f1}(期待{want1}) features2={f2}(期待{want2})',
    en: 'Feature shapes do not match: features1={f1} (expected {want1}) features2={f2} (expected {want2})',
  },
  fk_piecetype: { ja: 'PieceType の対応がズレている: pt={pt} は \'{got}\'', en: 'PieceType mapping is off: pt={pt} is \'{got}\'' },
  fk_illegal: { ja: '布石フェーズの合法手ではない: {usi}', en: 'Not a legal placement move: {usi}' },
  // <<DICT_END>>
} as const satisfies Record<string, Entry>;

export type Key = keyof typeof DICT;

let current: Lang = detectLang();

/** 端末の言語。日本語なら日本語、それ以外は英語 */
export function detectLang(): Lang {
  const l = typeof navigator !== 'undefined' ? navigator.language : '';
  return l && l.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function setLang(l: Lang): void {
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

export function lang(): Lang {
  return current;
}

/** 文言を引く。`{name}` の形の差し込みができる */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = DICT[key][current];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** 先手・後手の呼び名（画面用。KIF の中は state/game.ts の colorName が日本語で持つ） */
export function sideName(c: 'sente' | 'gote'): string {
  return t(c === 'sente' ? 'side_sente' : 'side_gote');
}
