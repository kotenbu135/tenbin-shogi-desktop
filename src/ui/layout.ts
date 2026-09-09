// 画面の割りつけ。ShogiHome の標準レイアウトと同じ骨格で、下の欄は利用者が組み替えられる。
//
//   上  盤（左）と棋譜（右）。あいだの仕切りを掴むと幅が変わる
//   下  いくつかの「欄」。欄はタブを何枚か持ち、1 枚を開く。既定は 2 欄で
//       左に検討（候補手）、右にグラフ。候補手とグラフを同時に見られる
//
// 組み替え方は 3 つ。タブを掴んで別の欄へ落とす、仕切りを掴んで幅を変える、
// 「配置」の窓でひな形を選ぶ（1 欄 / 2 欄 / 3 欄）か、タブを左右へ送る。
// 掴む操作が効かない環境（WebView の版によっては drag が来ない）でも困らないよう、
// 窓の側だけで同じことが全部できるようにしてある。

import { ALL_TABS, defaultPanes, type LayoutSettings, type PaneSettings, type TabId } from '../settings.ts';

export type { TabId };

export const TAB_LABEL: Record<TabId, string> = { analysis: '検討', score: '評価値', winrate: '期待勝率' };

export interface LayoutDeps {
  layout(): LayoutSettings;
  save(): void;
  /** 割りつけが変わった。描き直しの合図 */
  onChange(): void;
}

const MIN_RECORD = 220;
const MIN_BOARD = 320;
const MIN_BOTTOM = 90;
/** 盤に残す高さ。これ以上は下の欄に渡さない */
const MIN_TOP = 300;
const MIN_PANE = 170;

export class Layout {
  constructor(
    private readonly main: HTMLElement,
    private readonly bottom: HTMLElement,
    private readonly panels: Record<TabId, HTMLElement>,
    private readonly deps: LayoutDeps,
  ) {
    this.build();
    this.apply();
    this.edgeDrag('split-v', 'v');
    this.edgeDrag('split-h', 'h');
    addEventListener('resize', () => this.apply());
  }

  private get panes(): PaneSettings[] {
    return this.deps.layout().panes;
  }

  /** そのタブがいま見えているか（閉じたタブの要素は幅 0 で、描いても無駄） */
  visible(id: TabId): boolean {
    const el = this.panels[id];
    return !el.hidden && el.clientWidth > 0;
  }

  /** そのタブを開く（別の欄にあってもその欄の手前へ出す） */
  show(id: TabId): void {
    const i = this.panes.findIndex((p) => p.tabs.includes(id));
    if (i >= 0) this.activate(i, id);
  }

  // ---- 組み立て ----

  /** 欄とタブを組み直す。中身の要素は作り直さず、移すだけ */
  build(): void {
    const panes = this.panes;
    this.bottom.replaceChildren();
    panes.forEach((p, i) => {
      if (i > 0) this.bottom.appendChild(this.paneSplit(i - 1));
      const sec = document.createElement('section');
      sec.className = 'pane';
      sec.dataset.pane = String(i);
      sec.style.flexGrow = String(p.ratio);
      const bar = document.createElement('div');
      bar.className = 'tabbar';
      bar.setAttribute('role', 'tablist');
      for (const t of p.tabs) bar.appendChild(this.tabButton(t, i, t === p.active));
      bar.addEventListener('dragover', (e) => {
        e.preventDefault();
        bar.classList.add('drop');
      });
      bar.addEventListener('dragleave', () => bar.classList.remove('drop'));
      bar.addEventListener('drop', (e) => {
        e.preventDefault();
        bar.classList.remove('drop');
        const t = e.dataTransfer?.getData('text/plain') as TabId | undefined;
        if (t && ALL_TABS.includes(t)) this.moveTab(t, i);
      });
      const body = document.createElement('div');
      body.className = 'tab-body';
      for (const t of p.tabs) {
        const el = this.panels[t];
        el.hidden = t !== p.active;
        body.appendChild(el);
      }
      sec.append(bar, body);
      this.bottom.appendChild(sec);
    });
  }

