// 本将棋の終局の裁定（千日手・連続王手・手数上限・入玉宣言）のテスト。
//
// 規定は Libra の docs/rules.md §5（世界コンピュータ将棋選手権の大会ルール）。GUI とハーネスで
// 結果が食い違うと、Libra に宣言させた対局の勝ち負けが入れ替わるので、境目の値で固定する。
// Game は wasm（布石のルール）を抱えるので、本物の wasm を Node で読む（nihikyo.test.ts と同じ）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSfen, makeSfen } from 'shogiops/sfen';
import { makeUsi } from 'shogiops/util';
import type { Shogi } from 'shogiops/variant/shogi';
import { Fuseki } from '../rules/fuseki.ts';
import { Game, HIRATE_SFEN, MAX_NORMAL_MOVES, canDeclareWin, rebuild } from './game.ts';
import { parseKif, writeKif } from '../kif/tenbin-kif.ts';

const WASM = pathToFileURL(path.resolve(import.meta.dirname, '../../public/wasm/fuseki.mjs')).href;
const fuseki = await Fuseki.load(WASM);

function position(sfen: string): Shogi {
  const r = parseSfen('standard', sfen, false);
  if (r.isErr) throw r.error;
  return r.value;
}

function playAll(sfen: string, moves: string[]): Game {
  const g = new Game(fuseki, 'position', sfen);
  for (const m of moves) g.apply(m);
  return g;
}

/** 飛を 1 往復させる 4 手。平手の局面に戻る */
const ROOK_SHUFFLE = ['2h3h', '8b7b', '3h2h', '7b8b'];

test('千日手: 同じ局面の 4 回目で引き分け。3 回目では続く', () => {
  const moves = [...ROOK_SHUFFLE, ...ROOK_SHUFFLE, ...ROOK_SHUFFLE];
  const before = playAll(HIRATE_SFEN, moves.slice(0, -1));
  assert.equal(before.over, null);
  const g = playAll(HIRATE_SFEN, moves);
  assert.deepEqual(g.over, { winner: null, reason: { kind: 'sennichite' } });
});

// 先手の飛が 9a・9b を行き来して王手をかけ続け、後手玉は 1b・1a を逃げ回る
const PERPETUAL_SFEN = 'R8/8k/9/9/9/9/9/9/4K4 b - 1';
const PERPETUAL = ['9a9b', '1b1a', '9b9a', '1a1b'];

test('連続王手の千日手: 王手をかけ続けた側の負け', () => {
  const g = playAll(PERPETUAL_SFEN, [...PERPETUAL, ...PERPETUAL, ...PERPETUAL]);
  assert.deepEqual(g.over, { winner: 'gote', reason: { kind: 'perpetual_check', loser: 'sente' } });
});

test('手数上限: 本将棋の 320 手目で引き分け。319 手目では続く', () => {
  // 同じ局面が 4 回出ず、どちらも詰まない手を決まった乱数で選ぶ
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const p = position(HIRATE_SFEN);
  const seen = new Map<string, number>();
  const key = (s: Shogi) => makeSfen(s).split(' ').slice(0, 3).join(' ');
  seen.set(key(p), 1);
  const moves: string[] = [];
  while (moves.length < MAX_NORMAL_MOVES) {
    // 成・不成の両方を作り、行き所の無い不成などは isLegal で落とす
    const legal = [...p.allMoveDests()]
      .flatMap(([from, dests]) => [...dests].flatMap((to) => [{ from, to }, { from, to, promotion: true }]))
      .filter((md) => p.isLegal(md));
    const ok = legal.filter((md) => {
      const q = p.clone();
      q.play(md);
      return !q.isEnd() && (seen.get(key(q)) ?? 0) < 3;
    });
    assert.ok(ok.length > 0, `${moves.length + 1} 手目に指せる手が無い`);
    const md = ok[Math.floor(rand() * ok.length)]!;
    p.play(md);
    seen.set(key(p), (seen.get(key(p)) ?? 0) + 1);
    moves.push(makeUsi(md));
  }
  assert.equal(playAll(HIRATE_SFEN, moves.slice(0, -1)).over, null);
  assert.deepEqual(playAll(HIRATE_SFEN, moves).over, { winner: null, reason: { kind: 'max_moves' } });
});

// 先手玉 5b。敵陣に金 1・歩 9 の 10 枚（10 点）
const SENTE_CAMP = '4G4/4K4/PPPPPPPPP/9/9/9/9/9/8k b';
// 後手玉 5h。敵陣に金 1・歩 9 の 10 枚（10 点）
const GOTE_CAMP = '8K/9/9/9/9/9/ppppppppp/4k4/4g4 w';

