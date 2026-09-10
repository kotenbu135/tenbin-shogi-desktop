// 持ち時間の書式（KIF の「持ち時間：00:10+30」）。読み書きが食い違うと、保存して開き直した
// 対局の時間が変わる。

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTimeControl, parseTimeControl } from './clock.ts';

test('持ち時間の書式の往復', () => {
  for (const tc of [
    { mainSec: 600, byoyomiSec: 30 },
    { mainSec: 0, byoyomiSec: 60 },
    { mainSec: 3600, byoyomiSec: 0 },
    { mainSec: 5400, byoyomiSec: 10 },
  ]) {
    assert.deepEqual(parseTimeControl(formatTimeControl(tc)), tc);
  }
});

test('時間無しは空文字。空文字は null', () => {
  assert.equal(formatTimeControl(null), '');
  assert.equal(formatTimeControl({ mainSec: 0, byoyomiSec: 0 }), '');
  assert.equal(parseTimeControl(''), null);
  assert.equal(parseTimeControl('なし'), null);
});

test('KIF の正規化で全角になったコロンも読む', () => {
  assert.deepEqual(parseTimeControl('00：25＋00'.replace('＋', '+')), { mainSec: 1500, byoyomiSec: 0 });
  assert.deepEqual(parseTimeControl(' 01:00+60 '), { mainSec: 3600, byoyomiSec: 60 });
});
