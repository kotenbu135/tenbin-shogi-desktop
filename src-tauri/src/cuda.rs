//! CUDA 版の ONNX Runtime への切り替えを、なるべくボタンで済ませる（Issue #2 の続き、2026-09-14 決定）。
//!
//! Libra の配布物は DirectML 版の ONNX Runtime を同梱する。NVIDIA の GPU なら CUDA 版の DLL に差し替えると
//! 約 4 倍速いが、手で行う手順（DLL の差し替え・CUDA 12 と cuDNN 9 の導入・`PATH`）は素人には難しい。
//! 実際、手順どおりに入れても cuDNN 9 のインストーラは `PATH` に足さないので、CPU に落ちた。そこで
//! - ONNX Runtime（MIT）の CUDA 版はアプリが取ってきて差し替える。元の DLL は `.dml-prev` に残して戻せるようにする
//! - CUDA 12 と cuDNN 9 は NVIDIA のインストーラをアプリが「ダウンロード」フォルダに取ってくる。
//!   **インストールは利用者が行う**（NVIDIA のライブラリは同梱しない。取るのは配布元の URL から）
//! - 標準のインストール先はアプリが探し、エンジンの `PATH` の末尾に足す。利用者に環境変数を触らせない

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// 取ってくるもの。SHA-256 は 2026-09-14 に配布元から取って測った値
pub struct Download {
    pub url: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

/// ONNX Runtime 1.30.0 の CUDA 12 版（Libra の README が指す版）
pub const ORT_CUDA_ZIP: Download = Download {
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-win-x64-gpu_cuda12-1.30.0.zip",
    file: "tenbin-onnxruntime-cuda12.zip",
    sha256: "d4667ea48eb0a10bc9b96b838f7b8975a6bf18de3bc5edd403a22e15c1458b23",
    size: 379_723_801,
};
const ORT_ZIP_ROOT: &str = "onnxruntime-win-x64-gpu_cuda12-1.30.0/";

/// CUDA 12 の最後の版のネットワークインストーラ（選んだ部品だけをインストール中に取る）。
/// md5 は NVIDIA の `docs/sidebar/md5sum.txt` の値と一致した
pub const CUDA_INSTALLER: Download = Download {
    url: "https://developer.download.nvidia.com/compute/cuda/12.9.1/network_installers/cuda_12.9.1_windows_network.exe",
    file: "cuda_12.9.1_windows_network.exe",
    sha256: "de45c336ab4e9825018b546357dc9de5ded9f89c4f5200ef52b8eeac3b1b4072",
    size: 16_498_848,
};

/// cuDNN 9.26.0（RTX 5070 Ti・CUDA 12.9 で Libra が CUDA で読むのを確かめた版）。CUDA 12 用と 13 用を並べて入れる
pub const CUDNN_INSTALLER: Download = Download {
    url: "https://developer.download.nvidia.com/compute/cudnn/9.26.0/local_installers/cudnn_9.26.0_windows_x86_64.exe",
    file: "cudnn_9.26.0_windows_x86_64.exe",
    sha256: "ce6939429e1787bcc343170ac0d1aa7262ecc123cb30ca2e11a113a6317f2fab",
    size: 2_002_509_720,
};

/// エンジンのフォルダに置く CUDA 版の DLL（書庫の `lib/` から）
const ORT_DLLS: [&str; 3] = ["onnxruntime.dll", "onnxruntime_providers_cuda.dll", "onnxruntime_providers_shared.dll"];
/// 差し替える前に控えを取る DLL（DirectML 版にもあるもの）
const BACKED_UP: [&str; 2] = ["onnxruntime.dll", "onnxruntime_providers_shared.dll"];
const BACKUP_SUFFIX: &str = ".dml-prev";
const CUDA_PROVIDER_DLL: &str = "onnxruntime_providers_cuda.dll";
/// ONNX Runtime の許諾（MIT）と第三者の告知。DLL と一緒に置く
const LICENSES: [(&str, &str); 2] = [
    ("LICENSE", "onnxruntime-cuda.LICENSE.txt"),
    ("ThirdPartyNotices.txt", "onnxruntime-cuda.ThirdPartyNotices.txt"),
];

/// CUDA 12 が入っているかの目印（ONNX Runtime の CUDA 版が最初に探して無いと落ちる DLL）
pub const CUDA12_PROBE: &str = "cublasLt64_12.dll";
pub const CUDNN9_PROBE: &str = "cudnn64_9.dll";

/// `v12.9` → [12, 9]。`prefix` の後ろを `.` 区切りの数として読む
fn version_of(name: &str, prefix: &str) -> Option<Vec<u32>> {
    name.strip_prefix(prefix)?.split('.').map(|p| p.parse().ok()).collect()
}

/// `dir` の子フォルダのうち、名前が `prefix` ＋版で、版の頭が `major` のもの。新しい順
fn versioned(dir: &Path, prefix: &str, major: u32) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(Vec<u32>, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let ver = version_of(&e.file_name().to_string_lossy(), prefix)?;
            (ver.first() == Some(&major) && e.path().is_dir()).then(|| (ver, e.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// CUDA 12 の DLL のフォルダ（`<Program Files>\NVIDIA GPU Computing Toolkit\CUDA\v12.x\bin`）。新しい版を選ぶ
pub fn find_cuda12_bin(program_files: &Path) -> Option<PathBuf> {
    versioned(&program_files.join("NVIDIA GPU Computing Toolkit").join("CUDA"), "v", 12)
        .into_iter()
        .map(|v| v.join("bin"))
        .find(|b| b.join(CUDA12_PROBE).is_file())
}

/// cuDNN 9 の CUDA 12 用の DLL のフォルダ（`<Program Files>\NVIDIA\CUDNN\v9.x\bin\12.x\x64`）。
/// インストーラは CUDA 12 用と 13 用を並べて入れ、どちらも `PATH` に足さない。13 用は CUDA 12 版の ONNX Runtime から読めない
pub fn find_cudnn9_bin(program_files: &Path) -> Option<PathBuf> {
    for v in versioned(&program_files.join("NVIDIA").join("CUDNN"), "v", 9) {
        for c in versioned(&v.join("bin"), "", 12) {
            // 版によって x64 の段が無いこともあるので両方見る
            for d in [c.join("x64"), c.clone()] {
                if d.join(CUDNN9_PROBE).is_file() {
                    return Some(d);
                }
            }
        }
    }
    None
}

fn program_files() -> PathBuf {
    std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
}

/// エンジンの `PATH` の末尾に足すフォルダ（標準の場所で見つかったものだけ）。
/// インストールしたあとアプリを開き直さなくても、次に立ち上げるエンジンから効く
pub fn library_dirs() -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let pf = program_files();
    find_cuda12_bin(&pf).into_iter().chain(find_cudnn9_bin(&pf)).collect()
}

/// DLL がどこで読めるか。標準の場所 → エンジンのフォルダ → アプリの `PATH` の順
fn locate(probe: &str, standard: Option<PathBuf>, exe_dir: &Path) -> Option<PathBuf> {
    standard
        .or_else(|| exe_dir.join(probe).is_file().then(|| exe_dir.to_path_buf()))
        .or_else(|| std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).find(|d| d.join(probe).is_file())))
}

/// 案内の画面に出す、揃っているものの一覧
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// CUDA 12 の DLL のフォルダ（無ければ None）
    pub cuda12: Option<String>,
    pub cudnn9: Option<String>,
    /// エンジンのフォルダの ONNX Runtime が CUDA 版か
    pub ort_cuda: bool,
    /// DirectML 版の控えがあり、戻せるか
    pub can_restore: bool,
}

