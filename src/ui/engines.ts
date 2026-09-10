// エンジンの登録。将棋所や ShogiGUI と同じく、利用者が置いた USI エンジンを何本でも登録する。
// 設定画面はエンジンが `usi` で申告した option から組み立てる。EvalDir も Threads も申告の 1 項目にすぎない。
// エンジン本体と評価関数はこのアプリに入っていない。

import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n.ts';
import { COMMON_OPTIONS, GPU_READY_SEC, READY_SEC, SUMMARY_OPTIONS, UsiEngine, isTauri, newEngineConfig, optionValue, usesGpu, type EngineConfig, type EngineKind } from '../usi/engine.ts';
import { EVAL_PRESETS, evalFromDeclaration, presetOf, recipeFor, type EvalScale } from '../usi/evalscale.ts';
import type { UsiOption } from '../usi/parse.ts';
import { BUILTIN_ID, type Settings } from '../settings.ts';
import type { Key } from '../i18n.ts';

/** 一覧の見出しに出す項目の呼び名。表に無い項目は名前をそのまま出す */
const OPTION_LABELS: Record<string, Key> = {
  Threads: 'en_opt_threads',
  UCT_Threads: 'en_opt_threads',
  USI_Hash: 'en_opt_hash',
  EvalDir: 'en_opt_eval',
  DNN_Model: 'en_opt_model',
  DNN_Batch_Size: 'en_opt_batch',
};

export interface EngineDialogDeps {
  settings(): Settings;
  save(): Promise<void>;
  onChanged(): void;
  onLog(engineName: string, dir: 'in' | 'out' | 'err' | 'sys', text: string): void;
  /** USI の生ログを出す（エンジンが起動しないときの手がかり） */
  openLog(): void;
}

interface FoundExecutable {
  path: string;
  name: string;
}

