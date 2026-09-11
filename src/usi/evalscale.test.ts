import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpToP, pToCp, recipeFor, presetOf, evalFromDeclaration, EVAL_PRESETS } from './evalscale.ts';
import { readySecOf, usesGpu, GPU_READY_SEC, READY_SEC } from './engine.ts';
import { merge } from '../settings.ts';
import type { UsiOption } from './parse.ts';

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

test('GPU のエンジンは申告で見分ける（名前ではなく DNN_ の項目）', () => {
  const dl: UsiOption[] = [
    { name: 'DNN_Model', type: 'filename', default: 'model.onnx' },
    { name: 'UCT_Threads', type: 'spin', default: '2' },
    { name: 'Eval_Coef', type: 'spin', default: '285' },
  ];
  const nnue: UsiOption[] = [
    { name: 'Threads', type: 'spin', default: '4' },
    { name: 'USI_Hash', type: 'spin', default: '1024' },
  ];
  assert.equal(usesGpu(dl), true);
  assert.equal(usesGpu(nnue), false);
  assert.equal(readySecOf({ gpu: true }), GPU_READY_SEC);
  assert.equal(readySecOf({}), READY_SEC);
  assert.equal(readySecOf({ gpu: true, readySec: 60 }), 60);
  assert.equal(readySecOf({ readySec: 0 }), READY_SEC, '0 は指定なし扱い');
});

test('dlshogi 系の目盛りは Eval_Coef から読む（当てはめない）', () => {
  const coef = 285;
  const e = evalFromDeclaration([{ name: 'Eval_Coef', type: 'spin', default: String(coef) }])!;
  assert.deepEqual(e, { scale: coef, offsetCp: 0 });
  // エンジンは cp = Eval_Coef · ln(p/(1−p)) で出す。同じ式の逆なので勝率がそのまま戻る
  for (const p of [0.05, 0.4, 0.5, 0.73, 0.99]) {
    const cp = Math.round(coef * Math.log(p / (1 - p)));
    assert.ok(Math.abs(cpToP(cp, e) - p) < 0.001, `p=${p}`);
  }
  assert.equal(evalFromDeclaration([{ name: 'Threads', type: 'spin', default: '4' }]), null);
  assert.equal(evalFromDeclaration([{ name: 'Eval_Coef', type: 'spin', default: '0' }]), null);
  assert.equal(recipeFor('dlshogi with HEROZ')?.name, 'dlshogi');
  assert.equal(recipeFor('Fukauraou 8.30')?.name, 'ふかうら王');
  // Eval_Coef を申告しない古い版（dlshogi with GCT）のための既定値。600 ではない
  assert.deepEqual(recipeFor('dlshogi with GCT')?.eval, { scale: 756, offsetCp: 0 });
});

test('GPU の指定と待ち秒数は保存され、壊れた値は落ちる', () => {
  const s = merge({
    engines: [
      { id: 'g', name: 'dl', path: '/x/dl', kind: 'normal', options: {}, gpu: true, readySec: 900, eval: { scale: 285, offsetCp: 0 } } as never,
      { id: 'n', name: 'yane', path: '/x/yane', kind: 'normal', options: {}, gpu: false, readySec: -1, eval: { scale: 600, offsetCp: 0 } } as never,
    ],
  });
  assert.equal(s.engines[0]!.gpu, true);
  assert.equal(s.engines[0]!.readySec, 900);
  assert.equal(s.engines[1]!.gpu, false, '外したのを「まだ決めていない」に戻さない');
  assert.equal(s.engines[1]!.readySec, undefined);
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

test('足した模型一式（世代）は id とフォルダで守り、既定に選べる', () => {
  const s = merge({
    modelSets: [
      { id: 'builtin:a', name: 'iter2455', dir: '/m/iter2455' },
      // フォルダの無いものは登録として意味が無い（次の起動で必ず失敗する）
      { id: 'builtin:b', name: '壊れ' },
      // id が重なるものは後から来たほうを落とす（席の指す先が二重になる）
      { id: 'builtin:a', name: '同じ id', dir: '/m/other' },
      // 'builtin' そのものは同梱の席なので奪わせない
      { id: 'builtin', name: '同梱を装う', dir: '/m/fake' },
    ] as never,
    fusekiEngineId: 'builtin:a',
  });
  // 残すのは実在するフォルダぶん。id が壊れていても付け直して残す（登録は消さない）
  assert.deepEqual(s.modelSets.map((m) => m.dir), ['/m/iter2455', '/m/other', '/m/fake']);
  assert.equal(s.modelSets[0]!.id, 'builtin:a');
  assert.equal(new Set(s.modelSets.map((m) => m.id)).size, 3, 'id は重ならない');
  for (const m of s.modelSets) assert.match(m.id, /^builtin:/);
  assert.equal(s.fusekiEngineId, 'builtin:a', '足した世代は布石の既定に選べる');
});

test('消えた模型一式を指す既定は同梱へ戻す', () => {
  const s = merge({ modelSets: [], fusekiEngineId: 'builtin:gone' });
  assert.equal(s.fusekiEngineId, 'builtin');
});
