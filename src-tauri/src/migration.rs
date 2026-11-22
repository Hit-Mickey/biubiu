use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::{http::StatusCode, routing::get, Router};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::storage::{ListeningEntry, PlaylistOp, StorageManager};

#[derive(Default, Deserialize)]
struct LegacyLibrary {
    playlists: BTreeMap<String, Value>,
    history: Vec<ListeningEntry>,
    local: BTreeMap<String, String>,
}

pub fn locate(target: &Path) -> Option<PathBuf> {
    if std::env::var_os("BIUBIU_DATA_DIR").is_some()
        || target.join(".electron-library-v2").is_file()
    {
        return None;
    }
    let base = target.parent()?;
    ["BiuBiu", "biubiu", "Biu", "biu"]
        .into_iter()
        .map(|name| {
            base.join(if cfg!(debug_assertions) {
                format!("{name}-dev")
            } else {
                name.into()
            })
        })
        .find(|dir| dir.join("app-settings.json").is_file())
}

fn save_new(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    tmp.write_all(data)?;
    match tmp.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.error),
    }
}

pub fn copy_settings(legacy: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for name in [
        "app-settings",
        "shortcut-settings",
        "lyrics-cache",
        "desktop-lyrics",
        "webdav",
        "media-downloads",
    ] {
        let file = format!("{name}.json");
        let dest = target.join(&file);
        let src = legacy.join(file);
        if dest.exists() || !src.is_file() {
            continue;
        }
        let mut value: Value = serde_json::from_slice(&fs::read(src)?)?;
        if name == "webdav" {
            // Electron safeStorage ciphertext belongs to its original key store.
            value["passwords"] = serde_json::json!({});
        }
        save_new(&dest, &serde_json::to_vec(&value)?)?;
    }
    Ok(())
}

fn chromium() -> Option<PathBuf> {
    #[cfg(windows)]
    let paths: Vec<_> = ["ProgramFiles(x86)", "ProgramFiles"]
        .iter()
        .filter_map(std::env::var_os)
        .flat_map(|dir| {
            [
                "Microsoft/Edge/Application/msedge.exe",
                "Google/Chrome/Application/chrome.exe",
            ]
            .map(|p| PathBuf::from(&dir).join(p))
        })
        .collect();
    #[cfg(target_os = "macos")]
    let paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    .map(PathBuf::from);
    #[cfg(target_os = "linux")]
    let paths = [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/microsoft-edge",
    ]
    .map(PathBuf::from);
    paths.into_iter().find(|p| p.is_file())
}

fn copy_tree(src: &Path, dst: &Path, depth: usize) -> io::Result<()> {
    if depth > 8 || !fs::symlink_metadata(src)?.is_dir() {
        return Err(io::Error::other("旧版数据库目录异常"));
    }
    fs::create_dir_all(dst)?;
    for item in fs::read_dir(src)? {
        let item = item?;
        let name = item.file_name();
        if name == "LOCK" || name == "LOG" || name == "LOG.old" {
            continue;
        }
        let ty = item.file_type()?;
        if ty.is_dir() {
            copy_tree(&item.path(), &dst.join(name), depth + 1)?;
        } else if ty.is_file() {
            fs::copy(item.path(), dst.join(name))?;
        }
    }
    Ok(())
}

