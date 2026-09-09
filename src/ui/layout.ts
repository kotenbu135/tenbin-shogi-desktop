// 画面の割りつけ。ShogiHome の標準レイアウトと同じ形にする。
//
//   上  盤（左）と棋譜（右）。あいだの仕切りを掴むと幅が変わる
//   下  タブの欄（検討・評価値・期待勝率）。上との仕切りで高さが変わる
//
// 検討とグラフを右の細い列に押し込むのをやめ、下いっぱいの幅を使う。
// 仕切りの位置と開いていたタブは設定に残す。

import type { LayoutSettings } from '../settings.ts';

export type TabId = LayoutSettings['tab'];

const TABS: { id: TabId; label: string }[] = [
  { id: 'analysis', label: '検討' },
  { id: 'score', label: '評価値' },
  { id: 'winrate', label: '期待勝率' },
];

export interface LayoutDeps {
  layout(): LayoutSettings;
  save(): void;
  /** タブが変わった */
  onTab(id: TabId): void;
}

const MIN_RECORD = 220;
const MIN_BOARD = 320;
const MIN_BOTTOM = 90;
/** 下の欄が窓の高さの何割まで取れるか。狭い窓で盤が潰れないようにする */
const MAX_BOTTOM_RATIO = 0.4;

export class Layout {
  private tab_: TabId;

  constructor(
    private readonly main: HTMLElement,
    private readonly tabbar: HTMLElement,
    private readonly panels: Record<TabId, HTMLElement>,
    private readonly deps: LayoutDeps,
  ) {
    this.tab_ = deps.layout().tab;
    tabbar.innerHTML = TABS.map(
      (t) => `<button type="button" role="tab" class="tab" data-tab="${t.id}" aria-selected="false">${t.label}</button>`,
    ).join('');
    tabbar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
      if (b) this.setTab(b.dataset.tab as TabId);
    });
    this.apply();
    this.paintTabs();
    this.drag('split-v', 'v');
    this.drag('split-h', 'h');
    addEventListener('resize', () => this.apply());
  }

  get tab(): TabId {
    return this.tab_;
  }

  setTab(id: TabId): void {
    this.tab_ = id;
    this.deps.layout().tab = id;
    this.deps.save();
    this.paintTabs();
    this.deps.onTab(id);
  }

  private paintTabs(): void {
    for (const b of this.tabbar.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === this.tab_));
    }
    // グラフは 2 つのタブで同じ要素を使い、種類だけ替える
    this.panels.analysis.hidden = this.tab_ !== 'analysis';
    const graph = this.panels.score;
    graph.hidden = this.tab_ === 'analysis';
  }

  /** 仕切りの位置を CSS 変数へ。窓が狭いときは詰める */
  apply(): void {
    const l = this.deps.layout();
    const w = this.main.clientWidth || 1200;
    const h = this.main.clientHeight || 700;
    const record = Math.max(MIN_RECORD, Math.min(l.recordWidth, Math.max(MIN_RECORD, w - MIN_BOARD)));
    const bottom = Math.max(MIN_BOTTOM, Math.min(l.bottomHeight, Math.max(MIN_BOTTOM, Math.round(h * MAX_BOTTOM_RATIO))));
    this.main.style.setProperty('--record-w', `${record}px`);
    this.main.style.setProperty('--bottom-h', `${bottom}px`);
  }

  private drag(id: string, dir: 'v' | 'h'): void {
    const el = document.getElementById(id);
    if (!el) return;
    const l = this.deps.layout();
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const rect = this.main.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        if (dir === 'v') l.recordWidth = Math.round(rect.right - ev.clientX);
        else l.bottomHeight = Math.round(rect.bottom - ev.clientY);
        this.apply();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        // 詰めたあとの実寸を残す（窓を広げたときに元に戻らないよう、変数の値をそのまま読む）
        l.recordWidth = parseInt(this.main.style.getPropertyValue('--record-w'), 10) || l.recordWidth;
        l.bottomHeight = parseInt(this.main.style.getPropertyValue('--bottom-h'), 10) || l.bottomHeight;
        this.deps.save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const k = e.key;
      if (dir === 'v' && (k === 'ArrowLeft' || k === 'ArrowRight')) l.recordWidth += k === 'ArrowLeft' ? step : -step;
      else if (dir === 'h' && (k === 'ArrowUp' || k === 'ArrowDown')) l.bottomHeight += k === 'ArrowUp' ? step : -step;
      else return;
      e.preventDefault();
      this.apply();
      this.deps.save();
    });
  }
}
