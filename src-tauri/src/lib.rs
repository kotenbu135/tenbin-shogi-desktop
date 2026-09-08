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

#[tauri::command]
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

#[tauri::command]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let host = Arc::new(EngineHost::new());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_send,
            engine_stop,
            engine_list,
            path_is_file,
            path_is_dir,
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
