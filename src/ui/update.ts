// 自動更新。GitHub の Releases に置いた latest.json を見て、新しい版があれば
// 取り込んで入れ替え、再起動する（Tauri の updater プラグイン）。
//
// 署名した配布物だけを受け取る（公開鍵は tauri.conf.json、秘密鍵は配布する側が持つ）。
// ブラウザのプレビューでは何もしない。

import { isTauri } from '../usi/engine.ts';

export interface UpdateDeps {
  say(text: string, error?: boolean): void;
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
    if (!quiet) deps.say('ブラウザのプレビューでは更新を確認できません', true);
    return;
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const up = await check();
    if (!up) {
      if (!quiet) deps.say(`いまの版（${await currentVersion()}）が最新です`);
      return;
    }
    const note = (up.body ?? '').trim();
    if (!confirm(`新しい版 ${up.version} があります。取り込んで再起動しますか\n\n${note.slice(0, 400)}`)) {
      deps.say(`新しい版 ${up.version} があります。「はじめに」→「更新を確認」でいつでも入れられます`);
      return;
    }
    let total = 0;
    let got = 0;
    await up.downloadAndInstall((e) => {
      if (e.event === 'Started') {
        total = e.data.contentLength ?? 0;
        deps.say('更新を取り込んでいます…');
      } else if (e.event === 'Progress') {
        got += e.data.chunkLength;
        deps.say(total ? `更新を取り込んでいます… ${Math.round((got / total) * 100)}%` : `更新を取り込んでいます… ${Math.round(got / 1024)} KB`);
      } else if (e.event === 'Finished') {
        deps.say('取り込みました。再起動します');
      }
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (quiet) console.warn('更新の確認に失敗:', msg);
    else deps.say(`更新を確認できません: ${msg}`, true);
  }
}
