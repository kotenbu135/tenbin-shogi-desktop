// KIF 形式の読み書き。
//
// 本将棋の部分は普通の KIF（７六歩(77) / 同　銀(31) / ４五角打 / 投了）。布石の手は駒打ちの書式
// 「５九玉打」で書き、先後の選択はコメント行「*choose:sente」で残す。手合割は
// 「天秤将棋」「布石将棋」、任意局面からなら「その他」と局面図。
//
// 将棋所や ShogiHome は空の盤に玉を持ち駒にした局面を読めないので、布石を含む棋譜は
// このアプリの方言になる。本将棋だけを普通の KIF にしたいときは exportNormalOnly() を使う。
//
// もう 1 つ、tenbinshogi.com の「棋譜をコピー」が出す形も読む。あちらは 41 手目の局面を
// 局面図に置いて本将棋の手を 1 手目から並べ（＝通常の将棋ソフトでも開ける）、布石 40 手と
// 先後の選択をヘッダタグ「天秤布石」「天秤選択」に USI で持たせる。タグがあれば玉を置く
// 1 手目から並べ直せるので、天秤モードとして読む。

import { makeUsi, parseSquareName } from 'shogiops/util';
import { makeKifHeader, makeKifMoveOrDrop, normalizedKifLines, parseKifHeader, parseKifMoveOrDrop, parseTags } from 'shogiops/notation/kif';
import { makeSfen } from 'shogiops/sfen';
import type { Square } from 'shogiops/types';
import { Game, colorName, type Mode } from '../state/game.ts';
import { formatTimeControl, parseTimeControl, type MoveTime, type TimeControl } from '../state/clock.ts';

export interface KifMeta {
  sente?: string;
  gote?: string;
  timeControl?: TimeControl | null;
  startedAt?: Date;
}

export interface ParsedKif {
  mode: Mode;
  startSfen?: string;
  tokens: string[];
  times: (MoveTime | undefined)[];
  sente?: string;
  gote?: string;
  timeControl: TimeControl | null;
}

/** これがヘッダに 1 つも無ければ KIF ではないと見なす。'a:b' のような文字列も parseTags は拾うため */
const KIF_TAGS = ['手合割', '先手', '後手', '上手', '下手', '開始日時', '終了日時', '棋戦', '場所', '持ち時間', '表題', '戦型', '先手の持駒', '後手の持駒'];

const ZEN_DIGITS = '１２３４５６７８９';
const KANJI_RANKS = '一二三四五六七八九';
const KANJI_ROLE: Record<string, string> = { 玉: 'K', 王: 'K', 飛: 'R', 角: 'B', 金: 'G', 銀: 'S', 桂: 'N', 香: 'L', 歩: 'P' };

function zen(n: number): string {
  return ZEN_DIGITS[n - 1] ?? String(n);
}

function timeText(t: MoveTime | undefined): string {
  if (!t) return '';
  const m = Math.floor(t.elapsed / 60);
  const s = t.elapsed % 60;
  const th = Math.floor(t.total / 3600);
  const tm = Math.floor((t.total % 3600) / 60);
  const ts = t.total % 60;
  return `(${String(m).padStart(2, ' ')}:${String(s).padStart(2, '0')}/${String(th).padStart(2, '0')}:${String(tm).padStart(2, '0')}:${String(ts).padStart(2, '0')})`;
}

function pad(s: string, width: number): string {
  // 全角は2幅として揃える
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return s + ' '.repeat(Math.max(1, width - w));
}

