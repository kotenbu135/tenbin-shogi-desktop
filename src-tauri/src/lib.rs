//! Tauri 側の入口。USI エンジンの起動・送信・停止をコマンドとして公開し、
//! エンジンからの行は `engine-event` イベントでフロントエンドへ流す。
//!
//! ルールや評価の解釈はここに置かない（`docs/plan-desktop-gui.md` 4.1）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use usi_host::{EngineEvent, EngineHost, Launch};

/// フロントエンドへ流すイベントの形。`kind` は line / stderr / exit。
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum EngineEventPayload {
    Line { id: String, line: String },
    Stderr { id: String, line: String },
    Exit { id: String, code: Option<i32> },
}

impl From<EngineEvent> for EngineEventPayload {
    fn from(ev: EngineEvent) -> Self {
        match ev {
            EngineEvent::Line { id, line } => Self::Line { id, line },
            EngineEvent::Stderr { id, line } => Self::Stderr { id, line },
            EngineEvent::Exit { id, code } => Self::Exit { id, code },
        }
    }
}

// 起動と停止は子プロセスの終了を最長 2〜3 秒待つ。主スレッドで待つと窓が固まるので別スレッドで
#[tauri::command(async)]
fn engine_start(
    app: AppHandle,
    host: State<'_, Arc<EngineHost>>,
    id: String,
    path: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<(), String> {
    let sink = {
        let app = app.clone();
        Arc::new(move |ev: EngineEvent| {
            let _ = app.emit("engine-event", EngineEventPayload::from(ev));
        })
    };
    host.start(
        &id,
        Launch {
            path: PathBuf::from(path),
            args: args.unwrap_or_default(),
            cwd: cwd.filter(|c| !c.is_empty()).map(PathBuf::from),
        },
        sink,
    )
}

#[tauri::command]
fn engine_send(host: State<'_, Arc<EngineHost>>, id: String, line: String) -> Result<(), String> {
    host.send(&id, &line)
}

#[tauri::command(async)]
fn engine_stop(host: State<'_, Arc<EngineHost>>, id: String) -> Result<(), String> {
    host.stop(&id, Duration::from_secs(3))
}

#[tauri::command]
fn engine_list(host: State<'_, Arc<EngineHost>>) -> Vec<String> {
    host.ids()
}

/// 実行ファイルとして使えそうか（存在し、ファイルである）。ダイアログで選んだ直後の検査用。
#[tauri::command]
fn path_is_file(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

#[tauri::command]
fn path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// 棋譜などのテキストを読む。UTF-8 でなければ Shift_JIS として読む（古い KIF は Shift_JIS が多い）。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("読めない: {path} ({e})"))?;
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.trim_start_matches('\u{feff}').to_string());
    }
    let (s, _, had_errors) = encoding_rs::SHIFT_JIS.decode(&bytes);
    if had_errors {
        return Err("文字コードが分からない（UTF-8 でも Shift_JIS でもない）".into());
    }
    Ok(s.into_owned())
}

/// UTF-8 で書く。
#[tauri::command]
fn write_text_file(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| format!("書けない: {path} ({e})"))
}

/// おすすめのエンジンを取り込む。
///
/// やねうら王の実行ファイル（水匠5 と同じ NNUE 型のもの）と、水匠5 の評価関数を
/// 公式の配布先から取って、エンジンのフォルダに置く。どちらも 7z で配られていて、
/// 中には 89 本の実行ファイルが入っている。どれを使えばよいか利用者に選ばせない。
const YANEURAOU_7Z: &str =
    "https://github.com/yaneurao/YaneuraOu/releases/download/V9.00/yaneuraou-V900-git-win64-all.7z";
const SUISHO5_7Z: &str =
    "https://github.com/yaneurao/YaneuraOu/releases/download/suisho5/Suisho5.7z";

/// 取ってきた書庫の SHA-256（2026-09-10 に配布元から取って測った値）。
/// 上流が同じ URL に別の中身を置き直したら、取り出しに進まずここで止める。
const YANEURAOU_7Z_SHA256: &str =
    "6517997dd05ba049a2244a828216967a0ad351d975ec52a0f358e2883197dec6";
