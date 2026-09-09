// はじめの案内。長い説明は読まれないので、**1 画面に収まる量**にする。
//
// このアプリはエンジンも評価関数も同梱しない（ライセンスと大きさのため）。
// けれど公式の配布物は 7z で、中に 89 本の実行ファイルが入っていて、
// どれを使うか（水匠5 は NNUE halfkp_256x2_32_32）は初めての人には分からない。
// だから「自動で入れる」を用意して、選ばせずに済ませる。手で入れる道も残す。

import { isTauri } from '../usi/engine.ts';
import type { Settings } from '../settings.ts';
import { checkUpdate, currentVersion } from './update.ts';

/** 自動で入れるもの（やねうら王の実行ファイル ＋ 水匠5 の評価関数） */
const AUTO_NAME = 'やねうら王＋水匠5';
/** 水匠5 の評価関数は FV_SCALE 24 が最適（配布元の説明）。その目盛り */
const AUTO_EVAL = { scale: 652, offsetCp: 51 };

export interface SetupDeps {
  settings(): Settings;
  save(): Promise<void>;
  /** エンジンの登録を開く */
  openEngines(): void;
  /** 取り込んだエンジンを登録する。戻り値は申告を読めなかったときの理由 */
  register(path: string, name: string, evalScale: { scale: number; offsetCp: number }): Promise<string | null>;
  /** 設定を初期に戻す */
  reset(): Promise<void>;
  /** 下の欄の配置を選ぶ窓を開く */
  openLayout(): void;
  /** 状態の行に出す */
  say(text: string, error?: boolean): void;
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
  private version = '';
  private installing = false;
  private lastNote = '';

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
        case 'install':
          void this.install();
          break;
        case 'engines':
          this.dialog.close();
          this.deps.openEngines();
          break;
        case 'open-dir':
          void reveal(b.dataset.dir || this.enginesDir);
          break;
        case 'layout':
          this.dialog.close();
          this.deps.openLayout();
          break;
        case 'update':
          this.dialog.close();
          void checkUpdate(false, { say: this.deps.say });
          break;
        case 'reset':
          if (confirm('エンジンの登録・画面の配置・目盛りをすべて初期に戻します。よろしいですか')) void this.deps.reset();
          break;
      }
    });
  }

  async open(): Promise<void> {
    await this.loadDirs();
    this.paint();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private note(text: string, percent?: number): void {
    this.lastNote = percent === undefined ? text : `${text}（${percent}%）`;
    const el = this.dialog.querySelector('.install-note');
    if (el) el.textContent = this.lastNote;
  }

  /** やねうら王＋水匠5 を取ってきて登録する */
  private async install(): Promise<void> {
    if (this.installing) return;
    if (!isTauri()) {
      this.note('アプリの中でだけできます');
      return;
    }
    this.installing = true;
    const btn = this.dialog.querySelector<HTMLButtonElement>('[data-act="install"]');
    if (btn) btn.disabled = true;
    let un: (() => void) | null = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { invoke } = await import('@tauri-apps/api/core');
      un = await listen<{ text: string; percent: number }>('engine-install', (e) => this.note(e.payload.text, e.payload.percent));
      this.note('始めています…', 0);
      const path = await invoke<string>('install_recommended_engine');
      this.note('登録しています…', 100);
      const err = await this.deps.register(path, AUTO_NAME, AUTO_EVAL);
      this.note(err ? `入れましたが、起動できませんでした: ${err}` : `入りました。${AUTO_NAME} を本将棋の既定にしました`);
      this.deps.say(err ? `エンジンを入れましたが起動できません: ${err}` : `${AUTO_NAME} を入れました`, !!err);
      this.paint();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.note(`入れられません: ${msg}`);
    } finally {
      un?.();
      this.installing = false;
      const b = this.dialog.querySelector<HTMLButtonElement>('[data-act="install"]');
      if (b) b.disabled = false;
    }
  }

  private paint(): void {
    const n = this.deps.settings().engines.length;
    const dir = (label: string, path: string) =>
      `<div class="dir-row"><span class="dir-label">${label}</span><code class="dir-path">${path || '（アプリの中でだけ分かります）'}</code>${
        path ? `<button type="button" data-act="open-dir" data-dir="${path}">開く</button>` : ''
      }</div>`;
    this.dialog.innerHTML = `
      <div class="dialog-body setup-body">
        <div class="dialog-head"><h2>はじめに</h2><span class="hint">${this.version ? `版 ${this.version}` : ''}</span></div>
        <p class="hint">
          布石（1〜40手目）はアプリの中の評価で動きます。<b>41手目からの本将棋にはエンジンが要ります。</b>
          ${n === 0 ? 'まだ 1 本も登録されていません。' : `いま ${n} 本登録されています。`}
        </p>

        <section class="setup-step">
          <div class="setup-actions">
            <button type="button" class="primary" data-act="install">エンジンを自動で入れる</button>
            <span class="hint">やねうら王＋水匠5 を公式の配布先から取って登録します（約 40MB）</span>
          </div>
          <div class="install-note">${this.lastNote}</div>
        </section>

        <section class="setup-step">
          <h3>自分で入れるなら</h3>
          <p class="hint">実行ファイルをエンジンのフォルダに置いて「エンジン」→「フォルダから取り込む」。
            やねうら王なら隣に <code>eval/nn.bin</code>（水匠5）を置き、目盛りは <b>652 / +51</b>。</p>
          ${dir('エンジン', this.enginesDir)}
        </section>

        <section class="setup-step">
          <h3>やめるとき</h3>
          <p class="hint">Windows は「設定 → アプリ」から天秤将棋をアンインストール。設定とエンジンの登録は下に残るので、消せば何も残りません。</p>
          ${dir('データ', this.dataDir)}
        </section>

        <div class="dialog-actions">
          <button type="button" data-act="engines">エンジンの登録</button>
          <button type="button" data-act="layout">画面の配置</button>
          <button type="button" data-act="update">更新を確認</button>
          <button type="button" class="danger" data-act="reset">初期に戻す</button>
          <button type="button" class="primary" data-act="close">閉じる</button>
        </div>
      </div>`;
  }

  private async loadDirs(): Promise<void> {
    if (!isTauri() || (this.enginesDir && this.dataDir && this.version)) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      this.enginesDir = await invoke<string>('engines_dir');
      this.dataDir = await invoke<string>('data_dir');
      this.version = await currentVersion();
    } catch {
      /* 分からなくても案内は出す */
    }
  }
}
