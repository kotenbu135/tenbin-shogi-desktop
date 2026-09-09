// 新しい対局のダイアログ。ルール、席ごとの対局者（人か、登録したエンジンか）、持ち時間と秒読み。
//
// 席は 2 つ。天秤将棋では「玉を置く側」と「先後を選ぶ側」、布石将棋では先手と後手。
// エンジンの席は、本将棋（41 手目から）に使う USI エンジンと、布石（40 手）に使うもの（内蔵の方策か
// 布石対応のエンジン）を別々に選ぶ。強さは公開サイトのレベルと同じ温度の刻み。

import { t } from '../i18n.ts';
import type { Mode } from '../state/game.ts';
import type { TimeControl } from '../state/clock.ts';
import { BUILTIN_ID, type Settings } from '../settings.ts';

/** 布石を人が置くことを指す id（本将棋の「人が指す」と対になる） */
export const HUMAN_ID = 'human';

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
export const LEVELS: { level: number; temperature: number; search: number }[] = [
  { level: 1, temperature: 1.0, search: 1 },
  { level: 2, temperature: 0.8, search: 1 },
  { level: 3, temperature: 0.6, search: 1 },
  { level: 4, temperature: 0.4, search: 1 },
  { level: 5, temperature: 0.4, search: 8 },
];

/** 選び札に出す名前。1 だけ言葉を添える（何が変わるのか分かるように） */
function levelLabel(level: number): string {
  return level === 1 ? t('ng_level1') : String(level);
}

