// KIF の読みのテスト。書き出しは Game（＝wasm の布石ルール）が要るので、ここでは
// 文字列だけで完結する読みと符号の変換を見る。棋譜は利用者の手元に残る唯一のもので、
// 読めなくなる壊れ方が一番痛いため。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('tenbinshogi.com の形: 布石はヘッダタグ、本文は本将棋の手', () => {
  const r = parseKif(
    [
      '# 天秤将棋 tenbinshogi.com',
      '先手：あなた',
      '後手：天秤 AI 3',
      '天秤布石：K*5i K*5a P*7g P*3c',
      '天秤選択：sente',
      '先手番',
      HEAD,
      '   1 ７六歩(77)   ( 0:04/00:00:04)',
      '   2 ３四歩(33)',
      '   3 投了',
    ].join('\n'),
  );
  assert.equal(r.mode, 'tenbin');
  assert.equal(r.startSfen, undefined);
  assert.deepEqual(r.tokens, ['K*5i', 'K*5a', 'choose:sente', 'P*7g', 'P*3c', '7g7f', '3c3d', 'resign']);
  // 布石の手には消費時間が無い。本将棋の 1 手目の時間が 1 手目の位置にずれ込まないこと
  assert.equal(r.times[4], undefined);
  assert.deepEqual(r.times[5], { elapsed: 4, total: 4 });
  assert.equal(r.sente, 'あなた');
});

test('選択のタグが無ければ choose を入れない（布石の途中で終わった対局）', () => {
  const r = parseKif(['天秤布石：K*5i', HEAD].join('\n'));
  assert.equal(r.mode, 'tenbin');
  assert.deepEqual(r.tokens, ['K*5i']);
});

test('壊れた天秤布石のタグは落とす', () => {
  assert.throws(() => parseKif(['天秤布石：５九玉打', HEAD].join('\n')), /天秤布石/);
});

test('KIF でない文字は黙って平手にしない', () => {
  // 旧「手順をコピー」の USI 一行。これを平手 0 手として読んでいたのが不具合の元
  assert.throws(() => parseKif('K*5i K*5a choose:sente P*7g 7g7f'), /KIF として読めない/);
  assert.throws(() => parseKif('牛乳とパンを買う'), /KIF として読めない/);
});

test('tenbinshogi.com が実際に出した棋譜（見本）を玉の配置から読む', () => {
  // fixtures/tenbinshogi-com.kif はサイトの tenbinKif() が出した実物。サイト側が形を変えたら落ちる
  const text = readFileSync(new URL('./fixtures/tenbinshogi-com.kif', import.meta.url), 'utf8');
  const r = parseKif(text);
  assert.equal(r.mode, 'tenbin');
  assert.equal(r.startSfen, undefined);
  assert.equal(r.tokens[0], 'K*5i');
  assert.equal(r.tokens[1], 'K*5a');
  assert.equal(r.tokens[2], 'choose:sente');
  // 布石 40 手＋選択＋本将棋 6 手＋投了
  assert.equal(r.tokens.length, 48);
  assert.equal(r.tokens.filter((t) => t.includes('*')).length, 40);
  assert.equal(r.tokens[41], '1i1h');
  assert.equal(r.tokens[47], 'resign');
  // 消費時間はトークンと 1 対 1（rebuild が同じ番号で引くので、選択の枠でずれると全部ずれる）
  assert.equal(r.times.length, r.tokens.length);
  assert.equal(r.times[40], undefined);
  assert.deepEqual(r.times[41], { elapsed: 0, total: 0 });
  assert.equal(r.sente, 'あなた');
  assert.equal(r.gote, '天秤 AI 3');
});
