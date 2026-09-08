// 新しい対局のダイアログ。ルール、対局者の名前、持ち時間と秒読み。

import type { Mode } from '../state/game.ts';
import type { TimeControl } from '../state/clock.ts';

export interface NewGameChoice {
  mode: Mode;
  sente: string;
  gote: string;
  timeControl: TimeControl | null;
}

export class NewGameDialog {
  private readonly dialog: HTMLDialogElement;
  private resolve: ((c: NewGameChoice | null) => void) | null = null;
  private last: NewGameChoice = { mode: 'tenbin', sente: '', gote: '', timeControl: null };

  constructor(host: HTMLElement) {
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
    const mainMin = l.timeControl ? Math.round(l.timeControl.mainSec / 60) : 0;
    const byo = l.timeControl?.byoyomiSec ?? 0;
    this.dialog.innerHTML = `
      <form class="dialog-body newgame-form">
        <div class="dialog-head"><h2>新しい対局</h2></div>
        <fieldset class="kind">
          <legend>ルール</legend>
          <label><input type="radio" name="mode" value="tenbin" ${l.mode !== 'fuseki' ? 'checked' : ''}/> 天秤将棋。一方が両方の玉を置き、もう一方が先後を選ぶ</label>
          <label><input type="radio" name="mode" value="fuseki" ${l.mode === 'fuseki' ? 'checked' : ''}/> 布石将棋。空の盤に交互に20枚ずつ打ってから指す</label>
        </fieldset>
        <div class="form-row">
          <label>先手の名前<input name="sente" value="${esc(l.sente)}" placeholder="先手" /></label>
          <label>後手の名前<input name="gote" value="${esc(l.gote)}" placeholder="後手" /></label>
        </div>
        <div class="form-row">
          <label>持ち時間（分）<input name="main" type="number" min="0" max="600" value="${mainMin}" /></label>
          <label>秒読み（秒）<input name="byoyomi" type="number" min="0" max="600" value="${byo}" /></label>
          <span class="hint form-hint">両方 0 なら時間は計らない</span>
        </div>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">やめる</button>
          <button type="submit" class="primary">対局を始める</button>
        </div>
      </form>`;
    const form = this.dialog.querySelector('form')!;
    this.dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this.dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const main = Math.max(0, Number(fd.get('main')) || 0) * 60;
      const byoyomi = Math.max(0, Number(fd.get('byoyomi')) || 0);
      const choice: NewGameChoice = {
        mode: (fd.get('mode') as Mode) || 'tenbin',
        sente: String(fd.get('sente') ?? '').trim(),
        gote: String(fd.get('gote') ?? '').trim(),
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
