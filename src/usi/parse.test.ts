import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInfo, parseOption, parseBestmove, parseId, cpToWinrate, winrateToCp } from './parse.ts';

test('info: やねうら王の典型', () => {
  const i = parseInfo('info depth 12 seldepth 18 score cp 156 nodes 123456 nps 987654 time 125 multipv 1 pv P*5h 4g5g 5h5g 8b8f');
  assert.deepEqual(i, {
    depth: 12, seldepth: 18, scoreCp: 156, nodes: 123456, nps: 987654, time: 125, multipv: 1,
    pv: ['P*5h', '4g5g', '5h5g', '8b8f'],
  });
});

test('info: pv が末尾でない実装でも読み筋を切り出す', () => {
  const i = parseInfo('info depth 3 pv 7g7f 3c3d score cp 40 nodes 10');
  assert.deepEqual(i?.pv, ['7g7f', '3c3d']);
  assert.equal(i?.scoreCp, 40);
  assert.equal(i?.nodes, 10);
});

test('info: mate の各記法と bound', () => {
  assert.equal(parseInfo('info score mate 7')?.scoreMate, 7);
  assert.equal(parseInfo('info score mate -3')?.scoreMate, -3);
  assert.equal(parseInfo('info score mate +')?.scoreMate, 999);
  assert.equal(parseInfo('info score cp 30 lowerbound')?.bound, 'lower');
});

test('info: string と 布石拡張 winrate', () => {
  assert.equal(parseInfo('info string phase fuseki ply 12')?.string, 'phase fuseki ply 12');
  const i = parseInfo('info depth 1 multipv 2 score cp 96 winrate 0.591 pv S*6h');
  assert.equal(i?.winrate, 0.591);
  assert.deepEqual(i?.pv, ['S*6h']);
});

test('info でない行は null', () => {
  assert.equal(parseInfo('bestmove 7g7f'), null);
});

test('option: spin / combo / filename / 空の default', () => {
  assert.deepEqual(parseOption('option name USI_Hash type spin default 16 min 1 max 33554432'), {
    name: 'USI_Hash', type: 'spin', default: '16', min: 1, max: 33554432,
  });
  assert.deepEqual(parseOption('option name Style type combo default Normal var Normal var Aggressive'), {
    name: 'Style', type: 'combo', default: 'Normal', vars: ['Normal', 'Aggressive'],
  });
  assert.deepEqual(parseOption('option name EvalDir type string default eval'), {
    name: 'EvalDir', type: 'string', default: 'eval',
  });
  assert.equal(parseOption('option name BookFile type string default <empty>')?.default, '');
  assert.equal(parseOption('option name Eval Dir Name type string default eval')?.name, 'Eval Dir Name');
});

test('bestmove / id', () => {
  assert.deepEqual(parseBestmove('bestmove 7g7f ponder 3c3d'), { move: '7g7f', ponder: '3c3d' });
  assert.deepEqual(parseBestmove('bestmove resign'), { move: 'resign' });
  assert.deepEqual(parseId('id name YaneuraOu NNUE 9.70'), { name: 'YaneuraOu NNUE 9.70' });
});

test('cp と勝率の往復', () => {
  assert.ok(Math.abs(cpToWinrate(34) - 0.5) < 1e-9);
  for (const cp of [-800, -100, 0, 34, 250, 1200]) {
    assert.equal(winrateToCp(cpToWinrate(cp)), cp);
  }
});
