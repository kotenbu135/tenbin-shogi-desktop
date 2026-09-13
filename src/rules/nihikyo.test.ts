// 二飛香（天秤将棋の禁じ手、2026-09-13 決定、GitHub Issue #1）のテスト。
//
// 判定そのものは同梱の wasm（public/wasm/fuseki.mjs）が持つので、ここでは本物の wasm を Node で読み、
//   - Issue の「確認用の手順」が天秤将棋でだけ反則になり、布石将棋と旧ルール（1 版）では合法のまま
//   - 40 手目の制限と重なっても二飛香は外れない
//   - 版の書かれていない棋譜の版を決め、旧ルールの棋譜を待った・分岐・過去の局面まで旧ルールで並べられる
// を見る。版の受け渡しが 1 箇所でも抜けると、旧ルールの棋譜がどこかで「合法な駒打ちではない」で止まる。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Fuseki, FUSEKI_RULE_NIHIKYO, FUSEKI_RULE_NONE } from './fuseki.ts';
import { Game, rebuild, rulesForTokens, TENBIN_RULES, TENBIN_RULES_V1, type Mode, type TenbinRules } from '../state/game.ts';
import { parseKif } from '../kif/tenbin-kif.ts';

const WASM = pathToFileURL(path.resolve(import.meta.dirname, '../../public/wasm/fuseki.mjs')).href;
const fuseki = await Fuseki.load(WASM);

// Issue の「確認用の手順」。24 手目は後手番
const NIHIKYO_24 = 'K*8g K*6b choose:sente P*1g R*8a S*7g N*7c S*9g P*4d L*5g S*6c P*8f B*3b B*3f P*8d G*8h P*3d P*5i G*7b N*4f P*7d P*9f P*9d G*6h';
const NIHIKYO_40 = `${NIHIKYO_24} P*1d P*2h G*5b P*4g S*4c P*7f P*6d N*6f P*2d P*3g N*5d R*2f P*5c P*6g L*2c L*7i L*5a`;
// 後手玉 5c に先手の飛 5f が当たったまま 39 手を打ち終え、後手の最後の 1 枚は香。
// 遮る 5d は、5b に後手の香があるので二飛香で打てない（公開サイトのテストと同じ手順）
const BLOCK_ONLY_BY_LANCE =
  'K*5i K*5c choose:sente R*5f P*5a P*1f L*5b P*2f P*1a P*3f P*2a P*4f P*3a P*5g P*4a ' +
  'P*6f P*6a P*7f P*7a P*8f P*8a P*9f P*9a L*1g N*1b L*2g N*1c N*1h S*1d N*1i S*2b S*2h G*2c S*2i G*2d G*3g B*3b G*3h R*3c B*3i';

const split = (s: string): string[] => s.split(' ');

/** 手順を並べ、手番側の合法な駒打ちを返す。布石将棋では選択のトークンを抜く（手番の色は同じ） */
function play(tokens: string, mode: Mode = 'tenbin', rules: TenbinRules = TENBIN_RULES): { g: Game; legal: Set<string> } {
  const list = split(tokens).filter((x) => mode === 'tenbin' || !x.startsWith('choose:'));
  const g = rebuild(fuseki, mode, list, { rules });
  return { g, legal: new Set(g.legalDrops().map((d) => d.usi)) };
}

test('wasm の旗: 天秤将棋のいまの版だけに二飛香を掛ける', () => {
  assert.equal(new Game(fuseki, 'tenbin').fusekiRules, FUSEKI_RULE_NIHIKYO);
  assert.equal(new Game(fuseki, 'tenbin', undefined, TENBIN_RULES_V1).fusekiRules, FUSEKI_RULE_NONE);
  assert.equal(new Game(fuseki, 'fuseki').fusekiRules, FUSEKI_RULE_NONE);
});

test('後手の反則: 8筋に後手の飛があれば香を打てない', () => {
  const { g, legal } = play(NIHIKYO_24);
  assert.equal(g.turn, 'gote');
  assert.equal(legal.has('L*8c'), false);
  assert.equal(legal.has('P*1d'), true);
  assert.throws(() => g.apply('L*8c'), /L\*8c/);
});

test('先手の反則: 5筋に先手の飛があれば香を打てない', () => {
  const { legal } = play('K*5i K*5a choose:sente R*5h P*1c');
  assert.equal(legal.has('L*5g'), false);
  assert.equal(legal.has('L*4g'), true);
});

