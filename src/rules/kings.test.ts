import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSide, goteKingCandidates, nearestToEven, randomSenteKing } from './kings.ts';

const senteZone = ['9f', '5f', '1f', '9g', '5g', '5h', '5i', '1i'];
const goteZone = ['9a', '5a', '1a', '5b', '5c', '9d', '5d', '1d'];

test('先手玉は六段目を除いたマスから選ぶ', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) seen.add(randomSenteKing(senteZone, () => i / 64)!);
  assert.deepEqual([...seen].sort(), ['K*1i', 'K*5g', 'K*5h', 'K*5i', 'K*9g']);
  assert.equal(randomSenteKing(senteZone, () => 0.999999), 'K*9g');
  assert.equal(randomSenteKing(['5f'], () => 0), null);
});

test('後手玉の候補は四段目を除く', () => {
  assert.deepEqual(goteKingCandidates(goteZone), ['K*1a', 'K*5a', 'K*5b', 'K*5c', 'K*9a']);
});

test('先手の勝率が 0.5 にいちばん近い後手玉。差が同じならマスの並びの前', () => {
  assert.equal(nearestToEven(new Map([['K*5a', 0.62], ['K*5b', 0.47], ['K*5c', 0.3]])), 'K*5b');
  assert.equal(nearestToEven(new Map([['K*9a', 0.55], ['K*1a', 0.45]])), 'K*1a');
  assert.equal(nearestToEven(new Map()), null);
});

test('先後の選択は先手の勝率が半分以上なら先手', () => {
  assert.equal(chooseSide(0.5), 'sente');
  assert.equal(chooseSide(0.49), 'gote');
  assert.equal(chooseSide(null), 'sente');
});
