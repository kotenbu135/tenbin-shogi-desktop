// 新しい対局のダイアログ。ルール、席ごとの対局者（人か、登録したエンジンか）、持ち時間と秒読み。
//
// 席は 2 つ。天秤将棋では「玉を置く側」と「先後を選ぶ側」、布石将棋では先手と後手。
// エンジンの席は、本将棋（41 手目から）に使う USI エンジンと、布石（40 手）に使うもの（内蔵の方策か
// 布石対応のエンジン）を別々に選ぶ。強さは公開サイトのレベルと同じ温度の刻み。

import type { Mode } from '../state/game.ts';
import type { TimeControl } from '../state/clock.ts';
import { BUILTIN_ID, type Settings } from '../settings.ts';

export type PlayerSpec =
  | { type: 'human' }
  | {
      type: 'engine';
      /** 41 手目以降の USI エンジン id（無ければ '' で、本将棋は人が指す） */
      normalId: string;
      /** 布石に使うもの。'builtin' か布石対応のエンジン id */
      fusekiId: string;
      /** 1〜5。内蔵の方策の温度と探索 */
      level: number;
      /** 持ち時間が無いときの 1 手の秒数 */
      secPerMove: number;
    };

export interface NewGameChoice {
  mode: Mode;
  /** 席 A（天秤: 玉を置く側 / 布石: 先手）と席 B（天秤: 先後を選ぶ側 / 布石: 後手） */
  seats: [PlayerSpec, PlayerSpec];
  names: [string, string];
  timeControl: TimeControl | null;
}

/** 内蔵の方策のレベル。公開サイトの LEVELS と同じ温度。5 は価値ネットで K=8 の最善 */
export const LEVELS: { level: number; label: string; temperature: number; search: number }[] = [
  { level: 1, label: '1 · 気まぐれ', temperature: 1.0, search: 1 },
  { level: 2, label: '2', temperature: 0.8, search: 1 },
  { level: 3, label: '3', temperature: 0.6, search: 1 },
  { level: 4, label: '4', temperature: 0.4, search: 1 },
  { level: 5, label: '5 · 価値ネットで最善', temperature: 0.4, search: 8 },
];

export class NewGameDialog {
  private readonly dialog: HTMLDialogElement;
  private resolve: ((c: NewGameChoice | null) => void) | null = null;
  private last: NewGameChoice = {
    mode: 'tenbin',
    seats: [{ type: 'human' }, { type: 'human' }],
    names: ['', ''],
    timeControl: null,
  };

