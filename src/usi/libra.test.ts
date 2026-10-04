import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersion, libraUnsupported, libraVersionOf, parseVersion, windowsAsset } from './libra.ts';

test('版を読む', () => {
  assert.deepEqual(parseVersion('v0.3'), [0, 3, 0]);
  assert.deepEqual(parseVersion('0.3.1'), [0, 3, 1]);
  assert.equal(parseVersion('latest'), null);
  assert.deepEqual(libraVersionOf('LibraShogi 0.3.0'), [0, 3, 0]);
  assert.equal(libraVersionOf('YaneuraOu NNUE 9.00'), null);
});

test('0.2 以前の Libra はサポート外、0.3 以降と他のエンジンは対象外', () => {
  assert.equal(libraUnsupported({ idName: 'LibraShogi 0.2.0' }), true);
  assert.equal(libraUnsupported({ idName: 'LibraShogi 0.1.0' }), true);
  assert.equal(libraUnsupported({ idName: 'LibraShogi 0.3.0' }), false);
  assert.equal(libraUnsupported({ idName: 'Tenbin Fuseki Engine 0.1' }), false);
  assert.equal(libraUnsupported({}), false);
});

test('タグと名乗りを比べる', () => {
  assert.ok(compareVersion(parseVersion('v0.4')!, libraVersionOf('LibraShogi 0.3.0')!) > 0);
  assert.equal(compareVersion(parseVersion('v0.3')!, libraVersionOf('LibraShogi 0.3.0')!), 0);
});

test('Windows 版の zip を選ぶ', () => {
  const assets = [
    { name: 'libra-v0.3-selfplay-sample.jsonl.gz' },
    { name: 'libra-v0.3-windows-x64.zip' },
    { name: 'libra-v0.3.onnx' },
    { name: 'SHA256SUMS' },
  ];
  assert.equal(windowsAsset(assets)?.name, 'libra-v0.3-windows-x64.zip');
  assert.equal(windowsAsset([{ name: 'libra-v0.3.onnx' }]), null);
});
