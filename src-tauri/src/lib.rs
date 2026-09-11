//! Tauri 側の入口。USI エンジンの起動・送信・停止をコマンドとして公開し、
//! エンジンからの行は `engine-event` イベントでフロントエンドへ流す。
//!
//! ルールや評価の解釈はここに置かない（`docs/plan-desktop-gui.md` 4.1）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

/// 模型（ONNX と価値表）をバイト列で読む。差し替え口（設定の「布石の模型」）で使う。
///
/// 返しを `Vec<u8>` にしないのは、IPC が JSON の数値配列に直してしまい、2MB の ONNX が
/// 数十 MB の文字列になって読み込みが数秒かかるため。`Response` なら生のまま
/// ArrayBuffer で届く（同梱の模型は URL のまま `fetch` で読むのでこの道を通らない）。
#[tauri::command]
fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("読めない: {path} ({e})"))?;
    Ok(tauri::ipc::Response::new(bytes))
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

/// GPU で読むエンジン。dlshogi with GCT（第31回世界コンピュータ将棋選手権版）の書庫には
/// 実行ファイル・DLL・モデルが**まとめて**入っていて、暗号化もされていない。
///
/// 新しい dlshogi（2022 年版）を選ばないのは、モデルの書庫にパスワードが掛かっており、
/// 配布元が「このパスワードは他に転記しないでください」と書いているため。公開の情報源に
/// 書けないものは自動で入れられない。手で入れる道は README に案内する。
const DLSHOGI_GCT_ZIP: &str = "https://github.com/TadaoYamaoka/DeepLearningShogi/releases/download/wcwc31/dlshogi_with_gct_wcsc31.zip";
const DLSHOGI_GCT_ZIP_SHA256: &str =
    "b0ff64355b8358355881a66a7d1cfbe3f405de4dc88446e7e0e1d6b6fdbedd50";
/// 登録する実行ファイル。書庫には TensorRT 版も入っているが、あちらは CUDA 11.1・cuDNN・
/// TensorRT 7.2.3.4 を別に入れないと動かない（NVIDIA の登録が要り、数 GB ある）。
/// ONNX Runtime 版は同梱の DirectML.dll で動き、DirectX 12 の GPU なら NVIDIA でなくてもよい。
const DLSHOGI_EXE: &str = "dlshogi_onnxruntime.exe";
/// 既定のモデル（配布元の案内どおり 225kai。226kai も同じ書庫に入っている）
const DLSHOGI_MODEL: &str = "model-0000225kai.onnx";

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

/// 「やねうら王を取りに行っています（3/13MB）…」の一行を作る。
fn progress_text(label: &str, done: u64, total: Option<u64>) -> String {
    const MB: u64 = 1024 * 1024;
    match total {
        Some(t) if t > 0 => format!("{label}（{}/{}MB）…", done / MB, t / MB),
        _ => format!("{label}（{}MB）…", done / MB),
    }
}

