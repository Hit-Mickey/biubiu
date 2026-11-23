use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

use crate::audio_engine::AudioEngineHandle;
use crate::bili_http::BiliHttpClient;
#[cfg(desktop)]
use crate::desktop_lyrics::DesktopLyricsManager;
use crate::download::DownloadManager;
use crate::storage::StorageManager;
use crate::updater::UpdaterState;
use crate::webdav::library::WebDavManager;
#[cfg(desktop)]
use crate::window_mgr::WindowLifecycle;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    #[serde(rename = "type", default = "default_proxy_type")]
    pub proxy_type: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
}

fn default_proxy_type() -> String {
    "none".to_string()
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub resource_dir: Option<PathBuf>,
    pub media_port: RwLock<u16>,
    pub media_token: String,
    pub storage: Arc<StorageManager>,
    pub http: Arc<BiliHttpClient>,
    pub webdav: Arc<WebDavManager>,
    pub audio: Arc<AudioEngineHandle>,
    pub downloads: Arc<DownloadManager>,
    #[cfg(desktop)]
    pub desktop_lyrics: Arc<DesktopLyricsManager>,
    pub updater: Arc<Mutex<UpdaterState>>,
    pub external_playlist_cancels: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub registered_shortcuts: Arc<Mutex<HashMap<String, String>>>,
    #[cfg(desktop)]
    pub window_lifecycle: Arc<WindowLifecycle>,
    pub migration_notice: Mutex<Option<&'static str>>,
    pub is_quitting: Arc<std::sync::atomic::AtomicBool>,
}

impl AppState {
    pub fn resolve_data_dir() -> PathBuf {
        if let Some(profile) = std::env::var_os("BIUBIU_DATA_DIR")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
        {
            return profile;
        }
        let base = dirs::config_dir()
            .or_else(dirs::data_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        let dir = base.join(if cfg!(debug_assertions) {
            "BiuBiu-Tauri-dev"
        } else {
            "BiuBiu-Tauri"
        });
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    pub fn media_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", *self.media_port.read())
    }

    pub fn runtime_init_script(&self, window_label: &str) -> String {
        let platform = if cfg!(target_os = "android") {
            "android"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        let payload = serde_json::json!({
            "base": self.media_base_url(),
            "token": self.media_token,
            "platform": platform,
            "windowLabel": window_label,
            "portable": crate::updater::is_portable(),
            "migrationNotice": if window_label == "main" { self.migration_notice.lock().take() } else { None },
            "pendingLegacyStorage": window_label == "main" && self.data_dir.join("legacy-renderer.json").is_file(),
        });
        let block_context = if window_label == "mini" {
            "window.addEventListener('contextmenu', function(e){ e.preventDefault(); }, true);"
        } else {
            ""
        };
        format!(
            "window.__BIUBIU_RUNTIME__ = {payload};\
            (function(){{\
              try {{\
                if (document.documentElement) document.documentElement.spellcheck = false;\
                document.addEventListener('focusin', function(e){{ var t = e.target; if (t && ('spellcheck' in t)) t.spellcheck = false; }}, true);\
                window.addEventListener('keydown', function(e){{ if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'r') e.preventDefault(); }}, true);\
                {block_context}\
              }} catch(_e) {{}}\
            }})();"
        )
    }

    pub fn resolve_ffmpeg_path(&self) -> PathBuf {
        #[cfg(target_os = "android")]
        if let Some(dir) = crate::android::BINARY_DIR.get() {
            return dir.join("libbiubiu_ffmpeg.so");
        }
        if let Some(custom) = self.storage.get_app_setting_string("ffmpegPath") {
            let trimmed = custom.trim();
            if !trimmed.is_empty() {
                let p = PathBuf::from(trimmed);
                if p.is_file() {
                    return p;
                }
            }
        }

        let binary_name = if cfg!(target_os = "windows") {
            "ffmpeg.exe"
        } else if cfg!(target_os = "macos") {
            "ffmpeg-mac"
        } else {
            "ffmpeg-linux"
        };

        let mut candidates = Vec::new();
        if let Some(res_dir) = &self.resource_dir {
            candidates.push(res_dir.join("resources").join("ffmpeg").join(binary_name));
            candidates.push(res_dir.join("ffmpeg").join(binary_name));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                candidates.push(parent.join("resources").join("ffmpeg").join(binary_name));
                candidates.push(parent.join("ffmpeg").join(binary_name));
            }
        }
        candidates.push(PathBuf::from("src-tauri/resources/ffmpeg").join(binary_name));
        candidates.push(PathBuf::from("resources/ffmpeg").join(binary_name));

        for c in candidates {
            if c.is_file() {
                return c;
            }
        }

        PathBuf::from(if cfg!(target_os = "windows") {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        })
    }

    pub fn resolve_icon_path(&self, name: &str) -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(res_dir) = &self.resource_dir {
            candidates.push(res_dir.join("icons").join(name));
            candidates.push(res_dir.join(name));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                candidates.push(parent.join("icons").join(name));
            }
        }
        candidates.push(PathBuf::from("src-tauri/icons").join(name));
        candidates.push(PathBuf::from("icons").join(name));
        candidates.into_iter().find(|p| p.is_file())
    }
}
