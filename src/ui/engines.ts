// エンジンの登録。将棋所や ShogiGUI と同じく、利用者が置いた USI エンジンを何本でも登録する。
// 設定画面はエンジンが `usi` で申告した option から組み立てる。EvalDir も Threads も申告の 1 項目にすぎない。
// エンジン本体と評価関数はこのアプリに入っていない。

import { invoke } from '@tauri-apps/api/core';
import { COMMON_OPTIONS, UsiEngine, isTauri, newEngineConfig, optionValue, type EngineConfig, type EngineKind } from '../usi/engine.ts';
import { EVAL_PRESETS, presetOf, recipeFor } from '../usi/evalscale.ts';
import type { UsiOption } from '../usi/parse.ts';
import { BUILTIN_ID, type Settings } from '../settings.ts';

export interface EngineDialogDeps {
  settings(): Settings;
  save(): Promise<void>;
  onChanged(): void;
  onLog(engineName: string, dir: 'in' | 'out' | 'err' | 'sys', text: string): void;
}

interface FoundExecutable {
  path: string;
  name: string;
}

export class EngineDialog {
  private readonly dialog: HTMLDialogElement;
  private editing: EngineConfig | null = null;
  private enginesDir: string | null = null;

  constructor(host: HTMLElement, private readonly deps: EngineDialogDeps) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'engine-dialog';
    host.appendChild(this.dialog);
    this.paintList();
  }

  open(): void {
    this.paintList();
    this.dialog.showModal();
    if (isTauri() && !this.enginesDir) {
      void invoke<string>('engines_dir').then((d) => {
        this.enginesDir = d;
        const el = this.dialog.querySelector('.engines-dir');
        if (el) el.textContent = d;
      }).catch(() => undefined);
    }
  }

  // ---- 一覧 ----
  private paintList(): void {
    const s = this.deps.settings();
    const d = this.dialog;
    d.innerHTML = `
      <form method="dialog" class="dialog-body">
        <div class="dialog-head"><h2>エンジン</h2><button type="submit" class="link">閉じる</button></div>
        <p class="hint">USI 対応のエンジンなら何本でも登録できます。本体と評価関数はこのアプリには入っていません。
          エンジンのフォルダ <code class="engines-dir">${esc(this.enginesDir ?? '')}</code> に置けばまとめて取り込めます。
          <button type="button" class="link" data-act="open-dir">フォルダを開く</button></p>
        <ul class="engine-list"></ul>
        <div class="dialog-actions">
          <button type="button" data-act="import">フォルダから取り込む</button>
          <button type="button" data-act="add" class="primary">実行ファイルを選んで追加</button>
        </div>
      </form>`;
    const ul = d.querySelector('.engine-list')!;
    if (s.engines.length === 0) {
      const li = document.createElement('li');
      li.className = 'engine-empty';
      li.textContent = 'まだ登録がありません。布石の評価は内蔵のものが動きますが、41 手目以降の検討と対局にはエンジンが要ります。';
      ul.appendChild(li);
    }
    const normalDefault = s.engines.find((e) => e.id === s.normalEngineId && e.kind === 'normal') ?? s.engines.find((e) => e.kind === 'normal');
    for (const e of s.engines) {
      const li = document.createElement('li');
      li.className = 'engine-item';
      const badges: string[] = [];
      badges.push(`<span class="engine-kind">${e.kind === 'fuseki' ? '布石にも対応' : '本将棋'}</span>`);
      if (e.kind === 'normal' && normalDefault?.id === e.id) badges.push('<span class="engine-default">本将棋の既定</span>');
      if (e.kind === 'fuseki' && s.fusekiEngineId === e.id) badges.push('<span class="engine-default">布石の既定</span>');
      const opts = ['Threads', 'USI_Hash', 'EvalDir'].map((k) => {
        const v = optionValue(e, k);
        return v ? `${k === 'USI_Hash' ? 'ハッシュ' : k === 'Threads' ? 'スレッド' : '評価関数'} ${esc(v)}${k === 'USI_Hash' ? 'MB' : ''}` : '';
      }).filter(Boolean);
      li.innerHTML = `
        <div class="engine-name">${esc(e.name || '(名前なし)')} ${badges.join(' ')}${e.idName ? `<span class="engine-idname">${esc(e.idName)}</span>` : ''}</div>
        <div class="engine-path">${esc(e.path)}${e.args ? ' ' + esc(e.args) : ''}</div>
        <div class="engine-meta">${opts.join(' · ')}${opts.length ? ' · ' : ''}勝率の目盛り ${e.eval.scale} / ${e.eval.offsetCp >= 0 ? '+' : ''}${e.eval.offsetCp}</div>
        <div class="engine-actions">
          <button type="button" data-act="edit">設定</button>
          <button type="button" data-act="dup">複製</button>
          <button type="button" data-act="default" ${(e.kind === 'normal' ? normalDefault?.id === e.id : s.fusekiEngineId === e.id) ? 'disabled' : ''}>${e.kind === 'fuseki' ? '布石の既定にする' : '本将棋の既定にする'}</button>
          <button type="button" data-act="remove" class="danger">削除</button>
        </div>`;
      li.querySelector('[data-act="edit"]')!.addEventListener('click', () => this.paintForm(clone(e)));
      li.querySelector('[data-act="dup"]')!.addEventListener('click', () => {
        const c = clone(e);
        c.id = newEngineConfig().id;
        c.name = (e.name || 'エンジン') + '（複製）';
        this.paintForm(c);
      });
      li.querySelector('[data-act="default"]')!.addEventListener('click', () => {
        if (e.kind === 'fuseki') s.fusekiEngineId = e.id;
        else s.normalEngineId = e.id;
        void this.persist();
      });
      li.querySelector('[data-act="remove"]')!.addEventListener('click', () => {
        if (!confirm(`「${e.name || e.path}」を削除しますか`)) return;
        s.engines = s.engines.filter((x) => x.id !== e.id);
        if (s.normalEngineId === e.id) s.normalEngineId = undefined;
        if (s.fusekiEngineId === e.id) s.fusekiEngineId = BUILTIN_ID;
        s.analysisSlots = s.analysisSlots.map((x) => (x === e.id ? 'auto' : x));
        void this.persist();
      });
      ul.appendChild(li);
    }
    d.querySelector('[data-act="add"]')!.addEventListener('click', () => void this.addByFile());
    d.querySelector('[data-act="import"]')!.addEventListener('click', () => void this.importFromDir());
    d.querySelector('[data-act="open-dir"]')!.addEventListener('click', () => {
      if (this.enginesDir) void invoke('open_path', { path: this.enginesDir }).catch(() => undefined);
    });
  }

  private async persist(): Promise<void> {
    await this.deps.save();
    this.deps.onChanged();
    this.paintList();
  }

  private busy(text: string): void {
    this.dialog.innerHTML = `<div class="dialog-body"><div class="dialog-head"><h2>エンジン</h2></div><p class="hint">${esc(text)}</p></div>`;
  }

  // ---- 追加 ----
  private async addByFile(): Promise<void> {
    if (!isTauri()) {
      this.paintForm(newEngineConfig());
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ multiple: false, directory: false, title: 'エンジンの実行ファイル' });
    if (typeof r !== 'string') return;
    const cfg = newEngineConfig();
    cfg.path = r;
    await this.probeInto(cfg, true);
    this.paintForm(cfg);
  }

  /** `usi` で申告を読み、名前・種別・目盛りを埋める。失敗しても登録は続けられる（申告なしで） */
  private async probeInto(cfg: EngineConfig, proposeName: boolean): Promise<string | null> {
    this.busy(`${basename(cfg.path)} を起動して申告を読んでいます…`);
    try {
      const r = await UsiEngine.probe({ path: cfg.path, args: cfg.args, cwd: cfg.cwd }, (dir, text) => this.deps.onLog(basename(cfg.path), dir, text));
      cfg.idName = r.idName;
      cfg.idAuthor = r.idAuthor;
      cfg.declared = r.options;
      const recipe = r.idName ? recipeFor(r.idName) : null;
      const fusekiCapable = r.options.some((o) => /^Fuseki_/.test(o.name));
      cfg.kind = fusekiCapable ? 'fuseki' : (recipe?.kind ?? 'normal');
      if (proposeName) {
        cfg.name = recipe?.name ?? r.idName ?? basename(cfg.path).replace(/\.exe$/i, '');
        if (recipe) cfg.eval = { ...recipe.eval };
      }
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (proposeName && !cfg.name) cfg.name = basename(cfg.path).replace(/\.exe$/i, '');
      return msg;
    }
  }

  private async importFromDir(): Promise<void> {
    if (!isTauri()) return;
    let dir = this.enginesDir;
    try {
      dir = dir ?? (await invoke<string>('engines_dir'));
    } catch (e) {
      alert(String(e));
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: false, directory: true, defaultPath: dir, title: 'エンジンを置いたフォルダ' });
    if (typeof picked !== 'string') return;
    let found: FoundExecutable[];
    try {
      found = await invoke<FoundExecutable[]>('scan_executables', { dir: picked });
    } catch (e) {
      alert(String(e));
      return;
    }
    const s = this.deps.settings();
    const known = new Set(s.engines.map((e) => e.path));
    const candidates = found.filter((f) => !known.has(f.path));
    const d = this.dialog;
    d.innerHTML = `
      <form class="dialog-body">
        <div class="dialog-head"><h2>フォルダから取り込む</h2></div>
        <p class="hint">${esc(picked)} の下 2 段までの実行ファイル。${candidates.length === 0 ? '新しく取り込めるものはありません。' : '取り込むものを選んでください。1 本ずつ起動して申告を読みます。'}</p>
        <ul class="import-list">${candidates.map((f, i) => `<li><label><input type="checkbox" name="pick" value="${i}" ${/yaneuraou|suisho|shogi|usi|engine/i.test(f.name) ? 'checked' : ''}/> <span class="import-name">${esc(f.name)}</span> <span class="engine-path">${esc(f.path)}</span></label></li>`).join('')}</ul>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">やめる</button>
          <button type="submit" class="primary" ${candidates.length === 0 ? 'disabled' : ''}>取り込む</button>
        </div>
      </form>`;
    d.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this.paintList());
    d.querySelector('form')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const idx = [...d.querySelectorAll<HTMLInputElement>('input[name="pick"]:checked')].map((i) => Number(i.value));
      const errors: string[] = [];
      for (const i of idx) {
        const f = candidates[i]!;
        const cfg = newEngineConfig();
        cfg.path = f.path;
        const err = await this.probeInto(cfg, true);
        if (err) errors.push(`${f.name}: ${err}`);
        else s.engines.push(cfg);
      }
      await this.deps.save();
      this.deps.onChanged();
      this.paintList();
      if (errors.length) alert('起動できなかったものがあります（登録していません）:\n' + errors.join('\n'));
    });
  }

  // ---- 設定画面 ----
  private paintForm(cfg: EngineConfig): void {
    this.editing = cfg;
    const d = this.dialog;
    const s = this.deps.settings();
    const isNew = !s.engines.some((e) => e.id === cfg.id);
    const preset = presetOf(cfg.eval);
    const declared = sortOptions(cfg.declared ?? []);
    const optionRows = declared.map((o) => optionRow(o, cfg.options[o.name])).join('');
    const optText = Object.entries(cfg.options).filter(([k]) => !declared.some((o) => o.name === k)).map(([k, v]) => `${k}=${v}`).join('\n');
    d.innerHTML = `
      <form class="dialog-body engine-form">
        <div class="dialog-head"><h2>${isNew ? 'エンジンを追加' : 'エンジンの設定'}</h2>${cfg.idName ? `<span class="engine-idname">${esc(cfg.idName)}${cfg.idAuthor ? ' · ' + esc(cfg.idAuthor) : ''}</span>` : ''}</div>
        <div class="form-row two">
          <label>名前<input name="name" value="${esc(cfg.name)}" placeholder="例: 水匠5" required /></label>
          <fieldset class="kind inline">
            <legend>使える局面</legend>
            <label><input type="radio" name="kind" value="normal" ${cfg.kind === 'normal' ? 'checked' : ''} /> 本将棋（41手目以降）</label>
            <label><input type="radio" name="kind" value="fuseki" ${cfg.kind === 'fuseki' ? 'checked' : ''} /> 布石にも対応</label>
          </fieldset>
        </div>
        <label>実行ファイル
          <span class="path-row"><input name="path" value="${esc(cfg.path)}" placeholder="例: C:\\shogi\\YaneuraOu.exe" required /><button type="button" data-pick="path">参照…</button><button type="button" data-act="reprobe" title="起動して申告を読み直す">申告を読む</button></span>
        </label>
        <details class="engine-advanced">
          <summary>起動の細かい設定</summary>
          <label>起動時の引数（ふつうは空。例: wsl.exe 経由なら <code>-d Ubuntu-24.04 -- /home/you/engine</code>）
            <input name="args" value="${esc(cfg.args ?? '')}" spellcheck="false" />
          </label>
          <label>作業フォルダ（空なら実行ファイルの場所）
            <span class="path-row"><input name="cwd" value="${esc(cfg.cwd ?? '')}" /><button type="button" data-pick="cwd">参照…</button></span>
          </label>
        </details>
        <fieldset class="eval-scale">
          <legend>評価値から勝率への目盛り</legend>
          <div class="form-row">
            <label>型<select name="preset">
              ${EVAL_PRESETS.map((p) => `<option value="${p.id}" ${preset?.id === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
              <option value="custom" ${preset ? '' : 'selected'}>手で指定</option>
            </select></label>
            <label>S（幅）<input name="scale" type="number" min="1" max="10000" value="${cfg.eval.scale}" /></label>
            <label>offset（50% の cp）<input name="offset" type="number" min="-5000" max="5000" value="${cfg.eval.offsetCp}" /></label>
          </div>
          <p class="hint eval-note">${esc(preset?.note ?? 'p = 1 / (1 + exp(−(cp − offset) / S))。エンジンの目盛りに合わせて決める')}</p>
        </fieldset>
        <fieldset class="usi-options">
          <legend>エンジンの設定（申告どおり）</legend>
          ${declared.length ? `<div class="option-grid">${optionRows}</div>` : '<p class="hint">申告を読んでいません。「申告を読む」で起動して読むと、ここに項目が並びます。</p>'}
          <label>申告に無い setoption（1行に name=value）<textarea name="extra" rows="2" spellcheck="false">${esc(optText)}</textarea></label>
        </fieldset>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">やめる</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>`;
    const form = d.querySelector('form')!;
    for (const b of d.querySelectorAll<HTMLButtonElement>('[data-pick]')) {
      b.addEventListener('click', () => void this.pick(b.dataset.pick as 'path' | 'cwd' | string, form));
      if (!isTauri()) b.hidden = true;
    }
    const reprobe = d.querySelector<HTMLButtonElement>('[data-act="reprobe"]')!;
    if (!isTauri()) reprobe.hidden = true;
    reprobe.addEventListener('click', async () => {
      this.readForm(form, cfg);
      const err = await this.probeInto(cfg, !cfg.name);
      if (err) alert(`申告を読めない: ${err}`);
      this.paintForm(cfg);
    });
    const presetSel = form.elements.namedItem('preset') as HTMLSelectElement;
    presetSel.addEventListener('change', () => {
      const p = EVAL_PRESETS.find((x) => x.id === presetSel.value);
      if (!p) return;
      (form.elements.namedItem('scale') as HTMLInputElement).value = String(p.eval.scale);
      (form.elements.namedItem('offset') as HTMLInputElement).value = String(p.eval.offsetCp);
      d.querySelector('.eval-note')!.textContent = p.note;
    });
    for (const name of ['scale', 'offset']) {
      (form.elements.namedItem(name) as HTMLInputElement).addEventListener('input', () => {
        presetSel.value = 'custom';
      });
    }
    for (const b of d.querySelectorAll<HTMLButtonElement>('[data-opt-pick]')) {
      b.addEventListener('click', () => void this.pick(b.dataset.optPick!, form, b.dataset.optDir === '1'));
    }
    for (const b of d.querySelectorAll<HTMLButtonElement>('[data-opt-reset]')) {
      b.addEventListener('click', () => {
        const name = b.dataset.optReset!;
        const o = declared.find((x) => x.name === name);
        const el = form.elements.namedItem('opt:' + name) as HTMLInputElement | HTMLSelectElement | null;
        if (!o || !el) return;
        if (o.type === 'check') (el as HTMLInputElement).checked = o.default === 'true';
        else el.value = o.default ?? '';
      });
    }
    d.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this.paintList());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit(form);
    });
  }

  private async pick(field: string, form: HTMLFormElement, directory = field === 'cwd'): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ multiple: false, directory, title: directory ? 'フォルダ' : 'ファイル' });
    if (typeof r !== 'string') return;
    const el = form.elements.namedItem(field) as HTMLInputElement | null;
    if (el) el.value = r;
  }

  /** 画面の値を cfg に写す（保存でも申告の読み直しでも使う） */
  private readForm(form: HTMLFormElement, cfg: EngineConfig): void {
    const fd = new FormData(form);
    const str = (k: string) => String(fd.get(k) ?? '').trim();
    cfg.name = str('name');
    cfg.path = str('path');
    cfg.args = str('args') || undefined;
    cfg.cwd = str('cwd') || undefined;
    cfg.kind = (str('kind') as EngineKind) || 'normal';
    const scale = Number(fd.get('scale'));
    const offset = Number(fd.get('offset'));
    cfg.eval = { scale: Number.isFinite(scale) && scale > 0 ? scale : 600, offsetCp: Number.isFinite(offset) ? offset : 0 };
    const options: Record<string, string> = {};
    for (const o of cfg.declared ?? []) {
      const el = form.elements.namedItem('opt:' + o.name) as HTMLInputElement | HTMLSelectElement | null;
      if (!el || o.type === 'button') continue;
      const v = o.type === 'check' ? String((el as HTMLInputElement).checked) : String(el.value).trim();
      if (v !== (o.default ?? '') && !(o.type !== 'check' && v === '' && o.default === undefined)) options[o.name] = v;
    }
    for (const line of str('extra').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) options[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    cfg.options = options;
  }

  private async submit(form: HTMLFormElement): Promise<void> {
    const cfg = this.editing!;
    this.readForm(form, cfg);
    if (!cfg.path) return;
    if (!cfg.name) cfg.name = basename(cfg.path).replace(/\.exe$/i, '');
    const s = this.deps.settings();
    const i = s.engines.findIndex((e) => e.id === cfg.id);
    if (i >= 0) s.engines[i] = cfg;
    else s.engines.push(cfg);
    if (cfg.kind === 'normal' && !s.engines.some((e) => e.id === s.normalEngineId && e.kind === 'normal')) s.normalEngineId = cfg.id;
    await this.persist();
  }
}