  private tabButton(t: TabId, pane: number, active: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.dataset.tab = t;
    b.draggable = true;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(active));
    b.title = `${TAB_LABEL[t]}（掴んで別の欄へ移せます）`;
    b.textContent = TAB_LABEL[t];
    b.addEventListener('click', () => this.activate(pane, t));
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', t);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => b.classList.remove('dragging'));
    return b;
  }

  private activate(pane: number, t: TabId): void {
    const p = this.panes[pane];
    if (!p || p.active === t) return;
    p.active = t;
    for (const el of this.bottom.querySelectorAll<HTMLElement>(`[data-pane="${pane}"] .tab`)) {
      el.setAttribute('aria-selected', String(el.dataset.tab === t));
    }
    for (const id of p.tabs) this.panels[id].hidden = id !== t;
    this.deps.save();
    this.deps.onChange();
  }

  // ---- 組み替え ----

  /** タブを別の欄へ移す。元の欄が空になったらその欄を畳む */
  moveTab(tab: TabId, to: number): void {
    const l = this.deps.layout();
    const from = l.panes.findIndex((p) => p.tabs.includes(tab));
    if (from < 0) return;
    if (from === to) {
      this.activate(from, tab);
      return;
    }
    const src = l.panes[from]!;
    const dst = l.panes[to];
    if (!dst) return;
    src.tabs = src.tabs.filter((t) => t !== tab);
    if (src.active === tab) src.active = src.tabs[0] ?? tab;
    dst.tabs.push(tab);
    dst.active = tab;
    if (src.tabs.length === 0) {
      dst.ratio += src.ratio;
      l.panes.splice(from, 1);
    }
    this.commit();
  }

  /** タブを左（-1）か右（+1）へ。その先に欄が無ければ、新しい欄を作って出す */
  shiftTab(tab: TabId, dir: -1 | 1): void {
    const l = this.deps.layout();
    const from = l.panes.findIndex((p) => p.tabs.includes(tab));
    if (from < 0) return;
    const to = from + dir;
    if (to >= 0 && to < l.panes.length) {
      this.moveTab(tab, to);
      return;
    }
    const src = l.panes[from]!;
    if (src.tabs.length < 2) return; // 1 枚しかない欄は割れない（端で行き止まり）
    src.tabs = src.tabs.filter((t) => t !== tab);
    if (src.active === tab) src.active = src.tabs[0]!;
    src.ratio /= 2;
    l.panes.splice(dir === 1 ? from + 1 : from, 0, { tabs: [tab], active: tab, ratio: src.ratio });
    this.commit();
  }

  /** ひな形。1 欄はタブを切り替えて使う、2 欄は 検討｜グラフ、3 欄は全部並べる */
  preset(n: 1 | 2 | 3): void {
    const l = this.deps.layout();
    l.panes =
      n === 1
        ? [{ tabs: [...ALL_TABS], active: 'analysis', ratio: 1 }]
        : n === 2
          ? defaultPanes()
          : [
              { tabs: ['analysis'], active: 'analysis', ratio: 0.5 },
              { tabs: ['score'], active: 'score', ratio: 0.25 },
              { tabs: ['winrate'], active: 'winrate', ratio: 0.25 },
            ];
    this.commit();
  }

  reset(): void {
    const l = this.deps.layout();
    l.recordWidth = 320;
    l.bottomHeight = 270;
    l.panes = defaultPanes();
    this.commit();
  }

  private commit(): void {
    const l = this.deps.layout();
    const sum = l.panes.reduce((a, p) => a + p.ratio, 0) || 1;
    for (const p of l.panes) p.ratio /= sum;
    this.deps.save();
    this.build();
    this.apply();
    this.deps.onChange();
  }

  // ---- 仕切り ----

  /** 盤と棋譜、上と下の仕切り。位置は px で覚える */
  apply(): void {
    const l = this.deps.layout();
    const w = this.main.clientWidth || 1200;
    const h = this.main.clientHeight || 700;
    const record = Math.max(MIN_RECORD, Math.min(l.recordWidth, Math.max(MIN_RECORD, w - MIN_BOARD)));
    const bottom = Math.max(MIN_BOTTOM, Math.min(l.bottomHeight, Math.max(MIN_BOTTOM, h - MIN_TOP)));
    this.main.style.setProperty('--record-w', `${record}px`);
    this.main.style.setProperty('--bottom-h', `${bottom}px`);
  }

  private paneSplit(left: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'split split-v pane-split';
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.setAttribute('aria-label', '欄の境');
    const resize = (x: number) => {
      const a = this.bottom.querySelector<HTMLElement>(`[data-pane="${left}"]`);
      const b = this.bottom.querySelector<HTMLElement>(`[data-pane="${left + 1}"]`);
      const pa = this.panes[left];
      const pb = this.panes[left + 1];
      if (!a || !b || !pa || !pb) return;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const total = ra.width + rb.width;
      const share = pa.ratio + pb.ratio;
      const leftPx = Math.max(MIN_PANE, Math.min(total - MIN_PANE, x - ra.left));
      pa.ratio = (share * leftPx) / total;
      pb.ratio = share - pa.ratio;
      a.style.flexGrow = String(pa.ratio);
      b.style.flexGrow = String(pb.ratio);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => resize(ev.clientX);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        this.deps.save();
        this.deps.onChange();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const a = this.bottom.querySelector<HTMLElement>(`[data-pane="${left}"]`);
      if (!a) return;
      const step = (e.shiftKey ? 40 : 10) * (e.key === 'ArrowLeft' ? -1 : 1);
      resize(a.getBoundingClientRect().right + step);
      this.deps.save();
      this.deps.onChange();
    });
    return el;
  }

  private edgeDrag(id: string, dir: 'v' | 'h'): void {
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
        // 詰めたあとの実寸を残す（窓を広げたときに元へ戻らないように）
        l.recordWidth = parseInt(this.main.style.getPropertyValue('--record-w'), 10) || l.recordWidth;
        l.bottomHeight = parseInt(this.main.style.getPropertyValue('--bottom-h'), 10) || l.bottomHeight;
        this.deps.save();
        this.deps.onChange();
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
      this.deps.onChange();
    });
  }

  // ---- 「配置」の窓 ----

  /** 掴む操作を使わずに同じ組み替えができる窓。ひな形と、タブを左右へ送る操作 */
  openMenu(host: HTMLElement): void {
    let dlg = host.querySelector<HTMLDialogElement>('.layout-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'engine-dialog layout-dialog';
      dlg.innerHTML = `
        <form method="dialog" class="dialog-body">
          <div class="dialog-head"><h2>下の欄の配置</h2></div>
          <p class="hint">タブは掴んで別の欄へ移せます。欄の境と、盤・棋譜・下の欄の仕切りは掴むと動きます。</p>
          <div class="preset-row">
            <button type="button" data-preset="1">1 欄</button>
            <button type="button" data-preset="2">2 欄（検討｜グラフ）</button>
            <button type="button" data-preset="3">3 欄</button>
          </div>
          <ul class="tab-places"></ul>
          <div class="dialog-actions">
            <button type="button" data-act="reset">初期に戻す</button>
            <button type="submit">閉じる</button>
          </div>
        </form>`;
      host.appendChild(dlg);
      dlg.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-preset],button[data-move],button[data-act]');
        if (!b) return;
        if (b.dataset.preset) this.preset(Number(b.dataset.preset) as 1 | 2 | 3);
        else if (b.dataset.act === 'reset') this.reset();
        else if (b.dataset.move) {
          const [tab, dir] = b.dataset.move.split(':');
          this.shiftTab(tab as TabId, Number(dir) as -1 | 1);
        }
        this.paintMenu(dlg!);
      });
    }
    this.paintMenu(dlg);
    dlg.showModal();
  }

  private paintMenu(dlg: HTMLDialogElement): void {
    const list = dlg.querySelector<HTMLElement>('.tab-places');
    if (!list) return;
    const panes = this.panes;
    list.innerHTML = ALL_TABS.map((t) => {
      const i = panes.findIndex((p) => p.tabs.includes(t));
      const alone = panes[i]?.tabs.length === 1;
      const canLeft = i > 0 || !alone;
      const canRight = i < panes.length - 1 || !alone;
      return `<li>
        <span class="place-name">${TAB_LABEL[t]}</span>
        <span class="place-where">${panes.length === 1 ? '同じ欄' : `左から ${i + 1} 番目の欄`}</span>
        <button type="button" data-move="${t}:-1"${canLeft ? '' : ' disabled'} aria-label="${TAB_LABEL[t]} を左の欄へ">←</button>
        <button type="button" data-move="${t}:1"${canRight ? '' : ' disabled'} aria-label="${TAB_LABEL[t]} を右の欄へ">→</button>
      </li>`;
    }).join('');
  }
}