async fn read_library(legacy: &Path) -> Result<LegacyLibrary, Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let profile = tmp.path().join("profile");
    let default = profile.join("Default");
    let local = Path::new("Local Storage").join("leveldb");
    let mut has_data = false;
    if legacy.join(&local).is_dir() {
        copy_tree(&legacy.join(&local), &default.join(&local), 0)?;
        has_data = true;
    }
    // The packaged Electron app used file://. Only copy its music database origin.
    for name in ["file__0.indexeddb.leveldb", "file__0.indexeddb.blob"] {
        let rel = Path::new("IndexedDB").join(name);
        if legacy.join(&rel).is_dir() {
            copy_tree(&legacy.join(&rel), &default.join(&rel), 0)?;
            has_data = true;
        }
    }
    if !has_data {
        return Ok(LegacyLibrary::default());
    }
    let bytes = run_snapshot(&profile, tmp.path(), include_str!("legacy-library.html")).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn run_snapshot(
    profile: &Path,
    dir: &Path,
    html: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let browser = chromium().ok_or("自动迁移旧曲库需要已安装的 Edge、Chrome 或 Chromium")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let gate = format!("http://{}/{nonce}", listener.local_addr()?);
    let page = dir.join("migration.html");
    fs::write(&page, html.replace("__GATE__", &gate))?;
    let page_url = url::Url::from_file_path(&page).map_err(|_| "迁移页面路径无效")?;
    let done = CancellationToken::new();
    let hold = done.clone();
    let release = done.clone();
    let router = Router::new()
        .route(
            &format!("/{nonce}/hold"),
            get(move || async move {
                hold.cancelled().await;
                StatusCode::NO_CONTENT
            }),
        )
        .route(
            &format!("/{nonce}/done"),
            get(move || async move {
                release.cancel();
                StatusCode::NO_CONTENT
            }),
        );
    let shutdown = CancellationToken::new();
    let stop = shutdown.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await;
    });
    let mut command = tokio::process::Command::new(browser);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .args([
            "--headless",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-gpu",
            "--disable-sync",
            "--disable-background-networking",
            "--disable-component-update",
            "--dump-dom",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(page_url.as_str())
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output()).await;
    done.cancel();
    shutdown.cancel();
    server.await?;
    let output = output??;
    let html = std::str::from_utf8(&output.stdout)?;
    let encoded = html
        .split_once("<pre id=\"result\">")
        .and_then(|(_, rest)| rest.split_once("</pre>"))
        .map(|(s, _)| s)
        .filter(|s| !s.is_empty() && output.status.success())
        .ok_or("读取旧曲库未完成")?;
    Ok(STANDARD.decode(encoded)?)
}

pub async fn import_library(
    legacy: &Path,
    target: &Path,
    storage: &StorageManager,
) -> Result<(), String> {
    let library = read_library(legacy).await.map_err(|e| e.to_string())?;
    if !library.local.is_empty() {
        save_new(
            &target.join("legacy-renderer.json"),
            &serde_json::to_vec(&library.local).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    if !library.playlists.is_empty() && storage.sqlite_playlists_get_all()?.is_empty() {
        storage.sqlite_playlists_commit(
            library
                .playlists
                .into_iter()
                .map(|(key, value)| PlaylistOp {
                    op: "put".into(),
                    key: Some(key),
                    value: Some(value),
                })
                .collect(),
            None,
        )?;
    }
    if !library.history.is_empty() && storage.sqlite_history_get_all(1)?.is_empty() {
        storage.sqlite_history_replace(library.history, 2000)?;
    }
    save_new(&target.join(".electron-library-v2"), b"1").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires a locally installed Chromium-family browser"]
    async fn import_real_chromium_music_stores() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("synthetic");
        let seed = r#"<meta charset="utf-8"><img src="__GATE__/hold"><pre id="result"></pre><script type="module">
          async function put(db, store, key, value) {
            const r=indexedDB.open(db,1); r.onupgradeneeded=()=>r.result.createObjectStore(store);
            await new Promise((ok,no)=>{r.onsuccess=ok;r.onerror=no});
            const t=r.result.transaction(store,'readwrite');t.objectStore(store).put(value,key);
            await new Promise((ok,no)=>{t.oncomplete=ok;t.onerror=no});r.result.close();
          }
          localStorage.setItem("play-current-time","42");
          await put("biubiu-desktop-playlists","playlists","catalog",[{id:"fixture",name:"旧歌单"}]);
          await put("biubiu-listening-history","entries",1,{at:123,key:"test",title:"歌曲",source:"本地",seconds:2});
          document.querySelector("pre").textContent="e30="; new Image().src="__GATE__/done";
          </script>"#;
        run_snapshot(&profile, temp.path(), seed).await.unwrap();
        let legacy = profile.join("Default");
        let target = temp.path().join("new");
        let db = StorageManager::new(target.clone()).unwrap();
        import_library(&legacy, &target, &db).await.unwrap();
        assert_eq!(
            db.playlist_entry("catalog").unwrap().unwrap()[0]["name"],
            "旧歌单"
        );
        assert_eq!(db.sqlite_history_get_all(5).unwrap()[0].title, "歌曲");
        assert_eq!(
            db.read_json("legacy-renderer").unwrap().unwrap()["play-current-time"],
            "42"
        );
        assert!(legacy.join("IndexedDB/file__0.indexeddb.leveldb").is_dir());
    }
}