/// 配布元から 1 つ落とす。**待ち続けない**（つながらない・止まったら諦める）、
/// **丸ごとメモリに載せない**（流しながら書く）、**中身を照合する**（SHA-256）、
/// **黙らない**（何 MB 取れたかを出す。GPU のエンジンは 67MB あり、遅い回線では何分もかかる）。
/// 上流が資産を消す・貼り替えるのはこちらでは止められないので、せめて黙って壊れないようにする。
///
/// `span` はこの取得が全体の何 % から何 % に当たるか。進み具合はその範囲に割り付ける。
async fn fetch_to(
    app: &AppHandle,
    url: &str,
    to: &std::path::Path,
    sha256: &str,
    label: &str,
    span: (u32, u32),
) -> Result<(), String> {
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

    let total = res.content_length();
    let mut f = std::fs::File::create(to).map_err(|e| format!("書けない: {} ({e})", to.display()))?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut last = Instant::now();
    step(app, &progress_text(label, 0, total), span.0);
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("読めない: {url} ({e})"))?
    {
        hasher.update(&chunk);
        std::io::Write::write_all(&mut f, &chunk)
            .map_err(|e| format!("書けない: {} ({e})", to.display()))?;
        done += chunk.len() as u64;
        // 進み具合は 0.3 秒に 1 回でよい。行ごとに出すとイベントで画面が埋まる
        if last.elapsed() >= Duration::from_millis(300) {
            last = Instant::now();
            let pct = match total {
                Some(t) if t > 0 => span.0 + ((span.1 - span.0) as u64 * done / t) as u32,
                _ => span.0,
            };
            step(app, &progress_text(label, done, total), pct);
        }
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

    fetch_to(&app, YANEURAOU_7Z, &a1, YANEURAOU_7Z_SHA256, "やねうら王を取りに行っています", (5, 35)).await?;
    step(&app, "やねうら王を取り出しています…", 35);
    let want = format!(
        "NNUE_halfkp_256x2_32_32/YaneuraOu_NNUE_halfkp_256x2_32_32-V900Git_{}.exe",
        cpu_suffix()
    );
    let (a1c, wantc, exec) = (a1.clone(), want.clone(), exe.clone());
    tauri::async_runtime::spawn_blocking(move || extract_one(&a1c, &wantc, &exec))
        .await
        .map_err(|e| e.to_string())??;

    fetch_to(&app, SUISHO5_7Z, &a2, SUISHO5_7Z_SHA256, "水匠5 の評価関数を取りに行っています", (55, 80)).await?;
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

/// 上書きできるようになるまで少しだけ粘ってファイルを作る。
///
/// Windows は走っている実行ファイルと読み込み中の DLL を上書きさせない。エンジンを止めた
/// 直後でも、掴みが離れるまでほんの少しかかる（`DirectML.dll` は 13MB あり、読み込んだ側が
/// 手放すのを待つ）。ここで諦めると、67MB 取ってきたあとに「アクセスが拒否されました」で終わる。
fn create_with_retry(path: &std::path::Path) -> Result<std::fs::File, String> {
    let mut last = String::new();
    for _ in 0..15 {
        match std::fs::File::create(path) {
            Ok(f) => return Ok(f),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    Err(format!(
        "書けない: {} ({last})。エンジンが動いていると上書きできません。\
         対局と検討を止めてから、もう一度押してください（途中まで入れ替わっているので、入れ直しが要ります）",
        path.display()
    ))
}

/// 書庫の中身をフォルダへ全部出す。dlshogi の書庫は実行ファイル・DLL・モデルが揃って 1 つで、
/// どれか 1 つを欠くと動かない（DLL は実行ファイルの隣に無いと読まれない）。
///
/// 書庫の中の名前は信用しない。`..` や絶対パスで、フォルダの外へ書かせない。
fn extract_zip_all(archive: &std::path::Path, to_dir: &std::path::Path) -> Result<Vec<String>, String> {
    let f = std::fs::File::open(archive).map_err(|e| format!("書庫を開けない: {e}"))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("書庫を読めない: {e}"))?;
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("取り出せない: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        // enclosed_name は `..` や絶対パスを弾く（None になる）
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("書庫の中の名前が怪しい: {}", entry.name()));
        };
        let out = to_dir.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("作れない: {} ({e})", parent.display()))?;
        }
        let mut w = create_with_retry(&out)?;
        std::io::copy(&mut entry, &mut w).map_err(|e| format!("取り出せない: {} ({e})", out.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if out.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false) {
                let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o755));
            }
        }
        names.push(rel.to_string_lossy().into_owned());
    }
    Ok(names)
}

/// 取り込んだエンジン。画面はここから登録を作る（名前や目盛りの決めごとは画面側に置く）。
#[derive(Serialize)]
struct InstalledEngine {
    exe: String,
    model: String,
}