pub fn status(exe: &Path) -> Status {
    let dir = exe.parent().unwrap_or(Path::new("."));
    let s = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    let (cuda, cudnn) = if cfg!(windows) {
        let pf = program_files();
        (find_cuda12_bin(&pf), find_cudnn9_bin(&pf))
    } else {
        (None, None)
    };
    Status {
        cuda12: s(locate(CUDA12_PROBE, cuda, dir)),
        cudnn9: s(locate(CUDNN9_PROBE, cudnn, dir)),
        ort_cuda: dir.join(CUDA_PROVIDER_DLL).is_file(),
        can_restore: BACKED_UP.iter().all(|n| dir.join(format!("{n}{BACKUP_SUFFIX}")).is_file()),
    }
}

/// Windows は読み込み中の DLL を置き換えさせない。エンジンを止めた直後は掴みが離れるまで少し粘る
fn with_retry(what: &Path, mut f: impl FnMut() -> std::io::Result<()>) -> Result<(), String> {
    let mut last = String::new();
    for _ in 0..15 {
        match f() {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    Err(format!(
        "置き換えられない: {} ({last})。エンジンが動いていると置き換えられません。対局と検討を止めてから、もう一度押してください",
        what.display()
    ))
}

fn extract(zip: &mut zip::ZipArchive<std::fs::File>, entry: &str, to: &Path) -> Result<(), String> {
    let mut e = zip
        .by_name(entry)
        .map_err(|_| format!("書庫の中に {entry} が無い（配布元の中身が変わった）"))?;
    let mut f = std::fs::File::create(to).map_err(|e| format!("書けない: {} ({e})", to.display()))?;
    std::io::copy(&mut e, &mut f).map_err(|e| format!("取り出せない: {} ({e})", to.display()))?;
    Ok(())
}

/// 照合済みの書庫から CUDA 版の DLL を取り出し、`dir`（エンジンのフォルダ）の DLL と差し替える。
///
/// 控え（`.dml-prev`）は、まだ CUDA 版になっていないときに 1 度だけ取る（2 度押しても DirectML 版の控えを
/// CUDA 版で上書きしない）。取り出しはまず `.part` に出し、3 つ揃ってから名前を替える（途中で失敗しても
/// エンジンのフォルダが半端な組み合わせにならない）。
pub fn swap_in(zip_path: &Path, dir: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| format!("書庫を開けない: {e}"))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("書庫を読めない: {e}"))?;
    let part = |n: &str| dir.join(format!("{n}.part"));
    let result = (|| {
        for n in ORT_DLLS {
            extract(&mut zip, &format!("{ORT_ZIP_ROOT}lib/{n}"), &part(n))?;
        }
        for (src, dst) in LICENSES {
            extract(&mut zip, &format!("{ORT_ZIP_ROOT}{src}"), &dir.join(dst))?;
        }
        if !dir.join(CUDA_PROVIDER_DLL).is_file() {
            for n in BACKED_UP {
                let (cur, bak) = (dir.join(n), dir.join(format!("{n}{BACKUP_SUFFIX}")));
                if cur.is_file() && !bak.exists() {
                    std::fs::copy(&cur, &bak).map_err(|e| format!("控えを取れない: {} ({e})", bak.display()))?;
                }
            }
        }
        for n in ORT_DLLS {
            let to = dir.join(n);
            with_retry(&to, || std::fs::rename(part(n), &to))?;
        }
        Ok(())
    })();
    for n in ORT_DLLS {
        let _ = std::fs::remove_file(part(n));
    }
    result
}

