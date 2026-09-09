//! USIエンジンの子プロセスを束ねる。
//!
//! GUI の枠組み（Tauri）に依存しない。ここに置くのは「起動・行の送受信・停止」だけで、
//! USI の語彙の解釈（`info` の分解や `option` の登録）は行わない。解釈はフロントエンドが持ち、
//! このクレートは行をそのまま運ぶ。そうしておくと、GUI の枠組みを替えてもここは残る。
//!
//! 読み取りは専用スレッドが無条件に `read_line` する。select/poll 系で「読めるか」を先に
//! 訊く方式は、バッファ付きストリームが先読みした行を取りこぼす（開発リポジトリの
//! `fuseki_arena.py` で踏んだ）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// エンジンから GUI へ流れる出来事。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    /// 標準出力の1行（改行は除いてある）。
    Line { id: String, line: String },
    /// 標準エラーの1行。エンジンのログや落ちた理由がここに出る。
    Stderr { id: String, line: String },
    /// プロセスが終わった。`code` は終了コード（シグナルで死んだときは None）。
    Exit { id: String, code: Option<i32> },
}

pub type EventSink = Arc<dyn Fn(EngineEvent) + Send + Sync + 'static>;

struct Running {
    child: Child,
    stdin: ChildStdin,
}

/// 複数のエンジンを id で区別して持つ。
#[derive(Default)]
pub struct EngineHost {
    engines: Mutex<HashMap<String, Running>>,
    /// 起動と停止を直列にする錠。`engines` の錠は spawn の間だけ手放すので、
    /// これが無いと同じ id の start と stop が交差し、表から消えた子プロセスが走り続ける
    /// （Tauri の command を async にして、主スレッドによる直列化が消えたため）。
    ops: Mutex<()>,
}

/// 起動の指定。
#[derive(Debug, Clone)]
pub struct Launch {
    pub path: PathBuf,
    pub args: Vec<String>,
    /// 省略時は実行ファイルのあるディレクトリ。やねうら王は評価関数や定跡を
    /// カレントディレクトリからの相対で探すので、ここを外すと `isready` で止まる。
    pub cwd: Option<PathBuf>,
}

impl EngineHost {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.engines.lock().unwrap().contains_key(id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.engines.lock().unwrap().keys().cloned().collect()
    }

    /// エンジンを起動する。同じ id が動いていれば先に止める。
    pub fn start(&self, id: &str, launch: Launch, sink: EventSink) -> Result<(), String> {
        let _ops = self.ops.lock().unwrap();
        self.start_locked(id, launch, sink)
    }

    fn start_locked(&self, id: &str, launch: Launch, sink: EventSink) -> Result<(), String> {
        if self.is_running(id) {
            self.stop_locked(id, Duration::from_secs(2))?;
        }
        let cwd = match &launch.cwd {
            Some(c) => c.clone(),
            None => default_cwd(&launch.path),
        };
        let mut cmd = Command::new(&launch.path);
        cmd.args(&launch.args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // コンソール窓を出さない。
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("起動できない: {} ({})", launch.path.display(), e))?;
        let stdin = child.stdin.take().ok_or("stdin を取れない")?;
        let stdout = child.stdout.take().ok_or("stdout を取れない")?;
        let stderr = child.stderr.take().ok_or("stderr を取れない")?;

        spawn_reader(id.to_string(), stdout, sink.clone(), Stream::Stdout);
        spawn_reader(id.to_string(), stderr, sink.clone(), Stream::Stderr);

        self.engines
            .lock()
            .unwrap()
            .insert(id.to_string(), Running { child, stdin });
        Ok(())
    }

    /// 1行送る。改行は付けて送るので呼び出し側は付けない。
    pub fn send(&self, id: &str, line: &str) -> Result<(), String> {
        let mut map = self.engines.lock().unwrap();
        let r = map.get_mut(id).ok_or_else(|| format!("エンジン {id} は動いていない"))?;
        r.stdin
            .write_all(line.trim_end_matches(['\r', '\n']).as_bytes())
            .and_then(|_| r.stdin.write_all(b"\n"))
            .and_then(|_| r.stdin.flush())
            .map_err(|e| format!("送れない: {e}"))
    }