export class NewGameDialog {
  private readonly dialog: HTMLDialogElement;
  private resolve: ((c: NewGameChoice | null) => void) | null = null;
  // 既定は「玉を置く側＝エンジン、先後を選ぶ側＝人」。人はまず選ぶ側を持つほうが分かりやすい
  // 席ごとに「本将棋は人が指す」を自分で選んだか。エンジンが 1 本も無かった頃に残った
  // 空文字（既定へ寄せたい）と、選んで入れた空文字（守りたい）を見分けるために持つ
  private chosePerson: [boolean, boolean] = [false, false];
  private last: NewGameChoice = {
    mode: 'tenbin',
    seats: [{ type: 'engine', normalId: '', fusekiId: BUILTIN_ID, level: 4, secPerMove: 3 }, { type: 'human' }],
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
    // 登録済みのエンジンを既定にする。前に開いたとき 1 本も無ければ normalId が空のまま
    // 残るので、一覧に居ない id はここで既定へ寄せる（「人が指す」で固まって見えるのを防ぐ）
    const defNormal = normals.some((e) => e.id === s.normalEngineId) ? s.normalEngineId! : normals[0]?.id ?? '';
    const seat = (i: 0 | 1) => {
      const p = l.seats[i];
      // 席を一度「人」にしても、エンジンへ戻したときに前の「人が指す」を守る
      const base =
        p.type === 'engine'
          ? p
          : { normalId: this.chosePerson[i] ? '' : defNormal, fusekiId: s.fusekiEngineId, level: 4, secPerMove: 3 };
      const fusekiIds = [HUMAN_ID, BUILTIN_ID, ...fusekis.map((e) => e.id)];
      const eng = {
        ...base,
        normalId:
          normals.some((e) => e.id === base.normalId) || (base.normalId === '' && this.chosePerson[i]) ? base.normalId : defNormal,
        // 布石も同じ。消えたエンジンを指したままだと、一覧の先頭（「人が置く」）で固まって見える
        fusekiId: fusekiIds.includes(base.fusekiId) ? base.fusekiId : BUILTIN_ID,
      };
      return `
        <fieldset class="seat" data-seat="${i}">
          <legend class="seat-title"></legend>
          <label>${t('ng_name')}<input name="name${i}" value="${esc(l.names[i])}" /></label>
          <div class="seat-type">
            <label><input type="radio" name="type${i}" value="human" ${p.type === 'human' ? 'checked' : ''}/> ${t('ng_human')}</label>
            <label><input type="radio" name="type${i}" value="engine" ${p.type === 'engine' ? 'checked' : ''}/> ${t('ng_engine')}</label>
          </div>
          <div class="seat-engine" ${p.type === 'engine' ? '' : 'hidden'}>
            <label><span class="normal-label">${t('ng_normal_label')}</span><select name="normal${i}">
              <option value="">${t('ng_played_by_person')}</option>
              ${normals.map((e) => `<option value="${e.id}" ${eng.normalId === e.id ? 'selected' : ''}>${esc(e.name || e.path)}</option>`).join('')}
            </select></label>
            <label class="fuseki-only">${t('ng_fuseki_label')}<select name="fuseki${i}">
              <option value="${HUMAN_ID}" ${eng.fusekiId === HUMAN_ID ? 'selected' : ''}>${t('ng_placed_by_person')}</option>
              <option value="${BUILTIN_ID}" ${eng.fusekiId === BUILTIN_ID ? 'selected' : ''}>${t('ng_builtin_policy')}</option>
              ${fusekis.map((e) => `<option value="${e.id}" ${eng.fusekiId === e.id ? 'selected' : ''}>${esc(e.name || e.path)}</option>`).join('')}
            </select></label>
            <div class="form-row two">
              <label class="fuseki-only" title="${t('ng_strength_title')}">${t('ng_strength')}<select name="level${i}">${LEVELS.map((lv) => `<option value="${lv.level}" ${eng.level === lv.level ? 'selected' : ''}>${levelLabel(lv.level)}</option>`).join('')}</select></label>
              <label>${t('ng_sec_per_move')}<input name="sec${i}" type="number" min="1" max="600" value="${eng.secPerMove}" /></label>
            </div>
          </div>
        </fieldset>`;
    };
    this.dialog.innerHTML = `
      <form class="dialog-body newgame-form">
        <div class="dialog-head"><h2>${t('ng_title')}</h2></div>
        <fieldset class="kind">
          <legend>${t('ng_rule')}</legend>
          <label><input type="radio" name="mode" value="tenbin" ${l.mode === 'tenbin' ? 'checked' : ''}/> ${t('ng_rule_tenbin')}</label>
          <label><input type="radio" name="mode" value="fuseki" ${l.mode === 'fuseki' ? 'checked' : ''}/> ${t('ng_rule_fuseki')}</label>
          <label><input type="radio" name="mode" value="position" ${l.mode === 'position' ? 'checked' : ''}/> ${t('ng_rule_position')}</label>
        </fieldset>
        <div class="seats">${seat(0)}${seat(1)}</div>
        <div class="form-row">
          <label>${t('ng_main_min')}<input name="main" type="number" min="0" max="600" value="${mainMin}" /></label>
          <label>${t('ng_byoyomi_sec')}<input name="byoyomi" type="number" min="0" max="600" value="${byo}" /></label>
          <span class="hint form-hint">${t('ng_time_hint')}</span>
        </div>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">${t('cancel')}</button>
          <button type="submit" class="primary">${t('ng_start')}</button>
        </div>
      </form>`;
    const form = this.dialog.querySelector('form')!;
    const seatTitles = () => {
      const mode = (form.elements.namedItem('mode') as RadioNodeList).value as Mode;
      const titles = mode === 'tenbin' ? [t('role_placer'), t('role_chooser')] : [t('side_sente'), t('side_gote')];
      this.dialog.querySelectorAll('.seat-title').forEach((el, i) => (el.textContent = titles[i]!));
      // 天秤将棋は始める時点で先後が決まっていない。名前の下敷きも役の名で出す
      this.dialog.querySelectorAll<HTMLInputElement>('.seat input[name^="name"]').forEach((el, i) => (el.placeholder = titles[i]!));
      // 本将棋には布石が無い。布石のエンジンと強さは隠す
      const fuseki = mode !== 'position';
      for (const el of this.dialog.querySelectorAll<HTMLElement>('.fuseki-only')) el.hidden = !fuseki;
      for (const el of this.dialog.querySelectorAll<HTMLElement>('.normal-label')) el.textContent = t(fuseki ? 'ng_normal_label' : 'ng_engine_label');
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
      // エンジンが並んでいる一覧から「人が指す」を選んだのなら、次に開いたときも守る
      for (const i of [0, 1] as const) {
        const sp = choice.seats[i];
        // 席が「人」のときは前の選択を消さない（次にエンジンへ戻したときに要る）
        if (sp.type === 'engine') this.chosePerson[i] = sp.normalId === '' && normals.length > 0;
      }
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
