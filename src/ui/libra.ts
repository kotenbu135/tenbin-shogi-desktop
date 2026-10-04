// 天秤将棋の AI「Libra」を、LibraShogi の GitHub の最新のリリースから自動で入れて既定にする。
//
// 起動のたびに最新のリリースを確かめ、入っている版より新しければ取ってきて差し替える（約 55MB）。
// 入れた Libra は布石と本将棋の両方の既定にする（1 本で 1 手目から終局まで指す）。
// 版ごとに別のフォルダへ入れるので、動いている libra.exe を上書きせず、取り込みに失敗しても前の版で指し続けられる。
// 0.2 以前の Libra（玉配置表で両玉を置く版）はサポートを終えた。

import { t } from '../i18n.ts';
import { isTauri } from '../usi/engine.ts';
import { compareVersion, libraVersionOf, parseVersion } from '../usi/libra.ts';
import type { Settings } from '../settings.ts';
import type { InstallSpec } from './engines.ts';

/** Rust の `libra_latest` が返すもの */
export interface LibraRelease {
  tag: string;
  name: string;
  url: string;
  sha256: string;
  size: number;
}

/** Libra は Eval_Coef を名乗らず、cp を勝率から `435·ln(p/(1−p)) + 34` で作る（LibraShogi の docs/protocol.md §3） */
export const LIBRA_EVAL = { scale: 435, offsetCp: 34 };

export interface LibraDeps {
  settings(): Settings;
  save(): Promise<void>;
  /** 取り込んだエンジンを登録する。戻り値は申告を読めなかったときの理由 */
  register(spec: InstallSpec): Promise<string | null>;
  /** 状態の行に出す */
  say(text: string, error?: boolean): void;
}

export type LibraOutcome =
  | { kind: 'installed'; tag: string; name: string }
  | { kind: 'adopted'; tag: string; name: string }
  | { kind: 'current'; tag: string }
  | { kind: 'failed'; message: string }
  | { kind: 'skipped' };

/**
 * 登録のうち、そのリリースと同じかより新しい Libra（利用者が手で登録したもの）。
 * あればそれを既定にして、同じ版を二重に取ってこない
 */
export function registeredAtLeast(s: Settings, tag: string): Settings['engines'][number] | null {
  const want = parseVersion(tag);
  if (!want) return null;
  return s.engines.find((e) => {
    const v = libraVersionOf(e.idName);
    return e.kind === 'fuseki' && v !== null && compareVersion(v, want) >= 0;
  }) ?? null;
}

export class LibraUpdater {
  private running: Promise<LibraOutcome> | null = null;

  constructor(private readonly deps: LibraDeps) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * 最新の Libra を確かめて、要れば入れる。重ねて呼ばれたら同じ処理を待つ。
   * onNote は進み具合（取りに行っている MB など）
   */
  ensureLatest(onNote?: (text: string, percent?: number) => void): Promise<LibraOutcome> {
    if (!this.running) {
      this.running = this.run(onNote).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(onNote?: (text: string, percent?: number) => void): Promise<LibraOutcome> {
    if (!isTauri()) return { kind: 'skipped' };
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const s = this.deps.settings();
    let release: LibraRelease;
    try {
      onNote?.(t('lb_checking'));
      release = await invoke<LibraRelease>('libra_latest');
    } catch (e) {
      return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
    const managed = s.libra ? s.engines.find((e) => e.id === s.libra!.engineId) ?? null : null;
    const want = parseVersion(release.tag);
    const have = managed && s.libra ? parseVersion(s.libra.tag) : null;
    const present = managed ? await invoke<boolean>('path_is_file', { path: managed.path }).catch(() => false) : false;
    if (managed && present && want && have && compareVersion(have, want) >= 0) {
      // 古い版のフォルダは、動いていなければここで片づける（動いていれば次の起動で）
      void invoke('remove_old_libra', { keep: s.libra!.tag }).catch(() => undefined);
      return { kind: 'current', tag: s.libra!.tag };
    }
    // 利用者が同じ版を手で登録していれば、それを既定にするだけ
    if (!managed) {
      const own = registeredAtLeast(s, release.tag);
      if (own) {
        s.libra = { tag: release.tag, engineId: own.id };
        s.fusekiEngineId = own.id;
        s.normalEngineId = own.id;
        await this.deps.save();
        return { kind: 'adopted', tag: release.tag, name: own.name || own.path };
      }
    }
    const un = await listen<{ text: string; percent: number }>('engine-install', (e) => onNote?.(e.payload.text, e.payload.percent));
    try {
      const exe = await invoke<string>('install_libra', { release, previous: managed?.path ?? null });
      onNote?.(t('su_registering'), 100);
      const name = `Libra ${release.tag}`;
      const err = await this.deps.register({
        path: exe,
        name,
        eval: LIBRA_EVAL,
        makeDefault: 'always',
        makeDefaultFuseki: true,
        replaceId: managed?.id,
      });
      if (err) return { kind: 'failed', message: t('su_installed_but_failed', { msg: err }) };
      const cfg = this.deps.settings().engines.find((e) => e.path === exe);
      if (cfg) {
        const st = this.deps.settings();
        st.libra = { tag: release.tag, engineId: cfg.id };
        await this.deps.save();
      }
      void invoke('remove_old_libra', { keep: release.tag }).catch(() => undefined);
      return { kind: 'installed', tag: release.tag, name };
    } catch (e) {
      return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
    } finally {
      un();
    }
  }

  /** 結果を状態の行に出す文。何も変わらなかったときは空 */
  static message(o: LibraOutcome, manual: boolean): { text: string; error: boolean } | null {
    switch (o.kind) {
      case 'installed':
        return { text: t('lb_installed', { name: o.name }), error: false };
      case 'adopted':
        return { text: t('lb_adopted', { name: o.name }), error: false };
      case 'current':
        return manual ? { text: t('lb_current', { tag: o.tag }), error: false } : null;
      case 'failed':
        return { text: t('lb_failed', { msg: o.message }), error: true };
      case 'skipped':
        return manual ? { text: t('su_app_only'), error: true } : null;
    }
  }
}