function dropKif(usi: string): string {
  const role = usi[0]!;
  const sq = usi.slice(2, 4);
  const f = Number(sq[0]);
  const r = sq.charCodeAt(1) - 96;
  const kanji = Object.entries(KANJI_ROLE).find(([, v]) => v === role)?.[0] ?? role;
  return `${zen(f)}${KANJI_RANKS[r - 1]}${kanji}打`;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 対局を KIF にする。形は 1 つ（tenbinshogi.com と同じ）で、貼り付け先によって読める量が変わる。
 * 天秤将棋は 41 手目の局面を局面図に置き、布石をヘッダタグに入れる（＝将棋所や ShogiHome でも
 * 開けて、このアプリなら玉の配置から並べ直せる）。布石将棋はこのアプリの方言のまま
 * （先後の選択が無く、天秤将棋とは別のルールなので、同じタグに混ぜない）。
 */
export function writeKif(game: Game, meta: KifMeta = {}): string {
  return game.mode === 'tenbin' ? writeTenbinKif(game, meta) : writeDialectKif(game, meta);
}

/** 布石の消費時間のタグ 1 つぶん。"3/12"（この手に 3 秒、通算 12 秒）。時間が無い手は "-" */
function secsText(t: MoveTime | undefined): string {
  return t ? `${t.elapsed}/${t.total}` : '-';
}

/**
 * 天秤将棋の 1 局。布石 40 手と先後の選択はヘッダタグに、本将棋の手は局面図からの 1 手目として
 * 並べる。布石を指し手として書かないのは、KIF に「空の盤＋持ち駒 20 枚（玉を含む）」を表す
 * 書き方が無く、書くとどの将棋ソフトでも開けなくなるため。
 */
function writeTenbinKif(game: Game, meta: KifMeta): string {
  const lines: string[] = [];
  lines.push('# KIF形式棋譜ファイル 天秤将棋GUI');
  if (meta.startedAt) lines.push(`開始日時：${stamp(meta.startedAt)}`);
  lines.push(`先手：${meta.sente ?? ''}`);
  lines.push(`後手：${meta.gote ?? ''}`);
  const tc = formatTimeControl(meta.timeControl ?? null);
  if (tc) lines.push(`持ち時間：${tc}`);
  const drops = game.moves.filter((m) => m.ply !== null && m.phase !== 'normal' && m.usi !== 'resign' && m.usi !== 'timeout');
  // 布石が 0 手（玉を置く前に終わった対局）でもタグは書く。これが天秤将棋の目印で、
  // 無いと局面図も指し手も無い棋譜になり、開き直したときに平手として読まれてしまう
  lines.push(`天秤布石：${drops.map((m) => m.usi).join(' ')}`);
  if (game.chosenColor) lines.push(`天秤選択：${game.chosenColor}`);
  // 布石の消費時間はサイトの棋譜には無い。こちらは時計があるので、消えないように別のタグで持つ
  if (drops.some((m) => m.time)) lines.push(`天秤布石消費時間：${drops.map((m) => secsText(m.time)).join(' ')}`);
  // 局面図は 41 手目の局面。まだ本将棋に入っていなければ布石の途中の盤
  const start = game.startPosition() ?? game.fusekiPosition();
  if (start) lines.push(makeKifHeader(start));
  lines.push('手数----指手---------消費時間--');
  let n = 0;
  for (const step of game.normalSteps()) {
    n++;
    lines.push(`${String(n).padStart(4, ' ')} ${pad(makeKifMoveOrDrop(step.pos, step.md, step.lastDest) ?? step.record.usi, 14)}${timeText(step.record.time)}`);
  }
  const last = game.moves[game.moves.length - 1];
  const ended = !!last && (last.usi === 'resign' || last.usi === 'timeout');
  if (ended) {
    n++;
    lines.push(`${String(n).padStart(4, ' ')} ${pad(last.usi === 'resign' ? '投了' : '切れ負け', 14)}${timeText(last.time)}`);
  }
  if (game.over) {
    const w = game.over.winner;
    // 「まで n 手」は局面図から数えた本将棋の手数（投了・切れ負けの行は数えない）
    const played = ended ? n - 1 : n;
    lines.push(w ? `まで${played}手で${colorName(w)}の勝ち` : `まで${played}手で引き分け`);
  }
  return lines.join('\n') + '\n';
}

/** 布石将棋（と任意局面）の KIF。布石を指し手として書くこのアプリの方言。 */
function writeDialectKif(game: Game, meta: KifMeta): string {
  const lines: string[] = [];
  lines.push('# KIF形式棋譜ファイル 天秤将棋GUI');
  if (meta.startedAt) lines.push(`開始日時：${stamp(meta.startedAt)}`);
  const kind = game.mode === 'fuseki' ? '布石将棋' : 'その他';
  lines.push(`手合割：${kind}`);
  if (game.mode === 'position') {
    const start = game.startPosition();
    if (start) lines.push(makeKifHeader(start));
  } else {
    lines.push('*空の盤に双方が20枚ずつ自陣四段目以内へ打ってから指す。1〜40手目は駒打ち');
  }
  lines.push(`先手：${meta.sente ?? ''}`);
  lines.push(`後手：${meta.gote ?? ''}`);
  const tc = formatTimeControl(meta.timeControl ?? null);
  if (tc) lines.push(`持ち時間：${tc}`);
  lines.push('手数----指手---------消費時間--');

  const normal = new Map<number, string>();
  for (const step of game.normalSteps()) {
    normal.set(step.record.index, makeKifMoveOrDrop(step.pos, step.md, step.lastDest) ?? step.record.usi);
  }
  let plies = 0;
  for (const m of game.moves) {
    if (m.usi.startsWith('choose:')) {
      lines.push(`*${m.usi}`);
      continue;
    }
    let text: string;
    if (m.usi === 'resign') text = '投了';
    else if (m.usi === 'timeout') text = '切れ負け';
    else if (m.phase === 'normal') text = normal.get(m.index) ?? m.usi;
    else text = dropKif(m.usi);
    if (m.usi !== 'resign' && m.usi !== 'timeout') plies = m.ply ?? plies;
    lines.push(`${String(m.ply ?? 0).padStart(4, ' ')} ${pad(text, 14)}${timeText(m.time)}`);
  }
  if (game.over) {
    const w = game.over.winner;
    lines.push(w ? `まで${plies}手で${colorName(w)}の勝ち` : `まで${plies}手で引き分け`);
  }
  return lines.join('\n') + '\n';
}

/** 本将棋の部分だけを、41手目（または開始局面）の局面図つきの普通の KIF にする。将棋所や ShogiHome で開ける。 */
export function writeNormalOnlyKif(game: Game, meta: KifMeta = {}): string | null {
  const start = game.startPosition();
  if (!start) return null;
  const lines: string[] = [];
  lines.push('# KIF形式棋譜ファイル 天秤将棋GUI（本将棋の部分）');
  lines.push('手合割：その他');
  lines.push(makeKifHeader(start));
  lines.push(`先手：${meta.sente ?? ''}`);
  lines.push(`後手：${meta.gote ?? ''}`);
  lines.push('手数----指手---------消費時間--');
  let n = 0;
  for (const step of game.normalSteps()) {
    n++;
    lines.push(`${String(n).padStart(4, ' ')} ${pad(makeKifMoveOrDrop(step.pos, step.md, step.lastDest) ?? step.record.usi, 14)}${timeText(step.record.time)}`);
  }
  const last = game.moves[game.moves.length - 1];
  const ended = !!last && (last.usi === 'resign' || last.usi === 'timeout');
  if (ended) {
    n++;
    lines.push(`${String(n).padStart(4, ' ')} ${pad(last.usi === 'resign' ? '投了' : '切れ負け', 14)}${timeText(last.time)}`);
  }
  if (game.over) {
    const w = game.over.winner;
    // 「まで n 手」は指した手の数。投了・切れ負けの行は数えない（詰みや裁定で終わったときは行が無い）
    const played = ended ? n - 1 : n;
    lines.push(w ? `まで${played}手で${colorName(w)}の勝ち` : `まで${played}手で引き分け`);
  }
  return lines.join('\n') + '\n';
}

function parseTime(s: string | undefined): MoveTime | undefined {
  if (!s) return undefined;
  const m = /\(\s*(\d+):(\d+)\/(\d+):(\d+):(\d+)\)/.exec(s);
  if (!m) return undefined;
  return { elapsed: Number(m[1]) * 60 + Number(m[2]), total: Number(m[3]) * 3600 + Number(m[4]) * 60 + Number(m[5]) };
}

function parseFusekiDrop(text: string): string | null {
  const m = /^([１-９1-9])([一二三四五六七八九1-9])(玉|王|飛|角|金|銀|桂|香|歩)打?$/.exec(text);
  if (!m) return null;
  const f = ZEN_DIGITS.indexOf(m[1]!) >= 0 ? ZEN_DIGITS.indexOf(m[1]!) + 1 : Number(m[1]);
  const r = KANJI_RANKS.indexOf(m[2]!) >= 0 ? KANJI_RANKS.indexOf(m[2]!) + 1 : Number(m[2]);
  return `${KANJI_ROLE[m[3]!]}*${f}${String.fromCharCode(96 + r)}`;
}

/**
 * tenbinshogi.com が付けるヘッダタグ「天秤布石」「天秤選択」。KIF を正規化する前の生の文字から
 * 読む（正規化に落とされたり全角化されたりしても拾えるように、区切りは全角・半角の両方を見る）。
 */
function parseTenbinTags(
  text: string,
): { fuseki: string[]; chosen: 'sente' | 'gote' | null; times: (MoveTime | undefined)[] } | null {
  const f = /^[ \t　]*天秤布石[ \t　]*[：:][ \t　]*(.*)$/m.exec(text);
  if (!f) return null;
  // 値が空のタグ（玉を置く前に終わった対局）も天秤将棋の目印として受ける
  const raw = f[1]!.trim();
  const fuseki = raw ? raw.split(/[\s　]+/) : [];
  if (!fuseki.every((u) => /^[PLNSGBRK]\*[1-9][a-i]$/.test(u))) {
    throw new Error(`天秤布石のタグを駒打ちの並びとして読めない: ${raw}`);
  }
  const c = /^[ \t　]*天秤選択[ \t　]*[：:][ \t　]*(sente|gote)[ \t　]*$/m.exec(text);
  // 消費時間のタグはこのアプリだけが書く（サイトの棋譜には無い）。数が合わなければ時間だけ捨てる
  const t = /^[ \t　]*天秤布石消費時間[ \t　]*[：:][ \t　]*(.+)$/m.exec(text);
  const cells = t ? t[1]!.trim().split(/[\s　]+/) : [];
  const times =
    cells.length === fuseki.length
      ? cells.map((cell) => {
          const m = /^(\d+)\/(\d+)$/.exec(cell);
          return m ? { elapsed: Number(m[1]), total: Number(m[2]) } : undefined;
        })
      : [];
  return { fuseki, chosen: c ? (c[1] as 'sente' | 'gote') : null, times };
}

/** KIF を読む。このアプリの方言、tenbinshogi.com の形、普通の KIF（平手・局面図つき）の 3 つ。 */
export function parseKif(text: string): ParsedKif {
  const lines = normalizedKifLines(text);
  const headerEnd = lines.findIndex((l) => l.startsWith('手数--'));
  const headerLines = headerEnd >= 0 ? lines.slice(0, headerEnd) : lines;
  const tags = new Map(parseTags(headerLines.join('\n')));
  const kind = tags.get('手合割') ?? '';
  // 方言（布石を指し手として書いた棋譜）では布石は本文にある。タグを見るのはそれ以外のときだけ
  const dialect = kind.includes('天秤') || kind.includes('布石');
  const tenbin = dialect ? null : parseTenbinTags(text);
  let mode: Mode = dialect ? (kind.includes('天秤') ? 'tenbin' : 'fuseki') : tenbin ? 'tenbin' : 'position';
  let startSfen: string | undefined;
  if (mode === 'position') {
    const r = parseKifHeader(headerLines.join('\n'));
    if (r.isOk) startSfen = makeSfen(r.value);
  }
  const timeControl = parseTimeControl(tags.get('持ち時間') ?? '');
  const tokens: string[] = [];
  const times: (MoveTime | undefined)[] = [];
  if (tenbin) {
    // 布石はタグから。選択は 2 手目（両玉を置いた直後）に入る
    for (const [i, usi] of tenbin.fuseki.entries()) {
      tokens.push(usi);
      times.push(tenbin.times[i]);
      if (i === 1 && tenbin.chosen) {
        tokens.push(`choose:${tenbin.chosen}`);
        times.push(undefined);
      }
    }
  }
  let lastDest: Square | undefined;
  let ply = 0;
  const body = headerEnd >= 0 ? lines.slice(headerEnd + 1) : [];
  for (const raw of body) {
    // normalizedKifLines は ':' を '：' に直すので、本文側はこちらで半角に戻す
    const line = raw.trim().replace(/：/g, ':');
    if (!line) continue;
    const ch = /^\*choose:(sente|gote)/.exec(line);
    if (ch) {
      tokens.push(`choose:${ch[1]}`);
      times.push(undefined);
      continue;
    }
    if (line.startsWith('*') || line.startsWith('#') || line.startsWith('まで')) continue;
    // normalizedKifLines が「同　銀」の全角空白を半角にするので、「同」の後ろの空白は手の一部として読む
    const m = /^(\d+)\s+(同\s*\S+|\S+)(?:\s+(\(.*\)))?/.exec(line);
    if (!m) continue;
    const mv = m[2]!;
    const time = parseTime(m[3]);
    if (mv === '投了') { tokens.push('resign'); times.push(time); break; }
    if (mv === '切れ負け') { tokens.push('timeout'); times.push(time); break; }
    if (mv === '中断' || mv === '千日手' || mv === '持将棋' || mv === '不戦勝' || mv === '不戦敗' || mv === '反則勝ち' || mv === '反則負け' || mv === '入玉勝ち' || mv === '詰み' || mv === '不詰') break;
    ply++;
    if (dialect && ply <= 40) {
      const usi = parseFusekiDrop(mv);
      if (!usi) throw new Error(`${ply}手目を布石の駒打ちとして読めない: ${mv}`);
      tokens.push(usi);
      times.push(time);
      lastDest = parseSquareName(usi.slice(2, 4));
      continue;
    }
    const md = parseKifMoveOrDrop(mv, lastDest);
    if (!md) throw new Error(`${ply}手目を読めない: ${mv}`);
    tokens.push(makeUsi(md));
    times.push(time);
    lastDest = md.to;
  }
  // KIF でない文字を黙って平手 0 手として返さない（貼り付けが「読めた」ように見えるのを防ぐ）。
  // parseKifHeader は局面図が無くても平手を返すので、startSfen の有無では見分けられない
  const looksKif =
    headerEnd >= 0 ||
    tokens.length > 0 ||
    /^[+|]/m.test(text) ||
    KIF_TAGS.some((k) => tags.has(k));
  if (!looksKif) throw new Error('KIF として読めない（棋譜の見出しも局面図も指し手も無い）');
  return { mode, startSfen, tokens, times, sente: tags.get('先手'), gote: tags.get('後手'), timeControl };
}

/** 布石の駒打ちの USI を KIF 表記にする（表示・テスト用） */
export function fusekiDropKif(usi: string): string {
  return dropKif(usi);
}
