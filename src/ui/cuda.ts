// CUDA 版への切り替えの案内（Issue #2、2026-09-14 決定）。
//
// Libra の配布物は DirectML 版の ONNX Runtime を同梱する。NVIDIA の GPU なら DLL を CUDA 版に
// 差し替えると約 4 倍速いが、CUDA・cuDNN は利用者が NVIDIA から入れる（アプリにもエンジンにも入れない。
// docs/plan-model-distribution.md）。だから持っている人にだけ知らせる。
//
// 出すのは 2 通り。
// - 切り替えの勧め: NVIDIA の GPU があるのに DirectML・CPU で読んでいる。「今後表示しない」で止められる
// - 切り替えの失敗: CUDA を試して DLL が足りなかった（`provider fallback cuda: …`）。本人が切り替え中なので止めない
// どちらも同じエンジン・同じ中身なら、1 回の起動のあいだに 2 度は出さない。
//
// 手で行う手順は素人には難しい（手順どおりでも cuDNN のインストーラが PATH に足さず CPU に落ちた）ので、
// やねうら王の導入と同じくボタンで済ませる（2026-09-14 決定）。
// - 揃っているもの（CUDA 12・cuDNN 9・CUDA 版の ONNX Runtime）を一覧にし、足りないものに合わせてボタンを 1 つ出す
// - CUDA 12・cuDNN 9: NVIDIA のインストーラを「ダウンロード」フォルダに取ってくる。インストールは利用者が行う
// - ONNX Runtime: 取ってきてエンジンのフォルダの DLL を差し替える。元の DLL を残して戻せるようにする
// - 標準の場所に入った CUDA・cuDNN は Tauri 側がエンジンの PATH に足す（src-tauri/src/cuda.rs）

import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n.ts';
import { isTauri, type EngineConfig } from '../usi/engine.ts';
import { NVIDIA_VENDOR_ID, PROVIDER_LABELS, cudaAdvice, cudaFallbackError, type CudaAdvice, type ProviderReport } from '../usi/provider.ts';
import type { Settings } from '../settings.ts';

const ORT_RELEASE_URL = 'https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0';
const NVIDIA_CUDA_URL = 'https://developer.nvidia.com/cuda-12-9-1-download-archive';
const NVIDIA_CUDNN_URL = 'https://developer.nvidia.com/cudnn-downloads';
/** 取ってくるインストーラ（src-tauri/src/cuda.rs と同じもの） */
const INSTALLERS = {
  cuda: { file: 'cuda_12.9.1_windows_network.exe', mb: 16 },
  cudnn: { file: 'cudnn_9.26.0_windows_x86_64.exe', mb: 1910 },
} as const;
type Kind = keyof typeof INSTALLERS;

interface GpuAdapter {
  name: string;
  vendorId: number;
}

/** 切り替えに要るものが揃っているか（src-tauri/src/cuda.rs の Status） */
interface CudaStatus {
  cuda12: string | null;
  cudnn9: string | null;
  ortCuda: boolean;
  canRestore: boolean;
}

let adapters: Promise<string | null> | null = null;
/** 調べ終えた NVIDIA の GPU の名前。無い・まだ調べていない・調べられなかったときは null */
let nvidiaName: string | null = null;

/** PC の NVIDIA の GPU の名前を調べる（無ければ null）。調べられなくても案内を出さないだけ */
export function detectNvidia(): Promise<string | null> {
  if (!adapters) {
    const list = isTauri() ? invoke<GpuAdapter[]>('gpu_adapters').catch(() => []) : Promise.resolve([]);
    adapters = list.then((l) => (nvidiaName = l.find((a) => a.vendorId === NVIDIA_VENDOR_ID)?.name ?? null));
  }
  return adapters;
}

/** 調べ終えていれば NVIDIA の GPU の名前（一覧を描くときに待たないため） */
export function knownNvidia(): string | null {
  return nvidiaName;
}

