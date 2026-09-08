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
        if self.is_running(id) {
            self.stop(id, Duration::from_secs(2))?;
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
        for id in self.ids() {
            let _ = self.stop(&id, grace);
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
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
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
