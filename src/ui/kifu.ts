// 棋譜の一覧。フェーズが変わるところに見出しを挟む。

import type { MoveRecord, Phase } from '../state/game.ts';

const PHASE_LABEL: Record<Phase, string> = {
  kings: '両玉',
  choose: '先後の選択',
  fuseki: '布石',
  normal: '本将棋',
  over: '終局',
};

export class KifuList {
  constructor(private readonly root: HTMLElement) {}

  render(moves: MoveRecord[], footer?: string): void {
    const frag = document.createDocumentFragment();
    const h = document.createElement('div');
    h.className = 'kifu-title';
    h.textContent = '棋譜';
    frag.appendChild(h);
    const list = document.createElement('ol');
    list.className = 'kifu-list';
    let last: Phase | null = null;
    if (moves.length === 0) {
      const li = document.createElement('li');
      li.className = 'kifu-empty';
      li.textContent = 'まだ手がありません。駒台の駒を選んでマスに置きます。';
      list.appendChild(li);
    }
    for (const m of moves) {
      if (m.phase !== last) {
        const li = document.createElement('li');
        li.className = 'kifu-phase';
        li.textContent = PHASE_LABEL[m.phase];
        list.appendChild(li);
        last = m.phase;
      }
      const li = document.createElement('li');
      li.className = 'kifu-move';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = m.ply === null ? '' : String(m.ply);
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = m.text;
      li.append(n, t);
      list.appendChild(li);
    }
    frag.appendChild(list);
    if (footer) {
      const f = document.createElement('div');
      f.className = 'kifu-footer';
      f.textContent = footer;
      frag.appendChild(f);
    }
    this.root.replaceChildren(frag);
    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }
}
