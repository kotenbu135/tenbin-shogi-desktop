import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpToP, pToCp, recipeFor, presetOf, EVAL_PRESETS } from './evalscale.ts';
import { merge } from '../settings.ts';

test('cp と勝率の往復（エンジンごとの目盛り）', () => {
  const e = { scale: 435, offsetCp: 34 };
  assert.equal(pToCp(cpToP(300, e), e), 300);
  assert.ok(Math.abs(cpToP(34, e) - 0.5) < 1e-9);
  assert.equal(pToCp(0.5), 0);
  assert.ok(Object.is(pToCp(0.5), 0), '-0 を返さない');
  // 水匠5の実行ファイル（FV_SCALE 24）は同じ局面で cp が 1.5 倍。目盛りを比例させれば勝率は同じ
  const fv24 = EVAL_PRESETS.find((p) => p.id === 'suisho5-fv24')!.eval;
  assert.ok(Math.abs(cpToP(300 * 1.5, fv24) - cpToP(300, e)) < 0.002);
});

test('id name からの提案（レシピ）', () => {
  assert.equal(recipeFor('Suisho5(20211123)')?.name, '水匠5');
  assert.equal(recipeFor('YaneuraOu NNUE 8.30git')?.name, 'やねうら王');
  assert.equal(recipeFor('Tenbin Fuseki Engine 0.1')?.kind, 'fuseki');
  assert.equal(recipeFor('Gikou 2'), null);
  assert.equal(presetOf({ scale: 600, offsetCp: 0 })?.id, 'generic');
  assert.equal(presetOf({ scale: 601, offsetCp: 0 }), null);
});

test('以前の設定（threads/hashMb/evalDir と全体の winrate）を options と eval に写す', () => {
  const s = merge({
    engines: [{ id: 'a', name: 'やね', path: '/x/yane', threads: 8, hashMb: 512, multiPv: 5, evalDir: '/x/eval', kind: 'normal', options: { BookFile: 'no_book' } } as never],
    winrate: { scale: 435, offsetCp: 34 },
    analysisEngineId: 'a',
  });
  const e = s.engines[0]!;
  assert.deepEqual(e.options, { BookFile: 'no_book', Threads: '8', USI_Hash: '512', MultiPV: '5', EvalDir: '/x/eval' });
  assert.deepEqual(e.eval, { scale: 435, offsetCp: 34 });
  assert.equal(s.normalEngineId, 'a');
  assert.equal(s.fusekiEngineId, 'builtin');
  assert.deepEqual(s.analysisSlots, ['auto']);
});

test('消えたエンジンを指す既定は捨てる', () => {
  const s = merge({ engines: [], normalEngineId: 'gone', fusekiEngineId: 'gone', analysisSlots: ['gone'] });
  assert.equal(s.normalEngineId, undefined);
  assert.equal(s.fusekiEngineId, 'builtin');
});
