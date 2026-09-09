// 棋譜の一覧と、局面の移動（最初へ・1手戻る・1手進む・最後へ）。
// 行を押すとその局面を表示する。cursor が null なら最新の局面。
// 消費時間があれば「この手 / 累計」を右に出す（ShogiHome と同じ見せ方）。

import type { MoveRecord, Phase } from '../state/game.ts';
import { colorMark } from '../state/game.ts';

const PHASE_LABEL: Record<Phase, string> = {
  kings: '両玉',
  choose: '先後の選択',
  fuseki: '布石',
  normal: '本将棋',
  over: '終局',
};

export interface KifuDeps {
  /** cursor: 何手目まで表示するか（moves の index+1）。null は最新 */
  onSeek(cursor: number | null): void;
}

function mmss(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function hhmmss(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

export class KifuList {
  private readonly list: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly foot: HTMLElement;
  private moves: MoveRecord[] = [];
  private cursor: number | null = null;

  constructor(private readonly root: HTMLElement, private readonly deps: KifuDeps) {
    root.innerHTML = `
      <div class="kifu-head">
        <span class="kifu-title">棋譜</span>
        <div class="kifu-nav">
          <button type="button" data-seek="first" title="最初へ (Home)" aria-label="最初へ">${ICON.first}</button>
          <button type="button" data-seek="prev" title="1手戻る (←)" aria-label="1手戻る">${ICON.prev}</button>
          <button type="button" data-seek="next" title="1手進む (→)" aria-label="1手進む">${ICON.next}</button>
          <button type="button" data-seek="last" title="最後へ (End)" aria-label="最後へ">${ICON.last}</button>
        </div>
      </div>
      <ol class="kifu-list"></ol>
      <div class="kifu-foot"></div>`;
    this.list = root.querySelector('.kifu-list')!;
    this.nav = root.querySelector('.kifu-nav')!;
    this.foot = root.querySelector('.kifu-foot')!;
    this.nav.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-seek]');
      if (!b) return;
      this.seek(b.dataset.seek as 'first' | 'prev' | 'next' | 'last');
    });
  }

  seek(dir: 'first' | 'prev' | 'next' | 'last'): void {
    const n = this.moves.length;
    const cur = this.cursor ?? n;
    let next: number;
    switch (dir) {
      case 'first': next = 0; break;
      case 'prev': next = Math.max(0, cur - 1); break;
      case 'next': next = Math.min(n, cur + 1); break;
      case 'last': next = n; break;
    }
    this.deps.onSeek(next >= n ? null : next);
  }

  /**
   * いまの手が見えるところまで送る。終局のときは右上に結果の欄が出て棋譜の高さが変わるので、
   * 画面を描き終えてからもう一度呼ぶ（描いた直後だけだと最後の手が枠の外に残る）。
   */
  revealCurrent(): void {
    this.list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  render(moves: MoveRecord[], cursor: number | null, footer?: string): void {
    this.moves = moves;
    this.cursor = cursor;
    const n = moves.length;
    const cur = cursor ?? n;
    const withTime = moves.some((m) => m.time);
    this.list.classList.toggle('with-time', withTime);
    const frag = document.createDocumentFragment();
    const start = document.createElement('li');
    start.className = 'kifu-move start' + (cur === 0 ? ' current' : '');
    start.innerHTML = `<span class="n"></span><span class="t">開始局面</span>`;
    start.addEventListener('click', () => this.deps.onSeek(n === 0 ? null : 0));
    frag.appendChild(start);
    let last: Phase | null = null;
    for (const m of moves) {
      if (m.phase !== last) {
        const li = document.createElement('li');
        li.className = 'kifu-phase';
        li.textContent = PHASE_LABEL[m.phase];
        frag.appendChild(li);
        last = m.phase;
      }
      const li = document.createElement('li');
      const isCur = cur === m.index + 1;
      li.className = 'kifu-move' + (isCur ? ' current' : '') + (m.ply === null ? ' choose' : '');
      const num = document.createElement('span');
      num.className = 'n';
      num.textContent = m.ply === null ? '' : String(m.ply);
      const t = document.createElement('span');
      t.className = 't';
      if (m.color) {
        const mk = document.createElement('span');
        mk.className = `mk ${m.color}`;
        mk.textContent = colorMark(m.color);
        t.append(mk, m.text);
      } else {
        t.textContent = m.text;
      }
      li.append(num, t);
      if (withTime) {
        const tm = document.createElement('span');
        tm.className = 'tm';
        tm.textContent = m.time ? `${mmss(m.time.elapsed)} / ${hhmmss(m.time.total)}` : '';
        li.appendChild(tm);
      }
      li.addEventListener('click', () => this.deps.onSeek(m.index + 1 >= n ? null : m.index + 1));
      frag.appendChild(li);
    }
    this.list.replaceChildren(frag);
    this.revealCurrent();
    this.foot.textContent = footer ?? '';
    this.foot.hidden = !footer;
    for (const b of this.nav.querySelectorAll<HTMLButtonElement>('button')) {
      const d = b.dataset.seek;
      b.disabled = (d === 'first' || d === 'prev') ? cur === 0 : cur >= n;
    }
  }
}

const ICON = {
  first: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3v10M13 3 6 8l7 5z"/></svg>',
  prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 3 5 8l6 5z"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l6 5-6 5z"/></svg>',
  last: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 3v10M3 3l7 5-7 5z"/></svg>',
};
