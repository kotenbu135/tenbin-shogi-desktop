// KIF の読みのテスト。書き出しは Game（＝wasm の布石ルール）が要るので、ここでは
// 文字列だけで完結する読みと符号の変換を見る。棋譜は利用者の手元に残る唯一のもので、
// 読めなくなる壊れ方が一番痛いため。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKif, fusekiDropKif } from './tenbin-kif.ts';

const HEAD = '手数----指手---------消費時間--';

function kif(...body: string[]): string {
  return ['# KIF形式棋譜ファイル 天秤将棋GUI', '手合割：天秤将棋', '先手：私', '後手：あなた', '持ち時間：00:10+30', HEAD, ...body].join('\n');
}

test('天秤将棋の方言: 玉打ち・choose・駒打ち', () => {
  const r = parseKif(kif('   1 ５九玉打        ( 0:03/00:00:03)', '   2 ５一玉打', '*choose:sente', '   3 ７六歩打'));
  assert.equal(r.mode, 'tenbin');
  assert.deepEqual(r.tokens, ['K*5i', 'K*5a', 'choose:sente', 'P*7f']);
  assert.deepEqual(r.times[0], { elapsed: 3, total: 3 });
  assert.equal(r.times[1], undefined);
  assert.equal(r.sente, '私');
  assert.equal(r.gote, 'あなた');
  assert.deepEqual(r.timeControl, { mainSec: 600, byoyomiSec: 30 });
});

test('投了で止まる。あとに行が続いても読まない', () => {
  const r = parseKif(kif('   1 ５九玉打', '   2 投了', 'まで1手で後手の勝ち', '   3 ７六歩打'));
  assert.deepEqual(r.tokens, ['K*5i', 'resign']);
});

test('切れ負けも終局として読む', () => {
  const r = parseKif(kif('   1 ５九玉打', '   2 切れ負け'));
  assert.deepEqual(r.tokens, ['K*5i', 'timeout']);
});

test('41手目からは本将棋の符号', () => {
  const drops = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(4, ' ')} ５九玉打`);
  const r = parseKif(kif(...drops, '  41 ７六歩(77)', '  42 同　歩(33)'));
  assert.equal(r.tokens.length, 42);
  assert.equal(r.tokens[40], '7g7f');
  assert.equal(r.tokens[41], '3c7f');
});

test('布石の駒打ちとして読めない手は落とす（黙って読み飛ばさない）', () => {
  assert.throws(() => parseKif(kif('   1 ７六歩(77)')), /1手目/);
});

test('普通の平手の KIF は任意局面として読む', () => {
  const r = parseKif(['手合割：平手', '先手：a', '後手：b', HEAD, '   1 ７六歩(77)'].join('\n'));
  assert.equal(r.mode, 'position');
  assert.equal(r.startSfen, 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1');
  assert.deepEqual(r.tokens, ['7g7f']);
});

test('駒打ちの USI と KIF 表記の往復', () => {
  for (const [usi, text] of [['P*7g', '７七歩打'], ['K*5i', '５九玉打'], ['R*2h', '２八飛打'], ['L*1a', '１一香打']] as const) {
    assert.equal(fusekiDropKif(usi), text);
    assert.deepEqual(parseKif(kif(`   1 ${text}`)).tokens, [usi]);
  }
});
