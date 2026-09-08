// エンジンの登録。実行ファイルと評価関数のフォルダは各自が用意し、ここで場所を指す。
// 水匠などの評価関数は同梱しない。

import { isTauri, newEngineConfig, type EngineConfig, type EngineKind } from '../usi/engine.ts';
import type { Settings } from '../settings.ts';

export interface EngineDialogDeps {
  settings(): Settings;
  save(): Promise<void>;
  onChanged(): void;
}

export class EngineDialog {
  private readonly dialog: HTMLDialogElement;
  private editing: EngineConfig | null = null;

  constructor(host: HTMLElement, private readonly deps: EngineDialogDeps) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'engine-dialog';
    host.appendChild(this.dialog);
    this.paintList();
  }

  open(): void {
    this.paintList();
    this.dialog.showModal();
  }

  private paintList(): void {
    const s = this.deps.settings();
    const d = this.dialog;
    d.innerHTML = `
      <form method="dialog" class="dialog-body">
        <div class="dialog-head"><h2>エンジン</h2><button type="submit" class="link">閉じる</button></div>
        <p class="hint">USI 対応のエンジンを登録します。実行ファイルと評価関数のフォルダは、このアプリには入っていません。各自で用意して場所を指定してください。</p>
        <ul class="engine-list"></ul>
        <div class="dialog-actions"><button type="button" data-act="add">エンジンを追加</button></div>
      </form>`;
    const ul = d.querySelector('.engine-list')!;
    if (s.engines.length === 0) {
      const li = document.createElement('li');
      li.className = 'engine-empty';
      li.textContent = 'まだ登録がありません。';
      ul.appendChild(li);
    }
    for (const e of s.engines) {
      const li = document.createElement('li');
      li.className = 'engine-item';
      li.innerHTML = `
        <div class="engine-name">${esc(e.name || '(名前なし)')} <span class="engine-kind">${e.kind === 'fuseki' ? '布石対応' : '本将棋'}</span></div>
        <div class="engine-path">${esc(e.path)}</div>
        <div class="engine-meta">${e.evalDir ? '評価関数: ' + esc(e.evalDir) + ' · ' : ''}スレッド ${e.threads} · ハッシュ ${e.hashMb}MB · MultiPV ${e.multiPv}</div>
        <div class="engine-actions"><button type="button" data-act="edit">編集</button><button type="button" data-act="remove" class="danger">削除</button></div>`;
      li.querySelector('[data-act="edit"]')!.addEventListener('click', () => this.paintForm({ ...e, options: { ...e.options } }));
      li.querySelector('[data-act="remove"]')!.addEventListener('click', () => {
        if (!confirm(`「${e.name || e.path}」を削除しますか`)) return;
        s.engines = s.engines.filter((x) => x.id !== e.id);
        void this.deps.save().then(() => {
          this.deps.onChanged();
          this.paintList();
        });
      });
      ul.appendChild(li);
    }
    d.querySelector('[data-act="add"]')!.addEventListener('click', () => this.paintForm(newEngineConfig()));
  }

  private paintForm(cfg: EngineConfig): void {
    this.editing = cfg;
    const d = this.dialog;
    const isNew = !this.deps.settings().engines.some((e) => e.id === cfg.id);
    const optText = Object.entries(cfg.options).map(([k, v]) => `${k}=${v}`).join('\n');
    d.innerHTML = `
      <form class="dialog-body engine-form">
        <div class="dialog-head"><h2>${isNew ? 'エンジンを追加' : 'エンジンを編集'}</h2></div>
        <label>名前<input name="name" value="${esc(cfg.name)}" placeholder="例: やねうら王 (水匠)" /></label>
        <label>実行ファイル
          <span class="path-row"><input name="path" value="${esc(cfg.path)}" placeholder="例: C:\\shogi\\YaneuraOu.exe" required /><button type="button" data-pick="file">参照…</button></span>
        </label>
        <label>起動時の引数（ふつうは空。例: wsl.exe 経由なら <code>-d Ubuntu-24.04 -- /home/you/engine</code>）
          <input name="args" value="${esc(cfg.args ?? '')}" spellcheck="false" />
        </label>
        <label>評価関数のフォルダ（EvalDir。要らなければ空）
          <span class="path-row"><input name="evalDir" value="${esc(cfg.evalDir ?? '')}" placeholder="例: C:\\shogi\\eval" /><button type="button" data-pick="dir">参照…</button></span>
        </label>
        <label>作業フォルダ（空なら実行ファイルの場所）
          <span class="path-row"><input name="cwd" value="${esc(cfg.cwd ?? '')}" /><button type="button" data-pick="cwd">参照…</button></span>
        </label>
        <div class="form-row">
          <label>スレッド<input name="threads" type="number" min="1" max="256" value="${cfg.threads}" /></label>
          <label>ハッシュ (MB)<input name="hashMb" type="number" min="1" max="65536" value="${cfg.hashMb}" /></label>
          <label>MultiPV<input name="multiPv" type="number" min="1" max="20" value="${cfg.multiPv}" /></label>
        </div>
        <fieldset class="kind">
          <legend>使える局面</legend>
          <label><input type="radio" name="kind" value="normal" ${cfg.kind === 'normal' ? 'checked' : ''} /> 本将棋（41手目以降）だけ。やねうら王など</label>
          <label><input type="radio" name="kind" value="fuseki" ${cfg.kind === 'fuseki' ? 'checked' : ''} /> 布石にも対応（position fuseki を受ける布石エンジン）</label>
        </fieldset>
        <label>追加の setoption（1行に name=value）<textarea name="options" rows="3" spellcheck="false">${esc(optText)}</textarea></label>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">やめる</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>`;
    const form = d.querySelector('form')!;
    for (const b of d.querySelectorAll<HTMLButtonElement>('[data-pick]')) {
      b.addEventListener('click', () => void this.pick(b.dataset.pick as 'file' | 'dir' | 'cwd', form));
      if (!isTauri()) b.hidden = true;
    }
    d.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this.paintList());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit(form);
    });
  }

  private async pick(kind: 'file' | 'dir' | 'cwd', form: HTMLFormElement): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ multiple: false, directory: kind !== 'file', title: kind === 'file' ? 'エンジンの実行ファイル' : 'フォルダ' });
    if (typeof r !== 'string') return;
    const name = kind === 'file' ? 'path' : kind === 'dir' ? 'evalDir' : 'cwd';
    (form.elements.namedItem(name) as HTMLInputElement).value = r;
    if (kind === 'file') {
      const nameInput = form.elements.namedItem('name') as HTMLInputElement;
      if (!nameInput.value) nameInput.value = r.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? '';
    }
  }

  private async submit(form: HTMLFormElement): Promise<void> {
    const cfg = this.editing!;
    const fd = new FormData(form);
    const str = (k: string) => String(fd.get(k) ?? '').trim();
    const num = (k: string, d: number) => {
      const v = Number(fd.get(k));
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
    };
    cfg.name = str('name');
    cfg.path = str('path');
    cfg.args = str('args') || undefined;
    cfg.evalDir = str('evalDir') || undefined;
    cfg.cwd = str('cwd') || undefined;
    cfg.threads = num('threads', 4);
    cfg.hashMb = num('hashMb', 256);
    cfg.multiPv = num('multiPv', 3);
    cfg.kind = (str('kind') as EngineKind) || 'normal';
    cfg.options = {};
    for (const line of str('options').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) cfg.options[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (!cfg.path) return;
    const s = this.deps.settings();
    const i = s.engines.findIndex((e) => e.id === cfg.id);
    if (i >= 0) s.engines[i] = cfg;
    else s.engines.push(cfg);
    await this.deps.save();
    this.deps.onChanged();
    this.paintList();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