export interface CudaGuideDeps {
  settings(): Settings;
  save(): Promise<void>;
  /** いま窓で遮ってはいけないか（対局が進んでいる・棋譜解析の途中）。時計が動いている間に盤を塞がない */
  busy(): boolean;
  /** 状態の行に 1 行出す */
  say(text: string): void;
  /** 動いているエンジンを全部止める（DLL を差し替える前） */
  beforeInstall(): Promise<void>;
}

export class CudaGuide {
  private readonly dialog: HTMLDialogElement;
  /** この起動のあいだに出した案内（エンジン・種類・エラー文） */
  private readonly shown = new Set<string>();
  /** 忙しくて出せなかった案内。落ち着いたら flush() で開く（最後の 1 つだけ） */
  private pending: { cfg: EngineConfig; r: ProviderReport; advice: CudaAdvice } | null = null;
  /** いま開いている案内 */
  private current: { cfg: EngineConfig; r: ProviderReport; advice: CudaAdvice } | null = null;
  private status: CudaStatus | null = null;
  /** 取ってきたインストーラ（入れる順を出すため） */
  private fetched: Kind[] = [];
  private working = false;
  private failed = false;
  private note = '';

  constructor(host: HTMLElement, private readonly deps: CudaGuideDeps) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'engine-dialog cuda-dialog';
    host.appendChild(this.dialog);
    this.dialog.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (b) void this.act(b.dataset.act!);
    });
  }

  /** エンジンが推論のプロバイダを申告したとき。出すべきときだけ出す */
  async consider(cfg: EngineConfig, r: ProviderReport): Promise<void> {
    const advice = cudaAdvice(r, (await detectNvidia()) !== null);
    if (!advice) return;
    if (advice === 'switch' && this.deps.settings().cudaHintDismissed) return;
    const key = `${cfg.id}|${advice}|${cudaFallbackError(r) ?? ''}`;
    if (this.shown.has(key)) return;
    this.shown.add(key);
    if (this.deps.busy()) {
      // 対局の手番の合間に窓を出すと、時計が動いている間に盤を塞ぐ。1 行だけ知らせて後で開く
      const name = cfg.name || cfg.idName || cfg.path;
      this.deps.say(t(advice === 'switch' ? 'cuda_later_switch' : 'cuda_later_fallback', { name, provider: PROVIDER_LABELS[r.provider] }));
      this.pending = { cfg, r, advice };
      return;
    }
    this.open(cfg, r, advice);
  }

  /** 保留した案内があり、もう忙しくなければ開く（対局が止まった・終わった、棋譜解析が終わったときに呼ぶ） */
  flush(): void {
    const p = this.pending;
    if (!p || this.deps.busy()) return;
    this.pending = null;
    if (p.advice === 'switch' && this.deps.settings().cudaHintDismissed) return;
    this.open(p.cfg, p.r, p.advice);
  }

  /** 案内を開く（「今後表示しない」にしていても開く。エンジンの一覧から呼ぶ） */
  open(cfg: EngineConfig, r: ProviderReport, advice: CudaAdvice): void {
    // 差し替えの途中で別の案内に替えない（進み具合と結果を見失う）
    if (this.working && this.dialog.open) return;
    const same = this.current?.cfg.id === cfg.id;
    this.current = { cfg, r, advice };
    if (!same) {
      this.fetched = [];
      this.note = '';
      this.failed = false;
    }
    this.status = null;
    this.paint();
    if (!this.dialog.open) this.dialog.showModal();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const cur = this.current;
    if (!cur || !isTauri()) return;
    try {
      this.status = await invoke<CudaStatus>('cuda_status', { exe: cur.cfg.path });
    } catch {
      this.status = null;
    }
    if (this.current === cur) this.paint();
  }

  private async act(act: string): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    const dir = cur.cfg.path.replace(/[\\/][^\\/]*$/, '');
    switch (act) {
      case 'dismiss':
        this.deps.settings().cudaHintDismissed = true;
        void this.deps.save();
        this.dialog.close();
        return;
      case 'close':
        this.dialog.close();
        return;
      case 'dir':
        // DLL を読むのは実行ファイルのフォルダ（作業フォルダではない）
        if (isTauri() && dir) void invoke('open_path', { path: dir }).catch(() => undefined);
        return;
      case 'ort':
        return openUrl(ORT_RELEASE_URL);
      case 'page-cuda':
        return openUrl(NVIDIA_CUDA_URL);
      case 'page-cudnn':
        return openUrl(NVIDIA_CUDNN_URL);
      case 'recheck':
        this.status = null;
        this.paint();
        return this.refresh();
      case 'fetch':
      case 'swap':
      case 'restore':
        return this.run(act, cur);
    }
  }

  /** 取ってくる・差し替える・戻す。進み具合は Tauri の engine-install イベントで届く（やねうら王の導入と同じ） */
  private async run(op: 'fetch' | 'swap' | 'restore', cur: { cfg: EngineConfig }): Promise<void> {
    const s = this.status;
    if (this.working || !s || !isTauri()) return;
    this.working = true;
    this.failed = false;
    this.note = '';
    this.paint();
    const name = cur.cfg.name || cur.cfg.idName || cur.cfg.path;
    let un: (() => void) | null = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      un = await listen<{ text: string; percent: number }>('engine-install', (e) =>
        this.setNote(t('su_note_percent', { text: e.payload.text, percent: e.payload.percent })),
      );
      if (op === 'fetch') {
        const kinds: Kind[] = [...(s.cuda12 ? [] : ['cuda' as const]), ...(s.cudnn9 ? [] : ['cudnn' as const])];
        const paths = await invoke<string[]>('download_nvidia_installers', { cuda: kinds.includes('cuda'), cudnn: kinds.includes('cudnn') });
        this.fetched = kinds;
        this.note = t('cuda_fetched');
        if (paths[0]) void reveal(paths[0]);
      } else {
        // Windows は読み込み中の DLL を置き換えさせない。検討・対局・棋譜解析のエンジンを先に止める
        this.setNote(t('su_stopping'));
        await this.deps.beforeInstall();
        if (op === 'swap') {
          await invoke('install_ort_cuda', { exe: cur.cfg.path });
          this.note = t('cuda_swapped', { name });
        } else {
          await invoke('restore_ort_dml', { exe: cur.cfg.path });
          this.note = t('cuda_restored', { name });
        }
        this.fetched = [];
        this.deps.say(this.note);
      }
    } catch (e) {
      this.failed = true;
      this.note = t('cuda_failed', { msg: e instanceof Error ? e.message : String(e) });
    } finally {
      un?.();
      this.working = false;
    }
    await this.refresh();
  }

  private setNote(text: string): void {
    this.note = text;
    const el = this.dialog.querySelector('.install-note');
    if (el) el.textContent = text;
  }

  private paint(): void {
    const cur = this.current;
    if (!cur) return;
    const { cfg, r, advice } = cur;
    const name = esc(cfg.name || cfg.idName || cfg.path);
    const provider = PROVIDER_LABELS[r.provider];
    const lead = advice === 'switch'
      ? `<p>${t('cuda_switch_lead', { name, provider, gpu: esc(knownNvidia() ?? 'NVIDIA'), factor: r.provider === 'cpu' ? 25 : 4 })}</p>
         <p class="hint">${t('cuda_switch_need')}</p>`
      : `<p>${t('cuda_fallback_lead', { name, provider })}</p>
         <pre class="cuda-error">${esc(cudaFallbackError(r) ?? '')}</pre>
         <p>${t('cuda_fallback_fix')}</p>`;
    const s = this.status;
    const off = this.working ? 'disabled' : '';
    const row = (ok: boolean, label: string, path: string | null) =>
      `<li><span class="mark ${ok ? 'ok' : 'ng'}">${ok ? '✓' : '✗'}</span><span>${label}</span><span class="hint">${t(ok ? 'cuda_have' : 'cuda_have_not')}</span>${path ? `<code>${esc(path)}</code>` : ''}</li>`;
    const check = s
      ? `<ul class="cuda-check">${row(!!s.cuda12, t('cuda_check_cuda'), s.cuda12)}${row(!!s.cudnn9, t('cuda_check_cudnn'), s.cudnn9)}${row(s.ortCuda, t('cuda_check_ort'), null)}</ul>`
      : `<p class="hint">${isTauri() ? t('cuda_checking') : t('su_app_only')}</p>`;
    let action = '';
    if (s && (!s.cuda12 || !s.cudnn9)) {
      const mb = (s.cuda12 ? 0 : INSTALLERS.cuda.mb) + (s.cudnn9 ? 0 : INSTALLERS.cudnn.mb);
      const size = mb >= 1000 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
      const steps = this.fetched.map((k) => `<li>${t(k === 'cuda' ? 'cuda_install_cuda' : 'cuda_install_cudnn', { file: INSTALLERS[k].file })}</li>`).join('');
      action = `
        <div class="setup-actions">
          <button type="button" class="${this.fetched.length ? '' : 'primary'}" data-act="fetch" ${off}>${t('cuda_fetch', { size })}</button>
          <span class="hint">${t('cuda_fetch_hint')}</span>
        </div>
        ${steps ? `<ol class="cuda-steps">${steps}</ol>` : ''}
        <div class="setup-actions">
          <button type="button" class="${this.fetched.length ? 'primary' : ''}" data-act="recheck" ${off}>${t('cuda_recheck')}</button>
        </div>`;
    } else if (s && !s.ortCuda) {
      action = `
        <div class="setup-actions">
          <button type="button" class="primary" data-act="swap" ${off}>${t('cuda_swap')}</button>
          <span class="hint">${t('cuda_swap_hint')}</span>
        </div>`;
    } else if (s) {
      action = `<p>${t('cuda_ready')}</p>`;
    }
    if (s?.canRestore && s.ortCuda) {
      action += `<div class="setup-actions"><button type="button" data-act="restore" ${off}>${t('cuda_restore')}</button></div>`;
    }
    const pages = `<p class="hint">${t('cuda_pages')}
        <button type="button" class="link" data-act="page-cuda">CUDA 12.9.1</button>
        <button type="button" class="link" data-act="page-cudnn">cuDNN 9</button></p>`;
    this.dialog.innerHTML = `
      <div class="dialog-body">
        <div class="dialog-head"><h2>${t(advice === 'switch' ? 'cuda_switch_title' : 'cuda_fallback_title')}</h2><button type="button" class="link" data-act="close">${t('close')}</button></div>
        ${lead}
        ${check}
        <div class="cuda-action">${action}</div>
        <div class="install-note">${esc(this.note)}</div>
        ${this.failed ? pages : ''}
        <details>
          <summary>${t('cuda_manual')}</summary>
          <ol class="cuda-steps">${(['cuda_step1', 'cuda_step2', 'cuda_step3'] as const).map((k) => `<li>${t(k)}</li>`).join('')}</ol>
          <p class="hint">${t('cuda_tested')}</p>
          ${this.failed ? '' : pages}
        </details>
        <p class="hint">${t('cuda_reopen_hint')}</p>
        <div class="dialog-actions">
          ${advice === 'switch' ? `<button type="button" data-act="dismiss">${t('cuda_dismiss')}</button>` : ''}
          <button type="button" data-act="ort">${t('cuda_open_ort')}</button>
          <button type="button" data-act="dir">${t('cuda_open_dir')}</button>
          <button type="button" class="primary" data-act="close">${t('close')}</button>
        </div>
      </div>`;
  }
}

function openUrl(url: string): void {
  if (isTauri()) void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url)).catch(() => undefined);
}

async function reveal(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path).catch(() => undefined);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