const SUISHO5_7Z_SHA256: &str =
    "6734e3a3d28e67b9206c3442f6d10f16148138327dff811cadedfcf581f79809";

/// この CPU に合う実行ファイルの接尾辞。やねうら王は CPU ごとに別の実行ファイルを配る
fn cpu_suffix() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx512vnni") {
            return "AVX512VNNI";
        }
        if std::is_x86_feature_detected!("avx512f") {
            return "AVX512";
        }
        if std::is_x86_feature_detected!("avx2") {
            return "AVX2";
        }
        if std::is_x86_feature_detected!("sse4.2") {
            return "SSE42";
        }
        "SSE41"
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        "AVX2"
    }
}

#[derive(Clone, Serialize)]
struct InstallStep {
    text: String,
    percent: u32,
}

fn step(app: &AppHandle, text: &str, percent: u32) {
    let _ = app.emit("engine-install", InstallStep { text: text.into(), percent });
}

/// 配布元から 1 つ落とす。**待ち続けない**（つながらない・止まったら諦める）、
/// **丸ごとメモリに載せない**（流しながら書く）、**中身を照合する**（SHA-256）。
/// 上流が資産を消す・貼り替えるのはこちらでは止められないので、せめて黙って壊れないようにする。
async fn fetch_to(url: &str, to: &std::path::Path, sha256: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // 全体の制限にすると、遅い回線で 24MB を落とせなくなる。止まったことだけを見る
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("取りに行く用意ができない: {e}"))?;
    let mut res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("取りに行けない: {url} ({e})"))?
        .error_for_status()
        .map_err(|e| format!("取れない: {url} ({e})"))?;

    let mut f = std::fs::File::create(to).map_err(|e| format!("書けない: {} ({e})", to.display()))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("読めない: {url} ({e})"))?
    {
        hasher.update(&chunk);
        std::io::Write::write_all(&mut f, &chunk)
            .map_err(|e| format!("書けない: {} ({e})", to.display()))?;
    }
    drop(f);

    let got = hasher.finalize();
    let got = got.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if got != sha256 {
        let _ = std::fs::remove_file(to);
        return Err(format!(
            "配布元の中身が変わっている（{url} の SHA-256 が {got}、こちらが待っているのは {sha256}）"
        ));
    }
    Ok(())
}

