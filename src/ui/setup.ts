// はじめの案内。エンジンを入れる手順と、置き場所と、やめるときの片づけ方。
//
// このアプリはエンジンも評価関数も**同梱しない**（ライセンスと大きさのため）。
// 布石の評価だけは内蔵しているので、エンジンが無くても 1〜40 手目は検討できる。
// 41 手目からの本将棋には USI エンジンが要る。その置き方をここで案内する。

import { isTauri } from '../usi/engine.ts';
import type { Settings } from '../settings.ts';

/** 案内に出す配布先。実行ファイルと評価関数は別々に配られている */
const LINKS = [
  {
    url: 'https://github.com/yaneurao/YaneuraOu/releases',
    title: 'やねうら王（本体の実行ファイル）',
    note: 'YaneuraOu-*.exe。CPU の種類に合うものを選ぶ（迷ったら AVX2）',
  },
  {
    url: 'https://github.com/yaneurao/YaneuraOu/releases/tag/suisho5',
    title: '水匠5（評価関数 nn.bin）',
    note: 'Suisho5.7z を展開すると nn.bin。やねうら王の eval/ に置く',
  },
];

export interface SetupDeps {
  settings(): Settings;
  save(): Promise<void>;
  /** エンジンの登録を開く */
  openEngines(): void;
  /** 設定を初期に戻す */
  reset(): Promise<void>;
}

async function openUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl: open } = await import('@tauri-apps/plugin-opener');
  await open(url);
}

async function reveal(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

export class SetupDialog {
  private readonly dialog: HTMLDialogElement;
  private enginesDir = '';
  private dataDir = '';

  constructor(host: HTMLElement, private readonly deps: SetupDeps) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'engine-dialog setup-dialog';
    host.appendChild(this.dialog);
    this.dialog.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'close':
          this.dialog.close();
          break;
        case 'link':
          void openUrl(b.dataset.url!);
          break;
        case 'engines':
          this.dialog.close();
          this.deps.openEngines();
          break;
        case 'open-dir':
          void reveal(b.dataset.dir || this.enginesDir);
          break;
        case 'copy':
          void navigator.clipboard?.writeText(b.dataset.text ?? '');
          b.textContent = 'コピーした';
          setTimeout(() => (b.textContent = 'コピー'), 1200);
          break;
        case 'reset':
          if (confirm('エンジンの登録・画面の割りつけ・目盛りをすべて初期に戻します。よろしいですか')) void this.deps.reset();
          break;
      }
    });
  }

  async open(): Promise<void> {
    await this.loadDirs();
    const s = this.deps.settings();
    const n = s.engines.length;
    this.dialog.innerHTML = `
      <div class="dialog-body setup-body">
        <div class="dialog-head"><h2>はじめに</h2></div>
        <p class="hint">
          このアプリはエンジンと評価関数を同梱していません。布石（1〜40手目）の評価は内蔵しているので、
          エンジンが無くても布石の検討と AI との対局はできます。41 手目からの本将棋には USI エンジンが要ります。
        </p>

        <section class="setup-step">
          <h3>1. エンジンを手に入れる</h3>
          <ul class="link-list">
            ${LINKS.map(
              (l) => `<li>
                <button type="button" class="link" data-act="link" data-url="${l.url}">${l.title}</button>
                <span class="link-note">${l.note}</span>
                <code class="link-url">${l.url}</code>
                <button type="button" class="link copy" data-act="copy" data-text="${l.url}">コピー</button>
              </li>`,
            ).join('')}
          </ul>
          <p class="hint">
            評価関数を埋め込んだ <code>Suisho5-*.exe</code> を持っているなら、それだけで動きます。
            GPU を使う「ふかうら王」も同じ配布先にあります。
          </p>
        </section>

        <section class="setup-step">
          <h3>2. 置いて登録する</h3>
          <ol class="setup-list">
            <li>展開した実行ファイルを、エンジンのフォルダに置く（どこでも構いませんが、ここに置くとまとめて取り込めます）</li>
            <li>やねうら王を使うなら、実行ファイルの隣に <code>eval/nn.bin</code>（水匠5）を置く</li>
            <li>「エンジン」→「フォルダから取り込む」か「実行ファイルを選んで追加」</li>
            <li>勝率の目盛りを選ぶ。やねうら王＋水匠5 は <b>435 / +34</b>、<code>Suisho5-*.exe</code> は <b>652 / +51</b></li>
          </ol>
          <div class="dir-row">
            <span class="dir-label">エンジンのフォルダ</span>
            <code class="dir-path">${this.enginesDir || '（アプリの中でだけ分かります）'}</code>
            ${this.enginesDir ? `<button type="button" data-act="open-dir" data-dir="${this.enginesDir}">開く</button><button type="button" class="link copy" data-act="copy" data-text="${this.enginesDir}">コピー</button>` : ''}
          </div>
          <div class="setup-actions">
            <button type="button" class="primary" data-act="engines">エンジンを登録する</button>
            <span class="hint">${n === 0 ? 'まだ 1 本も登録されていません' : `いま ${n} 本登録されています`}</span>
          </div>
        </section>

        <section class="setup-step">
          <h3>3. やめるとき</h3>
          <ul class="setup-list">
            <li>アプリ本体: Windows は「設定 → アプリ」から「天秤将棋」をアンインストール。展開しただけの版はそのフォルダを消す</li>
            <li>設定とエンジンの登録: 下のフォルダに残ります。まるごと消せば何も残りません（エンジン本体もここに置いていれば一緒に消えます）</li>
            <li>登録し直したいだけなら「設定を初期に戻す」</li>
          </ul>
          <div class="dir-row">
            <span class="dir-label">データのフォルダ</span>
            <code class="dir-path">${this.dataDir || '（アプリの中でだけ分かります）'}</code>
            ${this.dataDir ? `<button type="button" data-act="open-dir" data-dir="${this.dataDir}">開く</button><button type="button" class="link copy" data-act="copy" data-text="${this.dataDir}">コピー</button>` : ''}
          </div>
          <div class="setup-actions">
            <button type="button" class="danger" data-act="reset">設定を初期に戻す</button>
            <span class="hint">エンジンの登録・割りつけ・目盛りが消えます。棋譜のファイルは消えません</span>
          </div>
        </section>

        <div class="dialog-actions"><button type="button" data-act="close">閉じる</button></div>
      </div>`;
    this.dialog.showModal();
  }

  private async loadDirs(): Promise<void> {
    if (!isTauri() || (this.enginesDir && this.dataDir)) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      this.enginesDir = await invoke<string>('engines_dir');
      this.dataDir = await invoke<string>('data_dir');
    } catch {
      /* 分からなくても案内は出す */
    }
  }
}