/** 自動で取り込んだエンジンの登録のしかた。名前も目盛りも「入れる側」が決める */
export interface InstallSpec {
  path: string;
  name: string;
  eval: EvalScale;
  /** setoption の上書き。取り込んだ側しか知らない場所（モデルのファイルなど） */
  options?: Record<string, string>;
  /** 本将棋の既定にするか。'if-none' は既定がまだ無いときだけ（利用者の選択を上書きしない） */
  makeDefault: 'always' | 'if-none';
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
        <div class="dialog-head"><h2>${t('en_title')}</h2><button type="submit" class="link">${t('close')}</button></div>
        <p class="hint">${t('en_intro')} <code class="engines-dir">${esc(this.enginesDir ?? '')}</code> ${t('en_intro_tail')}
          <button type="button" class="link" data-act="open-dir">${t('en_open_dir')}</button></p>
        <ul class="engine-list"></ul>
        <div class="dialog-actions">
          <button type="button" data-act="log" title="${t('en_log_title')}">${t('en_log')}</button>
          <button type="button" data-act="import">${t('en_import')}</button>
          <button type="button" data-act="add" class="primary">${t('en_add')}</button>
        </div>
      </form>`;
    const ul = d.querySelector('.engine-list')!;
    if (s.engines.length === 0) {
      const li = document.createElement('li');
      li.className = 'engine-empty';
      li.textContent = t('en_empty');
      ul.appendChild(li);
    }
    const normalDefault = s.engines.find((e) => e.id === s.normalEngineId && e.kind === 'normal') ?? s.engines.find((e) => e.kind === 'normal');
    for (const e of s.engines) {
      const li = document.createElement('li');
      li.className = 'engine-item';
      const badges: string[] = [];
      badges.push(`<span class="engine-kind">${t(e.kind === 'fuseki' ? 'en_kind_fuseki' : 'en_kind_normal')}</span>`);
      if (e.kind === 'normal' && normalDefault?.id === e.id) badges.push(`<span class="engine-default">${t('en_default_normal')}</span>`);
      if (e.kind === 'fuseki' && s.fusekiEngineId === e.id) badges.push(`<span class="engine-default">${t('en_default_fuseki')}</span>`);
      if (e.gpu) badges.push(`<span class="engine-gpu">${t('en_gpu_badge')}</span>`);
      // 出す項目はエンジンによって違う（NNUE は Threads/USI_Hash、GPU のものは UCT_Threads/DNN_Model）。
      // 持っているものだけを頭から 3 つ出す
      const opts = SUMMARY_OPTIONS.map((k) => {
        const v = optionValue(e, k);
        if (!v) return '';
        const label = OPTION_LABELS[k] ? t(OPTION_LABELS[k]!) : k;
        return `${label} ${esc(k === 'DNN_Model' || k === 'EvalDir' ? basename(v) : v)}${k === 'USI_Hash' ? 'MB' : ''}`;
      }).filter(Boolean).slice(0, 3);
      li.innerHTML = `
        <div class="engine-name">${esc(e.name || t('en_noname'))} ${badges.join(' ')}${e.idName ? `<span class="engine-idname">${esc(e.idName)}</span>` : ''}</div>
        <div class="engine-path">${esc(e.path)}${e.args ? ' ' + esc(e.args) : ''}</div>
        <div class="engine-meta">${opts.join(' · ')}${opts.length ? ' · ' : ''}${t('en_scale_meta', { scale: e.eval.scale, offset: `${e.eval.offsetCp >= 0 ? '+' : ''}${e.eval.offsetCp}` })}</div>
        <div class="engine-actions">
          <button type="button" data-act="edit">${t('en_edit')}</button>
          <button type="button" data-act="dup">${t('en_dup')}</button>
          <button type="button" data-act="default" ${(e.kind === 'normal' ? normalDefault?.id === e.id : s.fusekiEngineId === e.id) ? 'disabled' : ''}>${t(e.kind === 'fuseki' ? 'en_make_default_fuseki' : 'en_make_default_normal')}</button>
          <button type="button" data-act="remove" class="danger">${t('en_remove')}</button>
        </div>`;
      li.querySelector('[data-act="edit"]')!.addEventListener('click', () => this.paintForm(clone(e)));
      li.querySelector('[data-act="dup"]')!.addEventListener('click', () => {
        const c = clone(e);
        c.id = newEngineConfig().id;
        c.name = t('en_dup_suffix', { name: e.name || t('engine_word') });
        this.paintForm(c);
      });
      li.querySelector('[data-act="default"]')!.addEventListener('click', () => {
        if (e.kind === 'fuseki') s.fusekiEngineId = e.id;
        else s.normalEngineId = e.id;
        void this.persist();
      });
      li.querySelector('[data-act="remove"]')!.addEventListener('click', () => {
        if (!confirm(t('en_remove_confirm', { name: e.name || e.path }))) return;
        s.engines = s.engines.filter((x) => x.id !== e.id);
        if (s.normalEngineId === e.id) s.normalEngineId = undefined;
        if (s.fusekiEngineId === e.id) s.fusekiEngineId = BUILTIN_ID;
        s.analysisSlots = s.analysisSlots.map((x) => (x === e.id ? 'auto' : x));
        void this.persist();
      });
      ul.appendChild(li);
    }
    d.querySelector('[data-act="log"]')!.addEventListener('click', () => {
      this.dialog.close();
      this.deps.openLog();
    });
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
    this.dialog.innerHTML = `<div class="dialog-body"><div class="dialog-head"><h2>${t('en_title')}</h2></div><p class="hint">${esc(text)}</p></div>`;
  }

  /** 取り込んだばかりのエンジンを登録する。戻り値は申告を読めなかったときの理由 */
  async addInstalled(spec: InstallSpec): Promise<string | null> {
    const cfg = newEngineConfig();
    cfg.path = spec.path;
    cfg.name = spec.name;
    const err = await this.probeInto(cfg, false);
    cfg.kind = 'normal';
    cfg.eval = { ...spec.eval };
    // 取り込んだものだけが知っている場所（モデルのファイルなど）を入れる。
    // 申告の既定と同じ値は持たない（applyOptions が送らない）ので、上書きだけを残す
    for (const [k, v] of Object.entries(spec.options ?? {})) {
      if (cfg.declared?.find((o) => o.name === k)?.default !== v) cfg.options[k] = v;
    }
    const s = this.deps.settings();
    // 同じ場所のものは置き換える（入れ直しても増やさない）
    const i = s.engines.findIndex((e) => e.path === spec.path);
    if (i >= 0) cfg.id = s.engines[i]!.id;
    if (i >= 0) s.engines[i] = cfg;
    else s.engines.push(cfg);
    const hasDefault = s.engines.some((e) => e.id === s.normalEngineId && e.kind === 'normal');
    if (spec.makeDefault === 'always' || !hasDefault) s.normalEngineId = cfg.id;
    await this.persist();
    return err;
  }

  // ---- 追加 ----
  private async addByFile(): Promise<void> {
    if (!isTauri()) {
      this.paintForm(newEngineConfig());
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const r = await open({ multiple: false, directory: false, title: t('en_pick_exe') });
    if (typeof r !== 'string') return;
    const cfg = newEngineConfig();
    cfg.path = r;
    await this.probeInto(cfg, true);
    this.paintForm(cfg);
  }

  /** `usi` で申告を読み、名前・種別・目盛りを埋める。失敗しても登録は続けられる（申告なしで） */
  private async probeInto(cfg: EngineConfig, proposeName: boolean): Promise<string | null> {
    this.busy(t('en_probing', { name: basename(cfg.path) }));
    try {
      const r = await UsiEngine.probe({ path: cfg.path, args: cfg.args, cwd: cfg.cwd }, (dir, text) => this.deps.onLog(basename(cfg.path), dir, text));
      cfg.idName = r.idName;
      cfg.idAuthor = r.idAuthor;
      cfg.declared = r.options;
      const recipe = r.idName ? recipeFor(r.idName) : null;
      const fusekiCapable = r.options.some((o) => /^Fuseki_/.test(o.name));
      cfg.kind = fusekiCapable ? 'fuseki' : (recipe?.kind ?? 'normal');
      // GPU で読むかは名前ではなく申告で決める（同じ dlshogi でも配布物ごとに名前が違う）。
      // 利用者が決めたあと（true でも false でも）は、読み直しても引っくり返さない
      if (cfg.gpu === undefined) cfg.gpu = usesGpu(r.options);
      if (proposeName) {
        cfg.name = recipe?.name ?? r.idName ?? basename(cfg.path).replace(/\.exe$/i, '');
        // 申告から読める目盛りが最優先。dlshogi 系は Eval_Coef をそのまま S に使える（当てはめが要らない）
        const declaredEval = evalFromDeclaration(r.options);
        if (declaredEval) cfg.eval = declaredEval;
        else if (recipe) cfg.eval = { ...recipe.eval };
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
    const picked = await open({ multiple: false, directory: true, defaultPath: dir, title: t('en_pick_dir') });
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
        <div class="dialog-head"><h2>${t('en_import_title')}</h2></div>
        <p class="hint">${t('en_import_hint', { dir: esc(picked) })}${t(candidates.length === 0 ? 'en_import_none' : 'en_import_pick')}</p>
        <ul class="import-list">${candidates.map((f, i) => `<li><label><input type="checkbox" name="pick" value="${i}" ${/yaneuraou|suisho|shogi|usi|engine/i.test(f.name) ? 'checked' : ''}/> <span class="import-name">${esc(f.name)}</span> <span class="engine-path">${esc(f.path)}</span></label></li>`).join('')}</ul>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">${t('cancel')}</button>
          <button type="submit" class="primary" ${candidates.length === 0 ? 'disabled' : ''}>${t('en_import_do')}</button>
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
      if (errors.length) alert(t('en_import_errors', { list: errors.join('\n') }));
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
        <div class="dialog-head"><h2>${t(isNew ? 'en_form_new' : 'en_form_edit')}</h2>${cfg.idName ? `<span class="engine-idname">${esc(cfg.idName)}${cfg.idAuthor ? ' · ' + esc(cfg.idAuthor) : ''}</span>` : ''}</div>
        <div class="form-row two">
          <label>${t('en_name')}<input name="name" value="${esc(cfg.name)}" placeholder="${t('en_name_placeholder')}" required /></label>
          <fieldset class="kind inline">
            <legend>${t('en_kind_legend')}</legend>
            <label><input type="radio" name="kind" value="normal" ${cfg.kind === 'normal' ? 'checked' : ''} /> ${t('en_kind_normal_label')}</label>
            <label><input type="radio" name="kind" value="fuseki" ${cfg.kind === 'fuseki' ? 'checked' : ''} /> ${t('en_kind_fuseki')}</label>
          </fieldset>
        </div>
        <label>${t('en_exe')}
          <span class="path-row"><input name="path" value="${esc(cfg.path)}" placeholder="${t('en_exe_placeholder')}" required /><button type="button" data-pick="path">${t('en_browse')}</button><button type="button" data-act="reprobe" title="${t('en_reprobe_title')}">${t('en_reprobe')}</button></span>
        </label>
        <details class="engine-advanced">
          <summary>${t('en_advanced')}</summary>
          <label>${t('en_args')}
            <input name="args" value="${esc(cfg.args ?? '')}" spellcheck="false" />
          </label>
          <label>${t('en_cwd')}
            <span class="path-row"><input name="cwd" value="${esc(cfg.cwd ?? '')}" /><button type="button" data-pick="cwd">${t('en_browse')}</button></span>
          </label>
        </details>
        <fieldset class="engine-gpu-box">
          <legend>${t('en_gpu_legend')}</legend>
          <label class="inline-check"><input type="checkbox" name="gpu" ${cfg.gpu ? 'checked' : ''} /> ${t('en_gpu_label')}</label>
          <p class="hint">${t('en_gpu_hint')}</p>
          <label>${t('en_ready_sec')}
            <input name="readySec" type="number" min="10" max="7200" value="${cfg.readySec ?? ''}" placeholder="${cfg.gpu ? GPU_READY_SEC : READY_SEC}" />
          </label>
          <p class="hint">${t('en_ready_sec_hint', { gpu: GPU_READY_SEC, cpu: READY_SEC })}</p>
        </fieldset>
        <fieldset class="eval-scale">
          <legend>${t('en_eval_legend')}</legend>
          <div class="form-row">
            <label>${t('en_preset')}<select name="preset">
              ${EVAL_PRESETS.map((p) => `<option value="${p.id}" ${preset?.id === p.id ? 'selected' : ''}>${esc(t(p.labelKey))}</option>`).join('')}
              <option value="custom" ${preset ? '' : 'selected'}>${t('en_preset_custom')}</option>
            </select></label>
            <label>${t('en_scale_s')}<input name="scale" type="number" min="1" max="10000" value="${cfg.eval.scale}" /></label>
            <label>${t('en_scale_offset')}<input name="offset" type="number" min="-5000" max="5000" value="${cfg.eval.offsetCp}" /></label>
          </div>
          <p class="hint eval-note">${esc(preset ? t(preset.noteKey) : t('eval_note_default'))}</p>
        </fieldset>
        <fieldset class="usi-options">
          <legend>${t('en_usi_legend')}</legend>
          ${declared.length ? `<div class="option-grid">${optionRows}</div>` : `<p class="hint">${t('en_no_declaration')}</p>`}
          <label>${t('en_extra_setoption')}<textarea name="extra" rows="2" spellcheck="false">${esc(optText)}</textarea></label>
        </fieldset>
        <div class="dialog-actions">
          <button type="button" data-act="cancel">${t('cancel')}</button>
          <button type="submit" class="primary">${t('en_save')}</button>
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
      if (err) alert(t('en_probe_failed', { msg: err }));
      this.paintForm(cfg);
    });
    const presetSel = form.elements.namedItem('preset') as HTMLSelectElement;
    presetSel.addEventListener('change', () => {
      const p = EVAL_PRESETS.find((x) => x.id === presetSel.value);
      if (!p) return;
      (form.elements.namedItem('scale') as HTMLInputElement).value = String(p.eval.scale);
      (form.elements.namedItem('offset') as HTMLInputElement).value = String(p.eval.offsetCp);
      d.querySelector('.eval-note')!.textContent = t(p.noteKey);
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
    const r = await open({ multiple: false, directory, title: t(directory ? 'en_pick_folder' : 'en_pick_file') });
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
    // 外した（false）と、まだ決めていない（undefined）は違う。false は申告の読み直しで戻さない
    cfg.gpu = (form.elements.namedItem('gpu') as HTMLInputElement | null)?.checked ?? false;
    const ready = Number(str('readySec'));
    // 保存する値と実際に待つ値をずらさない（下限は readySecOf と同じ 10 秒）
    cfg.readySec = Number.isFinite(ready) && ready > 0 ? Math.max(10, Math.round(ready)) : undefined;
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
      control = `<span class="hint">${t('en_opt_button')}</span>`;
      break;
    default: {
      // GPU のエンジンの模型は DNN_Model・DNN_Model2… で、名前が Dir/File/Path で終わらない
      const pathLike = /(Dir|File|Path|Model)\d*$/i.test(o.name) || o.type === 'filename';
      const dir = /Dir\d*$/i.test(o.name);
      control = `<span class="path-row"><input type="text" name="${esc(id)}" value="${esc(cur)}" spellcheck="false" />${pathLike && isTauri() ? `<button type="button" data-opt-pick="${esc(id)}" data-opt-dir="${dir ? 1 : 0}">${t('en_browse')}</button>` : ''}</span>`;
    }
  }
  const range = o.type === 'spin' && (o.min !== undefined || o.max !== undefined) ? `<span class="opt-range">${o.min ?? ''}〜${o.max ?? ''}</span>` : '';
  return `<div class="opt-row ${changed ? 'changed' : ''}"><label class="opt-name" for="${esc(id)}">${esc(o.name)}</label><div class="opt-control">${control}${range}</div><button type="button" class="link opt-reset" data-opt-reset="${esc(o.name)}" title="${t('en_opt_reset_title', { value: esc(o.default ?? '') })}">${t('en_opt_reset')}</button></div>`;
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
