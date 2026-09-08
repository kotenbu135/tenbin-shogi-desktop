// KIF 形式の読み書き。
//
// 本将棋の部分は普通の KIF（７六歩(77) / 同　銀(31) / ４五角打 / 投了）。布石の手は駒打ちの書式
// 「５九玉打」で書き、先後の選択はコメント行「*choose:sente」で残す。手合割は
// 「天秤将棋」「布石将棋」、任意局面からなら「その他」と局面図。
//
// 将棋所や ShogiHome は空の盤に玉を持ち駒にした局面を読めないので、布石を含む棋譜は
// このアプリの方言になる。本将棋だけを普通の KIF にしたいときは exportNormalOnly() を使う。

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

/** 対局全体を KIF（このアプリの方言）にする。 */
export function writeKif(game: Game, meta: KifMeta = {}): string {
  const lines: string[] = [];
  lines.push('# KIF形式棋譜ファイル 天秤将棋デスクトップ');
  if (meta.startedAt) lines.push(`開始日時：${stamp(meta.startedAt)}`);
  const kind = game.mode === 'tenbin' ? '天秤将棋' : game.mode === 'fuseki' ? '布石将棋' : 'その他';
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
  lines.push('# KIF形式棋譜ファイル 天秤将棋デスクトップ（本将棋の部分）');
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
  if (last && (last.usi === 'resign' || last.usi === 'timeout')) {
    n++;
    lines.push(`${String(n).padStart(4, ' ')} ${pad(last.usi === 'resign' ? '投了' : '切れ負け', 14)}${timeText(last.time)}`);
  }
  if (game.over) {
    const w = game.over.winner;
    lines.push(w ? `まで${n - 1}手で${colorName(w)}の勝ち` : `まで${n}手で引き分け`);
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

/** KIF を読む。このアプリの方言と、普通の KIF（平手・局面図つき）の両方。 */
export function parseKif(text: string): ParsedKif {
  const lines = normalizedKifLines(text);
  const headerEnd = lines.findIndex((l) => l.startsWith('手数--'));
  const headerLines = headerEnd >= 0 ? lines.slice(0, headerEnd) : lines;
  const tags = new Map(parseTags(headerLines.join('\n')));
  const kind = tags.get('手合割') ?? '';
  let mode: Mode = kind.includes('天秤') ? 'tenbin' : kind.includes('布石') ? 'fuseki' : 'position';
  let startSfen: string | undefined;
  if (mode === 'position') {
    const r = parseKifHeader(headerLines.join('\n'));
    if (r.isOk) startSfen = makeSfen(r.value);
  }
  const timeControl = parseTimeControl(tags.get('持ち時間') ?? '');
  const tokens: string[] = [];
  const times: (MoveTime | undefined)[] = [];
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
    const m = /^(\d+)\s+(\S+)(?:\s+(\(.*\)))?/.exec(line);
    if (!m) continue;
    const mv = m[2]!;
    const time = parseTime(m[3]);
    if (mv === '投了') { tokens.push('resign'); times.push(time); break; }
    if (mv === '切れ負け') { tokens.push('timeout'); times.push(time); break; }
    if (mv === '中断' || mv === '千日手' || mv === '持将棋' || mv === '不戦勝' || mv === '不戦敗' || mv === '反則勝ち' || mv === '反則負け' || mv === '入玉勝ち') break;
    ply++;
    if (mode !== 'position' && ply <= 40) {
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
  return { mode, startSfen, tokens, times, sente: tags.get('先手'), gote: tags.get('後手'), timeControl };
}

/** 布石の駒打ちの USI を KIF 表記にする（表示・テスト用） */
export function fusekiDropKif(usi: string): string {
  return dropKif(usi);
}
