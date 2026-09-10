# 配る手順

## 版を上げて出す

1. `version` を上げる。5 か所ある: `package.json` / `package-lock.json`（根と自分自身の 2 行）/
   `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `Cargo.lock`（`tenbin-shogi-gui` の行）
2. `git tag v0.4.0 && git push origin v0.4.0`
3. `.github/workflows/release.yml` が windows-latest で NSIS の配布物と `latest.json` を作り、
   Releases に**下書き**で置く
4. 中身を確かめて **Publish**

**「Pre-release」にしてはいけない。** GitHub の `releases/latest` は下書きと pre-release を外すので、
`releases/latest/download/latest.json` が 404 になり、アプリの「更新を確認」が
`Could not fetch a valid release JSON from the remote` で落ちる。
画面から publish すると印を取り違えるので（v0.3.0 で踏んだ）、次の 1 行で出す:

```bash
gh release edit v0.4.0 --draft=false --prerelease=false --latest --notes-file <変更点>.md
# 200 なら利用者に更新が届く
curl -sIL -o /dev/null -w '%{http_code}\n' https://github.com/kotenbu135/tenbin-shogi-desktop/releases/latest/download/latest.json
```

## 署名の鍵

`npx tauri signer generate -w <保管場所>/tenbin-updater.key` で作る。

- 公開鍵 → `src-tauri/tauri.conf.json` の `plugins.updater.pubkey`
- 秘密鍵 → リポジトリの Secrets（`TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）

**秘密鍵をリポジトリに入れてはいけない。無くすと更新を配れなくなる。**

## 踏んだ罠

- MSI（WiX）は productName が日本語だと `light.exe` が落ちる → `--bundles nsis` だけ作る
- **`productName` を変えると別のアプリになる。** NSIS はこれ 1 つから
  入れ先（`$LOCALAPPDATA\${PRODUCTNAME}`）・アンインストールの登録
  （`…\Uninstall\${PRODUCTNAME}`）・ショートカット（`${PRODUCTNAME}.lnk`）を全部作るので、
  変えた版は前の版を**上書きせず隣に入る**。古いショートカットは古い exe を指したままなので、
  利用者は古い版を起動し続け、「新しい版があります」が毎回出る（0.4.0 で踏んだ）。
  変えるなら、前の名前をアンインストールしてもらう案内を Release の本文と README に必ず添える。
  実行ファイル名は `mainBinaryName` で固定してある（Cargo の `name` に付いていかないように）
- GitHub は資産名から日本語を落とす（`天秤将棋GUI_…` → `GUI_…`。ワークフローが消す）。tauri-action の `includeUpdaterJson`
  では署名を見つけられないので、`latest.json` はワークフローの中で自分で組み立てる
- ビルドの成果物はワークスペースの根の `target/`（`src-tauri/target` ではない）
- `set -o pipefail` の下で `ls A B` は片方が無いと落ちる → `find` で探す

## 動作の確かめ方

```bash
npm run build && npm run preview          # http://localhost:4173
node scripts/smoke-preview.mjs /tmp       # 両玉→布石→本将棋→待った
node scripts/smoke-builtin.mjs /tmp       # 内蔵の布石評価・複数枠の検討・内蔵同士の自動対局
node scripts/smoke-review.mjs /tmp        # 割りつけ・対局の枠・2 種のグラフ・終局後の検討・棋譜解析
node scripts/smoke-en.mjs                # 英語表示（日本語の残りが無いか・KIF は日本語のまま・切り替え）
WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9222 npm run tauri dev   # 別の端末で
node scripts/drive-app.mjs /tmp           # 動いているアプリを操作する（Linux/WebKitGTK 向け）
node scripts/drive-engines.mjs /tmp <エンジン>
```

## WSL / Ubuntu で開発する

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev fonts-noto-cjk
```

`fonts-noto-cjk` が無いと符号や駒台の文字が代替フォントで崩れる。
エンジンは `wsl.exe` 経由でも起動できる（実行ファイルに `C:\Windows\System32\wsl.exe`、
引数に `-d Ubuntu-24.04 -- /home/you/engine/usi`）。