/// 書庫から 1 つだけ取り出す。名前の末尾で照合する（区切りは / と \ の両方がありうる）
fn extract_one(archive: &std::path::Path, suffix: &str, to: &std::path::Path) -> Result<(), String> {
    let mut reader = sevenz_rust2::ArchiveReader::open(archive, sevenz_rust2::Password::empty())
        .map_err(|e| format!("書庫を開けない: {e}"))?;
    let mut found = false;
    // 続きを読まずに飛ばすと CRC の照合に失敗する（solid な書庫）。要らないものも読み捨てる
    reader
        .for_each_entries(|entry, rd| {
            let name = entry.name().replace('\\', "/");
            if !found && name.ends_with(suffix) {
                let mut f = std::fs::File::create(to)?;
                std::io::copy(rd, &mut f)?;
                found = true;
            } else {
                std::io::copy(rd, &mut std::io::sink())?;
            }
            Ok(true)
        })
        .map_err(|e| format!("取り出せない: {e}"))?;
    if !found {
        return Err(format!("書庫の中に {suffix} が無い"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

#[tauri::command]
async fn install_recommended_engine(app: AppHandle) -> Result<String, String> {
    let root = std::path::PathBuf::from(engines_dir(app.clone())?).join("YaneuraOu");
    std::fs::create_dir_all(root.join("eval")).map_err(|e| format!("作れない: {e}"))?;
    let tmp = std::env::temp_dir();
    let a1 = tmp.join("tenbin-yaneuraou.7z");
    let a2 = tmp.join("tenbin-suisho5.7z");
    let exe = root.join("YaneuraOu_NNUE.exe");

    step(&app, "やねうら王を取りに行っています（13MB）…", 5);
    fetch_to(YANEURAOU_7Z, &a1, YANEURAOU_7Z_SHA256).await?;
    step(&app, "やねうら王を取り出しています…", 35);
    let want = format!(
        "NNUE_halfkp_256x2_32_32/YaneuraOu_NNUE_halfkp_256x2_32_32-V900Git_{}.exe",
        cpu_suffix()
    );
    let (a1c, wantc, exec) = (a1.clone(), want.clone(), exe.clone());
    tauri::async_runtime::spawn_blocking(move || extract_one(&a1c, &wantc, &exec))
        .await
        .map_err(|e| e.to_string())??;

    step(&app, "水匠5 の評価関数を取りに行っています（24MB）…", 55);
    fetch_to(SUISHO5_7Z, &a2, SUISHO5_7Z_SHA256).await?;
    step(&app, "水匠5 を取り出しています（61MB）…", 80);
    let (a2c, nn) = (a2.clone(), root.join("eval").join("nn.bin"));
    tauri::async_runtime::spawn_blocking(move || extract_one(&a2c, "nn.bin", &nn))
        .await
        .map_err(|e| e.to_string())??;

    let _ = std::fs::remove_file(&a1);
    let _ = std::fs::remove_file(&a2);
    step(&app, "できました", 100);
    Ok(exe.to_string_lossy().into_owned())
}

/// アプリのデータフォルダ（設定とエンジンの置き場所）。案内とアンインストールの説明に使う。
#[tauri::command]
fn data_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("データフォルダが分からない: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// エンジンのフォルダ（アプリのデータフォルダの engines/）。無ければ作る。利用者はここにエンジンを置く。
#[tauri::command]
fn engines_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("データフォルダが分からない: {e}"))?
        .join("engines");
    std::fs::create_dir_all(&dir).map_err(|e| format!("作れない: {} ({e})", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct FoundExecutable {
    path: String,
    name: String,
}

fn is_executable(p: &std::path::Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        return p
            .extension()
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        // Windows の実行ファイルも WSL の interop で動くので拾う
        if p.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false) {
            return true;
        }
        let Ok(m) = std::fs::metadata(p) else { return false };
        if m.permissions().mode() & 0o111 == 0 {
            return false;
        }
        // 明らかに実行ファイルでない拡張子は外す
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        !matches!(ext.as_str(), "bin" | "txt" | "md" | "json" | "db" | "sfen" | "kif" | "png" | "jpg" | "so" | "dll" | "rar" | "zip" | "7z" | "pdf" | "html")
    }
}

/// フォルダの下 2 段までにある実行ファイルを列挙する（エンジンの一括取り込み）。
#[tauri::command]
fn scan_executables(dir: String) -> Result<Vec<FoundExecutable>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("フォルダではない: {dir}"));
    }
    let mut out = Vec::new();
    let mut stack = vec![(root, 0usize)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            if p.is_dir() {
                if depth < 2 {
                    stack.push((p, depth + 1));
                }
            } else if is_executable(&p) {
                out.push(FoundExecutable {
                    name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    path: p.to_string_lossy().into_owned(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// フォルダを OS のファイルマネージャで開く。
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// 実行環境の CPU（実行ファイルの選び分けの提案に使う）。
#[tauri::command]
fn cpu_info() -> serde_json::Value {
    let mut v = serde_json::json!({ "arch": std::env::consts::ARCH, "os": std::env::consts::OS, "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) });
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        v["avx2"] = serde_json::Value::Bool(std::is_x86_feature_detected!("avx2"));
        v["avx512"] = serde_json::Value::Bool(std::is_x86_feature_detected!("avx512f"));
        v["bmi2"] = serde_json::Value::Bool(std::is_x86_feature_detected!("bmi2"));
    }
    v
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let host = Arc::new(EngineHost::new());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 自動更新はデスクトップだけ。確認と適用は画面（src/ui/update.ts）から呼ぶ
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let _ = app;
            Ok(())
        })
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_send,
            engine_stop,
            engine_list,
            path_is_file,
            path_is_dir,
            read_text_file,
            write_text_file,
            engines_dir,
            data_dir,
            install_recommended_engine,
            scan_executables,
            open_path,
            cpu_info,
        ])
        .on_window_event(move |window, event| {
            // 窓を閉じたらエンジンを残さない。残すとやねうら王が Threads ぶんの CPU を握り続ける。
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(h) = window.app_handle().try_state::<Arc<EngineHost>>() {
                    h.stop_all(Duration::from_secs(2));
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri の起動に失敗");
}
