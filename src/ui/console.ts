// USI の生ログ。エンジンとの往復をそのまま見せ、手で1行送れる。

import type { LogDirection } from '../usi/engine.ts';

const MAX_LINES = 2000;

export class UsiConsole {
  private readonly pre: HTMLElement;
  private readonly input: HTMLInputElement;
  private lines = 0;
  onSend: ((line: string) => void) | null = null;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="console-head"><span>USI ログ</span><button type="button" class="link" data-act="clear">消す</button></div>
      <pre class="console-body" aria-live="polite"></pre>
      <form class="console-form"><input type="text" spellcheck="false" placeholder="エンジンへ送る行（例: isready）" /><button type="submit">送る</button></form>`;
    this.pre = root.querySelector('.console-body')!;
    this.input = root.querySelector('input')!;
    root.querySelector('[data-act="clear"]')!.addEventListener('click', () => {
      this.pre.replaceChildren();
      this.lines = 0;
    });
    root.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = this.input.value.trim();
      if (!v) return;
      this.onSend?.(v);
      this.input.value = '';
    });
  }

  append(dir: LogDirection, text: string): void {
    // info の洪水で DOM を膨らませない。古い行から捨てる。
    if (this.lines >= MAX_LINES) {
      this.pre.firstChild?.remove();
      this.lines--;
    }
    const span = document.createElement('span');
    span.className = `log-${dir}`;
    const prefix = dir === 'out' ? '> ' : dir === 'err' ? '! ' : dir === 'sys' ? '# ' : '  ';
    span.textContent = prefix + text + '\n';
    const stick = this.pre.scrollTop + this.pre.clientHeight >= this.pre.scrollHeight - 8;
    this.pre.appendChild(span);
    this.lines++;
    if (stick) this.pre.scrollTop = this.pre.scrollHeight;
  }
}