function sortOptions(options: UsiOption[]): UsiOption[] {
  const rank = (o: UsiOption) => {
    const i = COMMON_OPTIONS.indexOf(o.name);
    return i < 0 ? COMMON_OPTIONS.length : i;
  };
  return options.slice().sort((a, b) => rank(a) - rank(b));
}

function optionRow(o: UsiOption, override: string | undefined): string {
  const cur = override ?? o.default ?? '';
  const id = 'opt:' + o.name;
  const changed = override !== undefined && override !== (o.default ?? '');
  let control: string;
  switch (o.type) {
    case 'check':
      control = `<input type="checkbox" name="${esc(id)}" ${cur === 'true' ? 'checked' : ''} />`;
      break;
    case 'spin':
      control = `<input type="number" name="${esc(id)}" value="${esc(cur)}" ${o.min !== undefined ? `min="${o.min}"` : ''} ${o.max !== undefined ? `max="${o.max}"` : ''} />`;
      break;
    case 'combo':
      control = `<select name="${esc(id)}">${(o.vars ?? [cur]).map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
      break;
    case 'button':
      control = `<span class="hint">（実行の項目。ここでは設定できません）</span>`;
      break;
    default: {
      const pathLike = /(Dir|File|Path)$/i.test(o.name) || o.type === 'filename';
      const dir = /Dir$/i.test(o.name);
      control = `<span class="path-row"><input type="text" name="${esc(id)}" value="${esc(cur)}" spellcheck="false" />${pathLike && isTauri() ? `<button type="button" data-opt-pick="${esc(id)}" data-opt-dir="${dir ? 1 : 0}">参照…</button>` : ''}</span>`;
    }
  }
  const range = o.type === 'spin' && (o.min !== undefined || o.max !== undefined) ? `<span class="opt-range">${o.min ?? ''}〜${o.max ?? ''}</span>` : '';
  return `<div class="opt-row ${changed ? 'changed' : ''}"><label class="opt-name" for="${esc(id)}">${esc(o.name)}</label><div class="opt-control">${control}${range}</div><button type="button" class="link opt-reset" data-opt-reset="${esc(o.name)}" title="申告の既定値 ${esc(o.default ?? '')} に戻す">既定</button></div>`;
}

function clone(e: EngineConfig): EngineConfig {
  return { ...e, options: { ...e.options }, eval: { ...e.eval }, declared: e.declared?.map((o) => ({ ...o })) };
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