test('相手の飛・香は数えない', () => {
  const { g, legal } = play('K*5i K*5a choose:sente R*5h');
  assert.equal(g.turn, 'gote');
  assert.equal(legal.has('L*5c'), true);
});

test('布石将棋と旧ルール（1 版）では同じ手が合法のまま', () => {
  assert.equal(play(NIHIKYO_24, 'fuseki').legal.has('L*8c'), true);
  assert.equal(play('K*5i K*5a choose:sente R*5h P*1c', 'fuseki').legal.has('L*5g'), true);
  assert.equal(play(NIHIKYO_24, 'tenbin', TENBIN_RULES_V1).legal.has('L*8c'), true);
});

test('二飛香に合う 40 手は、いまの版でも旧ルールでも 41 手目まで入る', () => {
  for (const rules of [TENBIN_RULES, TENBIN_RULES_V1]) assert.equal(play(NIHIKYO_40, 'tenbin', rules).g.phase, 'normal', `${rules} 版`);
});

test('40 手目: 遮る手が二飛香で打てなければ制限が外れ、二飛香は外れない', () => {
  const { g, legal } = play(BLOCK_ONLY_BY_LANCE);
  assert.equal(legal.has('L*5d'), false);
  assert.ok(legal.size > 0, '打てる手が無い');
  for (const u of legal) assert.ok(u[2] !== '3' && u[2] !== '5', `飛・香のある筋に打てる: ${u}`);
  g.apply([...legal][0]!);
  assert.deepEqual(g.over, { winner: 'sente', reason: { kind: 'ruling41' } });
  assert.deepEqual([...play(BLOCK_ONLY_BY_LANCE, 'tenbin', TENBIN_RULES_V1).legal], ['L*5d']);
});

test('版の書かれていない手順の版を決める', () => {
  assert.equal(rulesForTokens(fuseki, split(NIHIKYO_40)), TENBIN_RULES);
  assert.equal(rulesForTokens(fuseki, split(`${NIHIKYO_24} L*8c`)), TENBIN_RULES_V1);
  // どちらの版でも入らない手順はいまの版（止まった手は、その版で並べた呼び手が言う）
  assert.equal(rulesForTokens(fuseki, split(`${NIHIKYO_24} K*5e`)), TENBIN_RULES);
  assert.throws(() => rebuild(fuseki, 'tenbin', split(`${NIHIKYO_24} K*5e`)), /24.*K\*5e/);
});

test('旧ルールの棋譜: KIF から読み、待った・分岐・過去の局面まで旧ルールのまま並べられる', () => {
  // tenbinshogi.com の形（布石はヘッダタグ）。旧ルールで指された 24 手目 L*8c を含む
  const drops = split(`${NIHIKYO_24} L*8c`).filter((x) => !x.startsWith('choose:'));
  const kif = [`天秤布石：${drops.join(' ')}`, '天秤選択：sente', '手数----指手---------消費時間--'].join('\n');
  const k = parseKif(kif);
  assert.equal(k.mode, 'tenbin');
  assert.throws(() => rebuild(fuseki, k.mode, k.tokens), /L\*8c/, 'いまの版では入らない');
  const rules = rulesForTokens(fuseki, k.tokens);
  assert.equal(rules, TENBIN_RULES_V1);

  const game = rebuild(fuseki, k.mode, k.tokens, { rules });
  assert.equal(game.moves.length, 25);
  // 過去の局面を見たあと、wasm を自分の棋譜どおりに戻せる（resync も旧ルールで並べる）
  const before = game.legalDrops().map((d) => d.usi);
  assert.equal(game.viewAt(10).ply, 9);
  assert.deepEqual(game.legalDrops().map((d) => d.usi), before);
  // 待った（1 手戻して、また指す）
  const undone = rebuild(fuseki, game.mode, game.tokens().slice(0, -1), { rules: game.rules });
  assert.equal(undone.canApply('L*8c'), true);
  undone.apply('L*8c');
  // 分岐して先へ進める
  const branched = rebuild(fuseki, game.mode, game.tokens(), { rules: game.rules });
  assert.equal(branched.rules, TENBIN_RULES_V1);
  branched.apply(branched.legalDrops()[0]!.usi);
  assert.equal(branched.moves.length, 26);
});