  constructor(host: HTMLElement, private readonly settings: () => Settings) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'newgame-dialog';
    host.appendChild(this.dialog);
    this.dialog.addEventListener('close', () => {
      this.resolve?.(null);
      this.resolve = null;
    });
  }

  open(): Promise<NewGameChoice | null> {
    const l = this.last;
    const s = this.settings();
    const normals = s.engines.filter((e) => e.kind === 'normal');
    const fusekis = s.engines.filter((e) => e.kind === 'fuseki');
    const mainMin = l.timeControl ? Math.round(l.timeControl.mainSec / 60) : 0;
    const byo = l.timeControl?.byoyomiSec ?? 0;
    const seat = (i: 0 | 1) => {
      const p = l.seats[i];
      const eng = p.type === 'engine' ? p : { normalId: s.normalEngineId ?? normals[0]?.id ?? '', fusekiId: s.fusekiEngineId, level: 4, secPerMove: 3 };
      return `
        <fieldset class="seat" data-seat="${i}">
          <legend class="seat-title"></legend>
          <label>名前<input name="name${i}" value="${esc(l.names[i])}" placeholder="${i === 0 ? '先手' : '後手'}" /></label>
          <div class="seat-type">
            <label><input type="radio" name="type${i}" value="human" ${p.type === 'human' ? 'checked' : ''}/> 人</label>
            <label><input type="radio" name="type${i}" value="engine" ${p.type === 'engine' ? 'checked' : ''}/> エンジン</label>
          </div>
          <div class="seat-engine" ${p.type === 'engine' ? '' : 'hidden'}>
            <label>本将棋（41手目から）<select name="normal${i}">
              <option value="">人が指す</option>
              ${normals.map((e) => `<option value="${e.id}" ${eng.normalId === e.id ? 'selected' : ''}>${esc(e.name || e.path)}</option>`).join('')}
            </select></label>
            <label>布石（40手）<select name="fuseki${i}">
              <option value="${BUILTIN_ID}" ${eng.fusekiId === BUILTIN_ID ? 'selected' : ''}>内蔵の方策</option>
              ${fusekis.map((e) => `<option value="${e.id}" ${eng.fusekiId === e.id ? 'selected' : ''}>${esc(e.name || e.path)}</option>`).join('')}
            </select></label>
            <div class="form-row two">
              <label>強さ<select name="level${i}">${LEVELS.map((lv) => `<option value="${lv.level}" ${eng.level === lv.level ? 'selected' : ''}>${lv.label}</option>`).join('')}</select></label>
              <label>1手の秒数<input name="sec${i}" type="number" min="1" max="600" value="${eng.secPerMove}" /></label>
            </div>
          </div>
        </fieldset>`;
    };
    this.dialog.innerHTML = `
      <form class="dialog-body newgame-form">
        <div class="dialog-head"><h2>新しい対局</h2></div>
        <fieldset class="kind">
          <legend>ルール</legend>
          <label><input type="radio" name="mode" value="tenbin" ${l.mode !== 'fuseki' ? 'checked' : ''}/> 天秤将棋。一方が両方の玉を置き、もう一方が先後を選ぶ</label>
          <label><input type="radio" name="mode" value="fuseki" ${l.mode === 'fuseki' ? 'checked' : ''}/> 布石将棋。空の盤に交互に20枚ずつ打ってから指す</label>
        </fieldset>
        <div class="seats">${seat(0)}${seat(1)}</div>
        <div class="form-row">
          <label>持ち時間（分）<input name="main" type="number" min="0" max="600" value="${mainMin}" /></label>
          <label>秒読み（秒）<input name="byoyomi" type="number" min="0" max="600" value="${byo}" /></label>
          <span class="hint form-hint">両方 0 なら時間は計らず、エンジンは「1手の秒数」で指す</span>
        </div>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">やめる</button>
          <button type="submit" class="primary">対局を始める</button>
        </div>
      </form>`;
    const form = this.dialog.querySelector('form')!;
    const seatTitles = () => {
      const mode = (form.elements.namedItem('mode') as RadioNodeList).value as Mode;
      const titles = mode === 'tenbin' ? ['玉を置く側', '先後を選ぶ側'] : ['先手', '後手'];
      this.dialog.querySelectorAll('.seat-title').forEach((el, i) => (el.textContent = titles[i]!));
    };
    for (const r of form.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.addEventListener('change', seatTitles);
    seatTitles();
    for (const i of [0, 1] as const) {
      const box = this.dialog.querySelector<HTMLElement>(`.seat[data-seat="${i}"] .seat-engine`)!;
      for (const r of form.querySelectorAll<HTMLInputElement>(`input[name="type${i}"]`)) {
        r.addEventListener('change', () => (box.hidden = (form.elements.namedItem(`type${i}`) as RadioNodeList).value !== 'engine'));
      }
    }
    this.dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this.dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const str = (k: string) => String(fd.get(k) ?? '').trim();
      const main = Math.max(0, Number(fd.get('main')) || 0) * 60;
      const byoyomi = Math.max(0, Number(fd.get('byoyomi')) || 0);
      const spec = (i: 0 | 1): PlayerSpec => {
        if (str(`type${i}`) !== 'engine') return { type: 'human' };
        return {
          type: 'engine',
          normalId: str(`normal${i}`),
          fusekiId: str(`fuseki${i}`) || BUILTIN_ID,
          level: Math.min(5, Math.max(1, Number(fd.get(`level${i}`)) || 4)),
          secPerMove: Math.min(600, Math.max(1, Number(fd.get(`sec${i}`)) || 3)),
        };
      };
      const choice: NewGameChoice = {
        mode: (str('mode') as Mode) || 'tenbin',
        seats: [spec(0), spec(1)],
        names: [str('name0'), str('name1')],
        timeControl: main === 0 && byoyomi === 0 ? null : { mainSec: main, byoyomiSec: byoyomi },
      };
      this.last = choice;
      const r = this.resolve;
      this.resolve = null;
      this.dialog.close();
      r?.(choice);
    });
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.dialog.showModal();
    });
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