    /// `quit` を送って `grace` だけ待ち、終わらなければ殺す。
    /// 終了イベントは読み取りスレッドが stdout の EOF で出す。
    pub fn stop(&self, id: &str, grace: Duration) -> Result<(), String> {
        let _ops = self.ops.lock().unwrap();
        self.stop_locked(id, grace)
    }

    fn stop_locked(&self, id: &str, grace: Duration) -> Result<(), String> {
        let mut r = match self.engines.lock().unwrap().remove(id) {
            Some(r) => r,
            None => return Ok(()),
        };
        // quit が届かなくても（既に死んでいても）殺す側で回収するので、送信エラーは無視する。
        let _ = r.stdin.write_all(b"quit\n").and_then(|_| r.stdin.flush());
        drop(r.stdin);
        let deadline = Instant::now() + grace;
        loop {
            match r.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => {
                    let _ = r.child.kill();
                    let _ = r.child.wait();
                    return Ok(());
                }
                Err(e) => return Err(format!("終了を待てない: {e}")),
            }
        }
    }

    /// 全部止める。アプリ終了時に呼ぶ。
    pub fn stop_all(&self, grace: Duration) {
        let _ops = self.ops.lock().unwrap();
        for id in self.ids() {
            let _ = self.stop_locked(&id, grace);
        }
    }
}

