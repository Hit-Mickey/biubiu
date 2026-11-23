use std::fs::File;
use std::os::fd::FromRawFd;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, State, Wry,
};

use crate::{audio_engine::NativeAudioStateSnapshot, state::AppState};

static PLUGIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
pub static BINARY_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();
static FOREGROUND: AtomicBool = AtomicBool::new(true);

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("handset")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.hitmickey.biubiu", "HandsetPlugin")?;
            let _ = PLUGIN.set(handle);
            let _ = APP.set(app.clone());
            Ok(())
        })
        .build()
}

fn handle() -> Result<&'static PluginHandle<Wry>, String> {
    PLUGIN
        .get()
        .ok_or_else(|| "Android 服务尚未就绪".to_owned())
}

pub async fn call<T: DeserializeOwned>(name: &str, args: Value) -> Result<T, String> {
    handle()?
        .run_mobile_plugin_async(name, args)
        .await
        .map_err(|e| e.to_string())
}

pub fn notify(name: &'static str, args: &impl Serialize) {
    use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
    static EVENTS: OnceLock<UnboundedSender<(&'static str, Value)>> = OnceLock::new();
    if let Ok(payload) = serde_json::to_value(args) {
        let events = EVENTS.get_or_init(|| {
            let (tx, mut rx) = unbounded_channel();
            tauri::async_runtime::spawn(async move {
                while let Some((name, payload)) = rx.recv().await {
                    if let Err(err) = call::<()>(name, payload).await {
                        eprintln!("[android] {name}: {err}");
                    }
                }
            });
            tx
        });
        let _ = events.send((name, payload));
    }
}

pub fn create_window(app: &AppHandle, state: &Arc<AppState>) -> tauri::Result<()> {
    let state_copy = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(dir) = call::<String>("binaryDir", json!({})).await {
            let _ = BINARY_DIR.set(dir.into());
            let path = state_copy.resolve_ffmpeg_path();
            state_copy.audio.set_ffmpeg_path(path.clone());
            state_copy.downloads.set_ffmpeg_path(path);
        }
    });
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .initialization_script(state.runtime_init_script("main"))
        .build()?;
    Ok(())
}

pub fn foreground() -> bool {
    FOREGROUND.load(Ordering::Acquire)
}

// Android MediaSession sends controls to the same engine and queue as the play bar.
#[no_mangle]
extern "system" fn Java_com_hitmickey_biubiu_PhoneControls_command(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    action: i32,
    value: i64,
) {
    if action == 0 {
        FOREGROUND.store(value != 0, Ordering::Release);
        return;
    }
    let Some(state) = APP.get().and_then(|app| app.try_state::<Arc<AppState>>()) else {
        return;
    };
    let audio = &state.audio;
    match action {
        1 if !audio.get_state().is_playing => audio.dispatch_control("toggle"),
        2 => audio.pause(),
        3 => audio.dispatch_control("next"),
        4 => audio.dispatch_control("prev"),
        5 => audio.seek(value.max(0) as f64 / 1000.0),
        _ => {}
    }
}

pub fn sync_media(s: &NativeAudioStateSnapshot) {
    notify(
        "syncMedia",
        &json!({"playing":s.is_playing, "title":s.title, "artist":s.artist,
        "duration":s.duration, "position":s.current_time, "rate":s.rate, "hasTrack":!s.src.is_empty()}),
    );
}

pub fn secret(operation: &str, value: &str) -> Result<String, String> {
    handle()?
        .run_mobile_plugin("credential", json!({"operation":operation,"value":value}))
        .map_err(|e| e.to_string())
}

pub fn open_document(uri: &str) -> Result<File, String> {
    let fd: i32 = handle()?
        .run_mobile_plugin("openDocument", json!({"uri":uri}))
        .map_err(|e| e.to_string())?;
    if fd < 0 {
        return Err("无法读取授权的音乐文件".into());
    }
    // The plugin detached this descriptor from its ParcelFileDescriptor. File owns it from here.
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub fn open_file(path: &Path, mime: &str) -> Result<(), String> {
    handle()?
        .run_mobile_plugin("viewFile", json!({"path":path,"mime":mime}))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dialog_select_directory(title: Option<String>) -> Result<Option<String>, String> {
    call("pickTree", json!({"title":title})).await
}

#[tauri::command]
pub async fn local_music_scan(dirs: Vec<String>) -> Result<Value, String> {
    call("scan", json!({"dirs": dirs})).await
}

#[tauri::command]
pub async fn local_music_resolve(
    state: State<'_, Arc<AppState>>,
    ids: Vec<String>,
) -> Result<Value, String> {
    call(
        "scan",
        json!({"dirs":state.storage.get_local_music_dirs(),"ids":ids}),
    )
    .await
}

#[tauri::command]
pub async fn local_music_delete_file(
    state: State<'_, Arc<AppState>>,
    file_path: String,
) -> Result<bool, String> {
    call(
        "deleteDocument",
        json!({"uri":file_path,"dirs":state.storage.get_local_music_dirs()}),
    )
    .await
}

#[tauri::command]
pub async fn shell_show_file_in_folder(file_path: String) -> Result<bool, String> {
    call::<()>("viewFile", json!({"path":file_path}))
        .await
        .map(|()| true)
}

#[tauri::command]
pub async fn shell_open_directory(path: Option<String>) -> Result<bool, String> {
    call::<()>("browse", json!({"path": path}))
        .await
        .map(|()| true)
}

#[tauri::command]
pub async fn android_system_bars(color: String) -> Result<(), String> {
    call("systemBars", json!({ "color": color })).await
}

#[tauri::command]
pub async fn android_background() -> Result<(), String> {
    call("background", json!({})).await
}

#[tauri::command]
pub async fn android_export_file(
    app: AppHandle,
    name: String,
    mime: String,
    data: String,
) -> Result<bool, String> {
    use std::io::Write;
    let tmp = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let mut tmp = tempfile::NamedTempFile::new_in(cache).map_err(|e| e.to_string())?;
        let mut bytes = base64::read::DecoderReader::new(
            data.as_bytes(),
            &base64::engine::general_purpose::STANDARD,
        );
        std::io::copy(&mut bytes, tmp.as_file_mut()).map_err(|e| e.to_string())?;
        tmp.flush().map_err(|e| e.to_string())?;
        Ok(tmp)
    })
    .await
    .map_err(|e| e.to_string())??;
    call(
        "exportFile",
        json!({"path":tmp.path(),"name":name,"mime":mime}),
    )
    .await
}
