import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PositionEditor, nextFace } from './editor.ts';
import { HIRATE_SFEN } from '../state/game.ts';

/** 描画を外した編集器（node には DOM が無い） */
function editor(): PositionEditor {
  const ed = Object.create(PositionEditor.prototype) as PositionEditor;
  Object.assign(ed, { deps: { onChange() {}, onStart() {}, onCancel() {} }, render() {} });
  ed.reset();
  return ed;
}

const total = (ed: PositionEditor) => {
  let n = ed.pieces.size;
  for (const c of ['sente', 'gote'] as const) for (const v of ed.hands[c].values()) n += v;
  for (const v of ed.box.values()) n += v;
  return n;
};

test('編集: 空の盤と 20 枚ずつの駒台から始まり、玉が無いと始められない', () => {
  const ed = editor();
  assert.equal(ed.pieces.size, 0);
  assert.equal(total(ed), 40);
  assert.equal(ed.hands.sente.get('king'), 1);
  assert.notEqual(ed.validate(), null);
});

test('編集: 駒台から置き、玉を置けば始められる。40 枚は増えも減りもしない', () => {
  const ed = editor();
  ed.handleHand('sente', 'king');
  ed.handleSquare('5i');
  ed.handleHand('gote', 'king');
  ed.handleSquare('5a');
  ed.handleHand('sente', 'gold');
  ed.handleSquare('5h');
  assert.equal(ed.validate(), null);
  assert.equal(ed.toSfen(), '4k4/9/9/9/9/9/9/4G4/4K4 b RBG2S2N2L9Prb2g2s2n2l9p 1');
  assert.equal(total(ed), 40);
});

test('編集: 埋まったマスに置くと、元の駒は持ち主の駒台へ。駒箱にしまえる', () => {
  const ed = editor();
  ed.handleHand('sente', 'pawn');
  ed.handleSquare('5e');
  ed.handleHand('gote', 'pawn');
  ed.handleSquare('5e');
  assert.deepEqual(ed.pieces.get('5e'), { color: 'gote', role: 'pawn' });
  assert.equal(ed.hands.sente.get('pawn'), 9);
  assert.equal(ed.hands.gote.get('pawn'), 8);
  ed.handleSquare('5e');
  ed.handleBox(null);
  assert.equal(ed.pieces.has('5e'), false);
  assert.equal(ed.box.get('pawn'), 1);
  assert.equal(total(ed), 40);
});

test('編集: 同じマスを押すと成る → 向きが変わる、成駒は駒台に戻ると元の駒', () => {
  assert.deepEqual(nextFace({ color: 'sente', role: 'pawn' }), { color: 'sente', role: 'tokin' });
  assert.deepEqual(nextFace({ color: 'sente', role: 'tokin' }), { color: 'gote', role: 'pawn' });
  assert.deepEqual(nextFace({ color: 'sente', role: 'gold' }), { color: 'gote', role: 'gold' });
  const ed = editor();
  ed.handleHand('sente', 'rook');
  ed.handleSquare('2b');
  ed.handleSquare('2b');
  ed.handleSquare('2b');
  assert.deepEqual(ed.pieces.get('2b'), { color: 'sente', role: 'dragon' });
  ed.allToHands();
  assert.equal(ed.hands.sente.get('rook'), 1);
});

test('編集: 平手を読むと駒箱は空、行き所の無い駒や相手の玉を取れる局面は始められない', () => {
  const ed = editor();
  ed.loadSfen(HIRATE_SFEN);
  assert.equal(ed.box.size, 0);
  assert.equal(ed.validate(), null);
  // 先手の歩を 1 段目へ
  ed.handleSquare('1g');
  ed.handleSquare('1a');
  assert.notEqual(ed.validate(), null, '行き所の無い歩');
  // 王手をかけたまま相手の番にはできない
  ed.loadSfen(HIRATE_SFEN);
  ed.handleSquare('5i');
  ed.handleSquare('5b');
  assert.notEqual(ed.validate(), null, '手番でない側が王手されている');
});