fn default_cwd(path: &Path) -> PathBuf {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

fn spawn_reader<R>(id: String, reader: R, sink: EventSink, stream: Stream)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        // read_line は UTF-8 でない行で Err を返し、EOF と区別がつかない。Shift_JIS で日本語を出す
        // エンジンの 1 行で読み取りが終わり、生きているプロセスに Exit を出してしまうので、バイト列で読む
        let mut raw: Vec<u8> = Vec::new();
        loop {
            raw.clear();
            match buf.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    // UTF-8 で読めなければ Shift_JIS とみなす。日本語 Windows 向けのエンジンは
                    // `id name` や `info string` を Shift_JIS で出す（置換文字にすると読めなくなる）
                    let line = match std::str::from_utf8(&raw) {
                        Ok(s) => std::borrow::Cow::Borrowed(s),
                        Err(_) => encoding_rs::SHIFT_JIS.decode(&raw).0,
                    };
                    let l = line.trim_end_matches(['\r', '\n']).to_string();
                    sink(match stream {
                        Stream::Stdout => EngineEvent::Line { id: id.clone(), line: l },
                        Stream::Stderr => EngineEvent::Stderr { id: id.clone(), line: l },
                    });
                }
            }
        }
        // stdout の EOF をプロセス終了の合図にする。stderr 側は Exit を出さない
        // （二重に出ると GUI が二度「落ちた」と表示する）。
        if let Stream::Stdout = stream {
            sink(EngineEvent::Exit { id, code: None });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn cat_path() -> PathBuf {
        for p in ["/bin/cat", "/usr/bin/cat"] {
            if Path::new(p).exists() {
                return PathBuf::from(p);
            }
        }
        panic!("cat が無い環境ではこのテストは走らない");
    }

    /// 日本語 Windows 向けのエンジンは `id name` を Shift_JIS で出す。置換文字にせず読めること。
    #[cfg(unix)]
    #[test]
    fn shift_jis_line_is_decoded() {
        let host = EngineHost::new();
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |ev| {
            let _ = tx.send(ev);
        });
        host.start("sjis", Launch { path: cat_path(), args: vec![], cwd: None }, sink).unwrap();
        // 「やねうら王」の Shift_JIS
        let bytes: Vec<u8> = b"id name "
            .iter()
            .copied()
            .chain([0x82, 0xE2, 0x82, 0xCB, 0x82, 0xA4, 0x82, 0xE7, 0x89, 0xA4])
            .collect();
        {
            let mut map = host.engines.lock().unwrap();
            let r = map.get_mut("sjis").unwrap();
            r.stdin.write_all(&bytes).unwrap();
            r.stdin.write_all(b"\n").unwrap();
            r.stdin.flush().unwrap();
        }
        let ev = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(ev, EngineEvent::Line { id: "sjis".into(), line: "id name やねうら王".into() });
        host.stop("sjis", Duration::from_secs(2)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn echo_roundtrip_and_stop() {
        let host = EngineHost::new();
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |ev| {
            let _ = tx.send(ev);
        });
        host.start(
            "e1",
            Launch { path: cat_path(), args: vec![], cwd: None },
            sink,
        )
        .unwrap();
        assert!(host.is_running("e1"));
        host.send("e1", "usi\n").unwrap();
        host.send("e1", "position startpos").unwrap();
        let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first, EngineEvent::Line { id: "e1".into(), line: "usi".into() });
        let second = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(second, EngineEvent::Line { id: "e1".into(), line: "position startpos".into() });

        host.stop("e1", Duration::from_secs(2)).unwrap();
        assert!(!host.is_running("e1"));
        // cat は quit を知らないが、stdin が閉じれば終わる。終了イベントが届くこと。
        let mut saw_exit = false;
        while let Ok(ev) = rx.recv_timeout(Duration::from_secs(5)) {
            if matches!(ev, EngineEvent::Exit { .. }) {
                saw_exit = true;
                break;
            }
        }
        assert!(saw_exit, "Exit が来ない");
        assert!(host.send("e1", "usi").is_err());
    }

    /// 実物のエンジンで usi → usiok → isready → readyok を通す。
    /// `TENBIN_TEST_ENGINE`（実行ファイル）と任意で `TENBIN_TEST_EVALDIR` を渡し、`--ignored` で走らせる。
    #[test]
    #[ignore]
    fn real_engine_handshake() {
        let Ok(path) = std::env::var("TENBIN_TEST_ENGINE") else { return };
        let host = EngineHost::new();
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |ev| {
            let _ = tx.send(ev);
        });
        host.start("y", Launch { path: PathBuf::from(path), args: vec![], cwd: None }, sink).unwrap();
        host.send("y", "usi").unwrap();
        let wait = |pred: &dyn Fn(&str) -> bool, secs: u64| -> Vec<String> {
            let deadline = Instant::now() + Duration::from_secs(secs);
            let mut seen = Vec::new();
            while Instant::now() < deadline {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(EngineEvent::Line { line, .. }) => {
                        let hit = pred(&line);
                        seen.push(line);
                        if hit { return seen; }
                    }
                    Ok(EngineEvent::Exit { .. }) => panic!("エンジンが終了した: {seen:?}"),
                    _ => {}
                }
            }
            panic!("応答が無い: {seen:?}");
        };
        let lines = wait(&|l| l == "usiok", 15);
        assert!(lines.iter().any(|l| l.starts_with("id name")), "id name が無い");
        if let Ok(dir) = std::env::var("TENBIN_TEST_EVALDIR") {
            host.send("y", &format!("setoption name EvalDir value {dir}")).unwrap();
        }
        host.send("y", "isready").unwrap();
        wait(&|l| l == "readyok", 120);
        host.send("y", "position startpos").unwrap();
        host.send("y", "go nodes 5000").unwrap();
        let lines = wait(&|l| l.starts_with("bestmove"), 60);
        assert!(lines.iter().any(|l| l.starts_with("info") && l.contains("score")), "info score が無い");
        host.stop("y", Duration::from_secs(3)).unwrap();
    }

    #[test]
    fn missing_binary_is_an_error() {
        let host = EngineHost::new();
        let sink: EventSink = Arc::new(|_| {});
        let r = host.start(
            "x",
            Launch { path: PathBuf::from("/nonexistent/engine.exe"), args: vec![], cwd: None },
            sink,
        );
        assert!(r.is_err());
        assert!(!host.is_running("x"));
    }

    #[test]
    fn default_cwd_is_binary_dir() {
        assert_eq!(default_cwd(Path::new("/a/b/engine")), PathBuf::from("/a/b"));
        assert_eq!(default_cwd(Path::new("engine")), PathBuf::from("."));
    }
}