/// DirectML 版に戻す（控えを元の名前に戻し、CUDA 版にしか無い DLL を消す）
pub fn swap_out(dir: &Path) -> Result<(), String> {
    for n in BACKED_UP {
        let bak = dir.join(format!("{n}{BACKUP_SUFFIX}"));
        if !bak.is_file() {
            return Err(format!("DirectML 版の控え（{}）が無いので戻せない", bak.display()));
        }
    }
    for n in BACKED_UP {
        let (cur, bak) = (dir.join(n), dir.join(format!("{n}{BACKUP_SUFFIX}")));
        with_retry(&cur, || std::fs::rename(&bak, &cur))?;
    }
    let cuda = dir.join(CUDA_PROVIDER_DLL);
    if cuda.exists() {
        with_retry(&cuda, || std::fs::remove_file(&cuda))?;
    }
    Ok(())
}

/// 取ってあるファイルが目当てのものか（大きさを見てから中身を照合する。2GB を取り直させない）
pub fn already_fetched(path: &Path, d: &Download) -> bool {
    use sha2::{Digest, Sha256};
    if std::fs::metadata(path).map(|m| m.len()).ok() != Some(d.size) {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => h.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>() == d.sha256
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tenbin-cuda-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path, body: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// この PC（2026-09-14）と同じ並び。CUDA は 12 の新しいほう、cuDNN は 13.x ではなく 12.x を選ぶ
    #[test]
    fn finds_cuda12_and_cudnn9_for_cuda12() {
        let pf = temp("find");
        let cuda = pf.join("NVIDIA GPU Computing Toolkit").join("CUDA");
        touch(&cuda.join("v12.4").join("bin").join(CUDA12_PROBE), b"");
        touch(&cuda.join("v12.9").join("bin").join(CUDA12_PROBE), b"");
        touch(&cuda.join("v13.0").join("bin").join("cublasLt64_13.dll"), b"");
        std::fs::create_dir_all(cuda.join("v12.10-broken")).unwrap();
        let cudnn = pf.join("NVIDIA").join("CUDNN").join("v9.26").join("bin");
        touch(&cudnn.join("12.9").join("x64").join(CUDNN9_PROBE), b"");
        touch(&cudnn.join("13.4").join("x64").join(CUDNN9_PROBE), b"");
        assert_eq!(find_cuda12_bin(&pf), Some(cuda.join("v12.9").join("bin")));
        assert_eq!(find_cudnn9_bin(&pf), Some(cudnn.join("12.9").join("x64")));
        let _ = std::fs::remove_dir_all(&pf);
    }

    #[test]
    fn nothing_installed_is_none() {
        let pf = temp("none");
        // cuDNN が 13 用だけでは CUDA 12 版の ONNX Runtime から読めない
        touch(&pf.join("NVIDIA").join("CUDNN").join("v9.26").join("bin").join("13.4").join("x64").join(CUDNN9_PROBE), b"");
        assert_eq!(find_cuda12_bin(&pf), None);
        assert_eq!(find_cudnn9_bin(&pf), None);
        let _ = std::fs::remove_dir_all(&pf);
    }

    #[test]
    fn version_is_numeric_not_lexical() {
        assert!(version_of("v12.10", "v").unwrap() > version_of("v12.9", "v").unwrap());
        assert_eq!(version_of("x64", ""), None);
    }

    fn fake_ort_zip(path: &Path) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        for n in ORT_DLLS {
            w.start_file(format!("{ORT_ZIP_ROOT}lib/{n}"), opts).unwrap();
            w.write_all(format!("cuda {n}").as_bytes()).unwrap();
        }
        for (src, _) in LICENSES {
            w.start_file(format!("{ORT_ZIP_ROOT}{src}"), opts).unwrap();
            w.write_all(b"license").unwrap();
        }
        w.finish().unwrap();
    }

    /// 差し替えて、2 度押しても控えは DirectML 版のまま、戻せば元どおり
    #[test]
    fn swap_in_twice_then_out_restores_directml() {
        let dir = temp("swap");
        let zip = dir.join("ort.zip");
        fake_ort_zip(&zip);
        let eng = dir.join("engine");
        touch(&eng.join("onnxruntime.dll"), b"dml ort");
        touch(&eng.join("onnxruntime_providers_shared.dll"), b"dml shared");
        touch(&eng.join("DirectML.dll"), b"directml");

        let st = status(&eng.join("libra.exe"));
        assert!(!st.ort_cuda && !st.can_restore);
        swap_in(&zip, &eng).unwrap();
        swap_in(&zip, &eng).unwrap();
        assert_eq!(std::fs::read(eng.join("onnxruntime.dll")).unwrap(), b"cuda onnxruntime.dll");
        assert_eq!(std::fs::read(eng.join("onnxruntime.dll.dml-prev")).unwrap(), b"dml ort");
        assert!(eng.join("onnxruntime-cuda.LICENSE.txt").is_file());
        assert!(!eng.join("onnxruntime.dll.part").exists());
        let st = status(&eng.join("libra.exe"));
        assert!(st.ort_cuda && st.can_restore);

        swap_out(&eng).unwrap();
        assert_eq!(std::fs::read(eng.join("onnxruntime.dll")).unwrap(), b"dml ort");
        assert_eq!(std::fs::read(eng.join("onnxruntime_providers_shared.dll")).unwrap(), b"dml shared");
        assert!(!eng.join(CUDA_PROVIDER_DLL).exists());
        assert!(swap_out(&eng).is_err(), "控えが無いのに戻せてはいけない");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 書庫の中身が違えば、エンジンのフォルダには何も触らない
    #[test]
    fn broken_zip_leaves_engine_alone() {
        let dir = temp("broken");
        let zip = dir.join("bad.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&zip).unwrap());
        w.start_file("other/lib/onnxruntime.dll", zip::write::FileOptions::<'_, ()>::default()).unwrap();
        w.finish().unwrap();
        let eng = dir.join("engine");
        touch(&eng.join("onnxruntime.dll"), b"dml ort");
        assert!(swap_in(&zip, &eng).is_err());
        assert_eq!(std::fs::read(eng.join("onnxruntime.dll")).unwrap(), b"dml ort");
        assert!(!eng.join("onnxruntime.dll.dml-prev").exists());
        assert!(!eng.join("onnxruntime.dll.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本物の書庫で試す。`TENBIN_TEST_ORT_ZIP` に onnxruntime-win-x64-gpu_cuda12-1.30.0.zip を渡し、`--ignored` で走らせる
    #[test]
    #[ignore]
    fn real_ort_zip_is_swapped_in() {
        let Ok(zip) = std::env::var("TENBIN_TEST_ORT_ZIP") else { return };
        assert!(already_fetched(Path::new(&zip), &ORT_CUDA_ZIP), "書庫の SHA-256 が合わない");
        let eng = temp("real");
        swap_in(Path::new(&zip), &eng).unwrap();
        assert!(std::fs::metadata(eng.join(CUDA_PROVIDER_DLL)).unwrap().len() > 300 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(&eng);
    }
}
