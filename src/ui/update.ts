// 自動更新。GitHub の Releases に置いた latest.json を見て、新しい版があれば
// 取り込んで入れ替え、再起動する（Tauri の updater プラグイン）。
//
// 署名した配布物だけを受け取る（公開鍵は tauri.conf.json、秘密鍵は配布する側が持つ）。
// ブラウザのプレビューでは何もしない。

import { t } from '../i18n.ts';
import { isTauri } from '../usi/engine.ts';

export interface UpdateDeps {
  say(text: string, error?: boolean): void;
  /** 入れ替えの直前。エンジンを止めるなど、再起動の前に片づけること */
  beforeInstall?(): Promise<void>;
}

/** いまの版。ブラウザのプレビューでは空 */
export async function currentVersion(): Promise<string> {
  if (!isTauri()) return '';
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '';
  }
}

/**
 * 更新を確認する。quiet なら、無いときと繋がらないときは黙っている（起動のたびに呼ぶため）。
 * 見つかったら中身を伝えてから、承諾されたときだけ入れ替える。
 */
export async function checkUpdate(quiet: boolean, deps: UpdateDeps): Promise<void> {
  if (!isTauri()) {
    if (!quiet) deps.say(t('up_preview_only'), true);
    return;
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const up = await check();
    if (!up) {
      if (!quiet) deps.say(t('up_latest', { version: await currentVersion() }));
      return;
    }
    const note = (up.body ?? '').trim();
    if (!confirm(t('up_confirm', { version: up.version, note: note.slice(0, 400) }))) {
      deps.say(t('up_later', { version: up.version }));
      return;
    }
    let total = 0;
    let got = 0;
    // 先に取り込む。取り込みが失敗しても対局とエンジンはそのまま残る
    await up.download((e) => {
      if (e.event === 'Started') {
        total = e.data.contentLength ?? 0;
        deps.say(t('up_downloading'));
      } else if (e.event === 'Progress') {
        got += e.data.chunkLength;
        deps.say(
          total ? t('up_downloading_pct', { pct: Math.round((got / total) * 100) }) : t('up_downloading_kb', { kb: Math.round(got / 1024) }),
        );
      } else if (e.event === 'Finished') {
        deps.say(t('up_downloaded'));
      }
    });
    // 入れ替えの直前にエンジンを畳む（走ったまま置き換えると孤児になる）
    await deps.beforeInstall?.();
    deps.say(t('up_installing'));
    await up.install();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (quiet) console.warn('更新の確認に失敗:', msg);
    else deps.say(t('up_failed', { msg }), true);
  }
}
