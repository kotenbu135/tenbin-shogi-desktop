// はじめの案内。長い説明は読まれないので、**1 画面に収まる量**にする。
//
// このアプリはエンジンも評価関数も同梱しない（ライセンスと大きさのため）。
// けれど公式の配布物は 7z で、中に 89 本の実行ファイルが入っていて、
// どれを使うか（水匠5 は NNUE halfkp_256x2_32_32）は初めての人には分からない。
// だから「自動で入れる」を用意して、選ばせずに済ませる。手で入れる道も残す。

import { t } from '../i18n.ts';
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
  /** 状態の行に出す */
  say(text: string, error?: boolean): void;
  /** 更新を入れ替える直前にエンジンを止める */
  beforeInstall(): Promise<void>;
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
        case 'update':
          this.dialog.close();
          void checkUpdate(false, { say: this.deps.say, beforeInstall: this.deps.beforeInstall });
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
    this.lastNote = percent === undefined ? text : t('su_note_percent', { text, percent });
    const el = this.dialog.querySelector('.install-note');
    if (el) el.textContent = this.lastNote;
  }

  /** やねうら王＋水匠5 を取ってきて登録する */
  private async install(): Promise<void> {
    if (this.installing) return;
    if (!isTauri()) {
      this.note(t('su_app_only'));
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
      this.note(t('su_starting'), 0);
      const path = await invoke<string>('install_recommended_engine');
      this.note(t('su_registering'), 100);
      const err = await this.deps.register(path, AUTO_NAME, AUTO_EVAL);
      this.note(err ? t('su_installed_but_failed', { msg: err }) : t('su_installed', { name: AUTO_NAME }));
      this.deps.say(err ? t('su_say_failed', { msg: err }) : t('su_say_installed', { name: AUTO_NAME }), !!err);
      this.paint();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.note(t('su_install_failed', { msg }));
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
      `<div class="dir-row"><span class="dir-label">${label}</span><code class="dir-path">${path || t('su_dir_unknown')}</code>${
        path ? `<button type="button" data-act="open-dir" data-dir="${path}">${t('su_open')}</button>` : ''
      }</div>`;
    this.dialog.innerHTML = `
      <div class="dialog-body setup-body">
        <div class="dialog-head"><h2>${t('su_title')}</h2><span class="hint">${this.version ? t('su_version', { version: this.version }) : ''}</span></div>
        <p class="hint">
          ${t('su_intro')}
          ${n === 0 ? t('su_none_yet') : t('su_count', { n })}
        </p>

        <section class="setup-step">
          <div class="setup-actions">
            <button type="button" class="primary" data-act="install">${t('su_install')}</button>
            <span class="hint">${t('su_install_hint')}</span>
          </div>
          <div class="install-note">${escapeHtml(this.lastNote)}</div>
        </section>

        <section class="setup-step">
          <h3>${t('su_manual_head')}</h3>
          <p class="hint">${t('su_manual_body')}</p>
          ${dir(t('su_dir_engines'), this.enginesDir)}
        </section>

        <section class="setup-step">
          <h3>${t('su_uninstall_head')}</h3>
          <p class="hint">${t('su_uninstall_body')}</p>
          ${dir(t('su_dir_data'), this.dataDir)}
        </section>

        <div class="dialog-actions">
          <button type="button" data-act="engines">${t('su_engines_btn')}</button>
          <button type="button" data-act="update">${t('su_update_btn')}</button>
          <button type="button" class="primary" data-act="close">${t('close')}</button>
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
