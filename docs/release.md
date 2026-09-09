# 配る手順

## 版を上げて出す

1. `package.json` と `src-tauri/tauri.conf.json` の `version` を上げる
2. `git tag v0.3.0 && git push --tags`
3. `.github/workflows/release.yml` が windows-latest で NSIS の配布物と `latest.json` を作り、
   Releases に**下書き**で置く
4. 中身を確かめて **Publish**

**「Pre-release」にしてはいけない。** GitHub の `releases/latest` は下書きと pre-release を外すので、
`releases/latest/download/latest.json` が 404 になり、アプリの「更新を確認」が
`Could not fetch a valid release JSON from the remote` で落ちる。

## 署名の鍵

`npx tauri signer generate -w <保管場所>/tenbin-updater.key` で作る。

- 公開鍵 → `src-tauri/tauri.conf.json` の `plugins.updater.pubkey`
- 秘密鍵 → リポジトリの Secrets（`TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）

**秘密鍵をリポジトリに入れてはいけない。無くすと更新を配れなくなる。**

## 踏んだ罠

- MSI（WiX）は productName が日本語だと `light.exe` が落ちる → `--bundles nsis` だけ作る
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
