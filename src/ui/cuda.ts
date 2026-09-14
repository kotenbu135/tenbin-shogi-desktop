// CUDA 版への切り替えの案内（Issue #2、2026-09-14 決定）。
//
// Libra の配布物は DirectML 版の ONNX Runtime を同梱する。NVIDIA の GPU なら DLL を CUDA 版に
// 差し替えると約 4 倍速いが、CUDA・cuDNN は利用者が NVIDIA から入れる（配布条件のため、アプリにも
// エンジンにも入れない。docs/plan-model-distribution.md）。だから持っている人にだけ、手順を知らせる。
//
// 出すのは 2 通り。
// - 切り替えの勧め: NVIDIA の GPU があるのに DirectML・CPU で読んでいる。「今後表示しない」で止められる
// - 切り替えの失敗: CUDA を試して DLL が足りなかった（`provider fallback cuda: …`）。本人が切り替え中なので止めない
// どちらも同じエンジン・同じ中身なら、1 回の起動のあいだに 2 度は出さない。

import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n.ts';
import { isTauri, type EngineConfig } from '../usi/engine.ts';
import { NVIDIA_VENDOR_ID, PROVIDER_LABELS, cudaAdvice, cudaFallbackError, type CudaAdvice, type ProviderReport } from '../usi/provider.ts';
import type { Settings } from '../settings.ts';

const ORT_RELEASE_URL = 'https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0';

interface GpuAdapter {
  name: string;
  vendorId: number;
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
}

export class CudaGuide {
  private readonly dialog: HTMLDialogElement;
  /** この起動のあいだに出した案内（エンジン・種類・エラー文） */
  private readonly shown = new Set<string>();
  /** 忙しくて出せなかった案内。落ち着いたら flush() で開く（最後の 1 つだけ） */
  private pending: { cfg: EngineConfig; r: ProviderReport; advice: CudaAdvice } | null = null;

  constructor(host: HTMLElement, private readonly deps: CudaGuideDeps) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'engine-dialog cuda-dialog';
    host.appendChild(this.dialog);
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
    const name = esc(cfg.name || cfg.idName || cfg.path);
    const provider = PROVIDER_LABELS[r.provider];
    const lead = advice === 'switch'
      ? `<p>${t('cuda_switch_lead', { name, provider, gpu: esc(knownNvidia() ?? 'NVIDIA'), factor: r.provider === 'cpu' ? 25 : 4 })}</p>
         <p class="hint">${t('cuda_switch_need')}</p>`
      : `<p>${t('cuda_fallback_lead', { name, provider })}</p>
         <pre class="cuda-error">${esc(cudaFallbackError(r) ?? '')}</pre>
         <p>${t('cuda_fallback_fix')}</p>`;
    // 失敗したときは手順 1（ONNX Runtime の差し替え）は済んでいる。足りないのは手順 2 の DLL
    const steps = (advice === 'switch' ? ['cuda_step1', 'cuda_step2', 'cuda_step3'] as const : ['cuda_step2', 'cuda_step3'] as const)
      .map((k) => `<li>${t(k)}</li>`).join('');
    this.dialog.innerHTML = `
      <form method="dialog" class="dialog-body">
        <div class="dialog-head"><h2>${t(advice === 'switch' ? 'cuda_switch_title' : 'cuda_fallback_title')}</h2><button type="submit" class="link">${t('close')}</button></div>
        ${lead}
        <ol class="cuda-steps">${steps}</ol>
        <p class="hint">${t('cuda_tested')}</p>
        <p class="hint">${t('cuda_reopen_hint')}</p>
        <div class="dialog-actions">
          ${advice === 'switch' ? `<button type="button" data-act="dismiss">${t('cuda_dismiss')}</button>` : ''}
          ${advice === 'switch' ? `<button type="button" data-act="ort">${t('cuda_open_ort')}</button>` : ''}
          <button type="button" data-act="dir">${t('cuda_open_dir')}</button>
          <button type="submit" class="primary">${t('close')}</button>
        </div>
      </form>`;
    this.dialog.querySelector('[data-act="dismiss"]')?.addEventListener('click', () => {
      this.deps.settings().cudaHintDismissed = true;
      void this.deps.save();
      this.dialog.close();
    });
    this.dialog.querySelector('[data-act="ort"]')?.addEventListener('click', () => {
      if (isTauri()) void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(ORT_RELEASE_URL)).catch(() => undefined);
    });
    this.dialog.querySelector('[data-act="dir"]')!.addEventListener('click', () => {
      // DLL を読むのは実行ファイルのフォルダ（作業フォルダではない）
      const dir = cfg.path.replace(/[\\/][^\\/]*$/, '');
      if (isTauri() && dir) void invoke('open_path', { path: dir }).catch(() => undefined);
    });
    if (!this.dialog.open) this.dialog.showModal();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