/// GPU で読むエンジンを取り込む。
///
/// dlshogi with GCT の書庫 1 つに、実行ファイル・onnxruntime.dll・DirectML.dll・モデルが
/// 揃って入っている。CUDA も TensorRT も要らない（DirectX 12 の GPU があれば動く）。
#[tauri::command]
async fn install_gpu_engine(app: AppHandle) -> Result<InstalledEngine, String> {
    let root = std::path::PathBuf::from(engines_dir(app.clone())?).join("dlshogi-gct");
    std::fs::create_dir_all(&root).map_err(|e| format!("作れない: {} ({e})", root.display()))?;
    let zip_path = std::env::temp_dir().join("tenbin-dlshogi-gct.zip");

    fetch_to(
        &app,
        DLSHOGI_GCT_ZIP,
        &zip_path,
        DLSHOGI_GCT_ZIP_SHA256,
        "dlshogi with GCT を取りに行っています",
        (2, 80),
    )
    .await?;

    step(&app, "取り出しています（モデルを含めて 81MB）…", 82);
    let (z, r) = (zip_path.clone(), root.clone());
    let names = tauri::async_runtime::spawn_blocking(move || extract_zip_all(&z, &r))
        .await
        .map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&zip_path);

    for want in [DLSHOGI_EXE, DLSHOGI_MODEL] {
        if !names.iter().any(|n| n == want) {
            return Err(format!("書庫の中に {want} が無い（配布元の中身が変わった）"));
        }
    }
    step(&app, "できました", 100);
    Ok(InstalledEngine {
        exe: root.join(DLSHOGI_EXE).to_string_lossy().into_owned(),
        model: root.join(DLSHOGI_MODEL).to_string_lossy().into_owned(),
    })
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
            read_binary_file,
            write_text_file,
            engines_dir,
            data_dir,
            install_recommended_engine,
            install_gpu_engine,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn write_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(body).unwrap();
        }
        w.finish().unwrap();
    }

    /// dlshogi の書庫は実行ファイル・DLL・モデルが揃って 1 つ。全部出せること。
    #[test]
    fn zip_is_extracted_whole() {
        let dir = std::env::temp_dir().join(format!("tenbin-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("a.zip");
        write_zip(
            &archive,
            &[("dlshogi_onnxruntime.exe", b"exe"), ("onnxruntime.dll", b"dll"), ("sub/model.onnx", b"model")],
        );
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let mut names = extract_zip_all(&archive, &out).unwrap();
        names.sort();
        assert_eq!(names.len(), 3, "{names:?}");
        assert_eq!(std::fs::read(out.join("dlshogi_onnxruntime.exe")).unwrap(), b"exe");
        assert_eq!(std::fs::read(out.join("sub").join("model.onnx")).unwrap(), b"model");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 書庫の中の名前でフォルダの外へ書かせない（配布元が貼り替えられたときの用心）。
    #[test]
    fn zip_cannot_escape_the_folder() {
        let dir = std::env::temp_dir().join(format!("tenbin-zip-esc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("evil.zip");
        write_zip(&archive, &[("../escaped.txt", b"x")]);
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        assert!(extract_zip_all(&archive, &out).is_err());
        assert!(!dir.join("escaped.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 実物の書庫で試す。`TENBIN_TEST_ZIP` に dlshogi の zip を渡し、`--ignored` で走らせる。
    /// 配布物を CI に落とさせないので、ふだんは走らない。
    #[test]
    #[ignore]
    fn real_archive_is_extracted() {
        let Ok(zip_path) = std::env::var("TENBIN_TEST_ZIP") else { return };
        let out = std::env::temp_dir().join("tenbin-real-zip");
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        let names = extract_zip_all(std::path::Path::new(&zip_path), &out).unwrap();
        for want in [DLSHOGI_EXE, DLSHOGI_MODEL] {
            assert!(names.iter().any(|n| n == want), "{want} が無い: {names:?}");
            assert!(out.join(want).is_file());
        }
        // モデルは 29MB。中身まで書けていること（名前だけ作って中が空、を見逃さない）
        assert!(std::fs::metadata(out.join(DLSHOGI_MODEL)).unwrap().len() > 20 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn progress_text_says_how_far() {
        let mb = 1024 * 1024;
        assert_eq!(progress_text("取りに行っています", 3 * mb, Some(67 * mb)), "取りに行っています（3/67MB）…");
        assert_eq!(progress_text("取りに行っています", 3 * mb, None), "取りに行っています（3MB）…");
    }
}