test('入玉宣言: 先手は 28 点で勝ち、27 点では足りない', () => {
  assert.equal(canDeclareWin(position(`${SENTE_CAMP} 2R2BG 1`)), true); // 10 + 20 + 1 = 31
  assert.equal(canDeclareWin(position(`${SENTE_CAMP} 2RB2G 1`)), false); // 10 + 15 + 2 = 27
  assert.equal(canDeclareWin(position(`${SENTE_CAMP} 2RB3G 1`)), true); // 28
});

test('入玉宣言: 後手は 27 点で勝ち', () => {
  assert.equal(canDeclareWin(position(`${GOTE_CAMP} 2rb2g 1`)), true); // 27
  assert.equal(canDeclareWin(position(`${GOTE_CAMP} 2rbg 1`)), false); // 26
});

test('入玉宣言: 敵陣の駒が 9 枚、玉が敵陣の外、王手されている、はどれも負け', () => {
  assert.equal(canDeclareWin(position('9/4K4/PPPPPPPPP/9/9/9/9/9/8k b 2R2B3G 1')), false);
  assert.equal(canDeclareWin(position('4G4/9/PPPPPPPPP/4K4/9/9/9/9/8k b 2R2B3G 1')), false);
  // 後手の飛 9b が 8b〜6b を通って先手玉 5b に王手
  assert.equal(canDeclareWin(position('4G4/r3K4/PPPPPPPPP/9/9/9/9/9/8k b R2B3G 1')), false);
});

test('入玉宣言の手: 条件を満たせば宣言した側の勝ち、欠ければ負け', () => {
  const win = new Game(fuseki, 'position', `${SENTE_CAMP} 2R2BG 1`);
  win.apply('win');
  assert.deepEqual(win.over, { winner: 'sente', reason: { kind: 'declaration', declarer: 'sente' } });
  const lose = new Game(fuseki, 'position', `${SENTE_CAMP} R 1`);
  assert.equal(lose.canApply('win'), true);
  lose.apply('win');
  assert.deepEqual(lose.over, { winner: 'gote', reason: { kind: 'illegal_declaration', declarer: 'sente' } });
});

test('両玉を置いた直後（先後の選択）の盤の手番は先手。外のエンジンの勝率はこの手番から見た値', () => {
  // play.ts の engineChoose は、この局面の手番側の勝率が 0.5 以上なら先手を持つ。手番が後手だと向きが逆になる
  const g = rebuild(fuseki, 'tenbin', ['K*5i', 'K*5a']);
  assert.equal(g.phase, 'choose');
  assert.equal(g.turn, 'sente');
  assert.equal(g.actingColor, 'gote'); // 時計は選ぶ側（後手の枠）が減る
  assert.equal(g.positionCommand(), 'position fuseki moves K*5i K*5a');
});

test('入玉宣言は布石中にはできない', () => {
  const g = new Game(fuseki, 'tenbin');
  assert.equal(g.canApply('win'), false);
  assert.throws(() => g.apply('win'));
});

test('KIF の往復: 千日手・連続王手・入玉宣言（勝ち・反則負け）を読み戻すと同じ終局になる', () => {
  const games = [
    playAll(HIRATE_SFEN, [...ROOK_SHUFFLE, ...ROOK_SHUFFLE, ...ROOK_SHUFFLE]),
    playAll(PERPETUAL_SFEN, [...PERPETUAL, ...PERPETUAL, ...PERPETUAL]),
    playAll(`${SENTE_CAMP} 2R2BG 1`, ['win']),
    playAll(`${SENTE_CAMP} R 1`, ['win']),
  ];
  for (const g of games) {
    const text = writeKif(g);
    const parsed = parseKif(text);
    const again = rebuild(fuseki, parsed.mode, parsed.tokens, { startSfen: parsed.startSfen });
    assert.deepEqual(again.over, g.over, text);
    assert.deepEqual(again.tokens(), g.tokens(), text);
  }
});

test('KIF の書き出し: 終局の行と「まで n 手」', () => {
  const sennichite = writeKif(playAll(HIRATE_SFEN, [...ROOK_SHUFFLE, ...ROOK_SHUFFLE, ...ROOK_SHUFFLE]));
  assert.match(sennichite, /\n {2}13 千日手 +\nまで12手で引き分け\n$/);
  const declared = writeKif(playAll(`${SENTE_CAMP} 2R2BG 1`, ['win']));
  assert.match(declared, /\n\*入玉宣言\n {3}1 入玉勝ち +\nまで0手で先手の勝ち\n$/);
  const illegal = writeKif(playAll(`${SENTE_CAMP} R 1`, ['win']));
  assert.match(illegal, /\n\*入玉宣言\n {3}1 反則負け +\nまで0手で後手の勝ち\n$/);
});

test('他のソフトの「反則負け」は宣言として読まない', () => {
  const r = parseKif(['手合割：平手', '手数----指手---------消費時間--', '   1 ７六歩(77)', '   2 反則負け'].join('\n'));
  assert.deepEqual(r.tokens, ['7g7f']);
});
