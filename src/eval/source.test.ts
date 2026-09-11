import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirSource, plainName, urlSource } from './source.ts';

test('manifest のファイル名は同じフォルダの中だけを指せる', () => {
  assert.equal(plainName('fuseki_degct_b3_iter2455.onnx'), 'fuseki_degct_b3_iter2455.onnx');
  // 模型の一覧はこちらが書いたとは限らない（利用者が指したフォルダの中身）。
  // 繋いだ先が外へ出る形は全部弾く
  for (const bad of ['', '..', '.', '../x.onnx', 'a/b.onnx', 'a\\b.onnx', '/etc/passwd']) {
    assert.throws(() => plainName(bad), new RegExp('.'), `弾けていない: ${bad}`);
  }
});

test('同梱は URL を繋ぐ / 差し替えはフォルダを繋ぐ', async () => {
  const u = urlSource('/models');
  assert.equal(u.dir, null);
  assert.equal(await u.model('a.onnx'), '/models/a.onnx');

  // 末尾の区切りは足しても足さなくても同じ場所を指す
  assert.equal(dirSource('/tmp/m/').dir, '/tmp/m');
  assert.equal(dirSource('/tmp/m').dir, '/tmp/m');
  assert.equal(dirSource('C:\\models\\iter2455\\').dir, 'C:\\models\\iter2455');
});
