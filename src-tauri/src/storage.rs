use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::state::ProxySettings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistOp {
    pub op: String,
    pub key: Option<String>,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListeningEntry {
    pub at: i64,
    pub key: String,
    pub title: String,
    pub source: String,
    pub seconds: f64,
}

pub struct StorageManager {
    data_dir: PathBuf,
    db: Mutex<Connection>,
    json_lock: Mutex<()>,
    playlist_revision: AtomicU64,
}

impl StorageManager {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let db_path = data_dir.join("biubiu.db");
        let conn = Connection::open(&db_path).map_err(|e| format!("open sqlite failed: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS lyrics_cache (
                 track_key TEXT PRIMARY KEY,
                 payload TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS desktop_playlists (
                 entry_key TEXT PRIMARY KEY,
                 payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS listening_history (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 at INTEGER NOT NULL,
                 track_key TEXT NOT NULL,
                 title TEXT NOT NULL,
                 source TEXT NOT NULL,
                 seconds REAL NOT NULL
             );",
        )
        .map_err(|e| format!("init sqlite schema failed: {e}"))?;

        let mgr = Self {
            data_dir,
            db: Mutex::new(conn),
            json_lock: Mutex::new(()),
            playlist_revision: AtomicU64::new(0),
        };
        if let Err(err) = mgr.import_legacy_lyrics_json() {
            eprintln!("[migration:lyrics] {err}");
        }
        Ok(mgr)
    }

    fn import_legacy_lyrics_json(&self) -> Result<(), String> {
        let path = self.data_dir.join("lyrics-cache.json");
        if !path.is_file() {
            return Ok(());
        }
        let mut db = self.db.lock();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)",
            [],
        )
        .map_err(|e| e.to_string())?;
        if tx
            .execute(
                "INSERT OR IGNORE INTO migrations VALUES ('electron-lyrics')",
                [],
            )
            .map_err(|e| e.to_string())?
            == 0
        {
            return Ok(());
        }
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let entries: serde_json::Map<String, Value> =
            serde_json::from_reader(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        for (key, data) in entries {
            tx.execute("INSERT OR IGNORE INTO lyrics_cache (track_key,payload,updated_at) VALUES (?1,?2,?3)",
                params![key, data.to_string(), now]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    fn json_path(&self, name: &str) -> Result<PathBuf, String> {
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("invalid store name".to_string());
        }
        Ok(self.data_dir.join(format!("{name}.json")))
    }

    pub fn read_json(&self, name: &str) -> Result<Option<Value>, String> {
        let _guard = self.json_lock.lock();
        let path = self.json_path(name)?;
        if !path.is_file() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            return Ok(None);
        }
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => Ok(Some(v)),
            Err(_) => Ok(None),
        }
    }

    pub fn write_json(&self, name: &str, value: &Value) -> Result<(), String> {
        let _guard = self.json_lock.lock();
        let path = self.json_path(name)?;
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_json(&self, name: &str) -> Result<(), String> {
        let _guard = self.json_lock.lock();
        let path = self.json_path(name)?;
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    pub fn store_get(&self, name: &str) -> Result<Option<Value>, String> {
        if name == "lyrics-cache" {
            let conn = self.db.lock();
            let mut stmt = conn
                .prepare("SELECT track_key, payload FROM lyrics_cache")
                .map_err(|e| e.to_string())?;
            let mut out = serde_json::Map::new();
            let rows = stmt
                .query_map([], |row| {
                    let k: String = row.get(0)?;
                    let p: String = row.get(1)?;
                    Ok((k, p))
                })
                .map_err(|e| e.to_string())?;
            for item in rows.flatten() {
                if let Ok(v) = serde_json::from_str::<Value>(&item.1) {
                    out.insert(item.0, v);
                }
            }
            return Ok(Some(Value::Object(out)));
        }

        let mut val = self.read_json(name)?;
        if name == "app-settings" {
            val.get_or_insert_with(|| serde_json::json!({ "appSettings": {} }));
            if let Some(Value::Object(ref mut root)) = val {
                if let Some(Value::Object(ref mut settings)) = root.get_mut("appSettings") {
                    #[cfg(desktop)]
                    let needs_download_path = settings
                        .get("downloadPath")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true);
                    #[cfg(target_os = "android")]
                    let needs_download_path = !settings
                        .get("downloadPath")
                        .and_then(Value::as_str)
                        .is_some_and(|path| path.starts_with("content://"));
                    if needs_download_path {
                        #[cfg(desktop)]
                        let path = self.default_download_dir().to_string_lossy().to_string();
                        #[cfg(target_os = "android")]
                        let path = "系统默认目录".to_owned();
                        settings.insert("downloadPath".to_string(), Value::String(path));
                    }
                }
            }
        }
        Ok(val)
    }

    pub fn store_set(&self, name: &str, value: Value) -> Result<(), String> {
        if name == "lyrics-cache" {
            if let Value::Object(map) = value {
                let mut conn = self.db.lock();
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM lyrics_cache", [])
                    .map_err(|e| e.to_string())?;
                let now = chrono::Utc::now().timestamp_millis();
                for (k, v) in map {
                    let serialized = serde_json::to_string(&v).map_err(|e| e.to_string())?;
                    tx.execute(
                        "INSERT OR REPLACE INTO lyrics_cache (track_key, payload, updated_at) VALUES (?1, ?2, ?3)",
                        params![k, serialized, now],
                    )
                    .map_err(|e| e.to_string())?;
                }
                tx.commit().map_err(|e| e.to_string())?;
            }
            return Ok(());
        }

        if name == "app-settings" {
            #[cfg(desktop)]
            if let Some(auto_start) = value
                .get("appSettings")
                .and_then(|s| s.get("autoStart"))
                .and_then(|v| v.as_bool())
            {
                let prev = self
                    .read_json(name)?
                    .and_then(|v| v.pointer("/appSettings/autoStart")?.as_bool())
                    .unwrap_or(false);
                if prev != auto_start {
                    apply_auto_start(auto_start)?;
                }
            }
        }

        self.write_json(name, &value)
    }

    pub fn store_clear(&self, name: &str) -> Result<(), String> {
        if name == "lyrics-cache" {
            let conn = self.db.lock();
            conn.execute("DELETE FROM lyrics_cache", [])
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        self.clear_json(name)
    }

    pub fn get_app_setting_string(&self, key: &str) -> Option<String> {
        self.read_json("app-settings").ok().flatten().and_then(|v| {
            v.get("appSettings")?
                .get(key)?
                .as_str()
                .map(|s| s.to_string())
        })
    }

    pub fn get_local_music_dirs(&self) -> Vec<String> {
        self.read_json("app-settings")
            .ok()
            .flatten()
            .and_then(|v| {
                v.get("appSettings")?
                    .get("localMusicDirs")?
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
            })
            .unwrap_or_default()
    }

    pub fn get_close_window_option(&self) -> String {
        self.get_app_setting_string("closeWindowOption")
            .unwrap_or_else(|| "hide".to_string())
    }

    pub fn get_proxy_settings(&self) -> ProxySettings {
        self.read_json("app-settings")
            .ok()
            .flatten()
            .and_then(|v| v.get("appSettings")?.get("proxySettings").cloned())
            .and_then(|p| serde_json::from_value::<ProxySettings>(p).ok())
            .unwrap_or_default()
    }

    pub fn default_download_dir(&self) -> PathBuf {
        #[cfg(target_os = "android")]
        return self.data_dir.join("files").join("downloads").join("BiuBiu");
        #[cfg(desktop)]
        dirs::download_dir()
            .unwrap_or_else(|| self.data_dir.join("downloads"))
            .join("BiuBiu")
    }

    pub fn get_download_dir(&self) -> PathBuf {
        #[cfg(desktop)]
        if let Some(custom) = self.get_app_setting_string("downloadPath") {
            let trimmed = custom.trim();
            if !trimmed.is_empty() {
                let p = PathBuf::from(trimmed);
                let _ = std::fs::create_dir_all(&p);
                return p;
            }
        }
        self.default_download_dir()
    }

    pub fn get_track_lyrics(&self, key: &str) -> Result<Option<Value>, String> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare("SELECT payload FROM lyrics_cache WHERE track_key = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![key]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let text: String = row.get(0).map_err(|e| e.to_string())?;
            let val = serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?;
            return Ok(Some(val));
        }
        Ok(None)
    }

    pub fn set_track_lyrics(&self, key: &str, value: &Value) -> Result<(), String> {
        let conn = self.db.lock();
        let now = chrono::Utc::now().timestamp_millis();
        let serialized = serde_json::to_string(value).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO lyrics_cache (track_key, payload, updated_at) VALUES (?1, ?2, ?3)",
            params![key, serialized, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn sqlite_playlists_get_all(&self) -> Result<HashMap<String, Value>, String> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare("SELECT entry_key, payload FROM desktop_playlists")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let k: String = row.get(0)?;
                let p: String = row.get(1)?;
                Ok((k, p))
            })
            .map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        for row in rows.flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&row.1) {
                map.insert(row.0, v);
            }
        }
        Ok(map)
    }

    pub fn playlist_revision(&self) -> u64 {
        self.playlist_revision.load(Ordering::Acquire)
    }

    pub fn playlist_entry(&self, key: &str) -> Result<Option<Value>, String> {
        let payload: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT payload FROM desktop_playlists WHERE entry_key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        payload
            .map(|text| serde_json::from_str(&text))
            .transpose()
            .map_err(|e| e.to_string())
    }

    pub fn sqlite_playlists_commit(
        &self,
        ops: Vec<PlaylistOp>,
        expected: Option<u64>,
    ) -> Result<bool, String> {
        let mut conn = self.db.lock();
        if expected.is_some_and(|r| r != self.playlist_revision()) {
            return Ok(false);
        }
        if ops.is_empty() {
            return Ok(true);
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for op in ops {
            match op.op.as_str() {
                "put" => {
                    if let (Some(key), Some(val)) = (op.key, op.value) {
                        let serialized = serde_json::to_string(&val).map_err(|e| e.to_string())?;
                        tx.execute(
                            "INSERT OR REPLACE INTO desktop_playlists (entry_key, payload) VALUES (?1, ?2)",
                            params![key, serialized],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
                "delete" => {
                    if let Some(key) = op.key {
                        tx.execute(
                            "DELETE FROM desktop_playlists WHERE entry_key = ?1",
                            params![key],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
                "clear" => {
                    tx.execute("DELETE FROM desktop_playlists", [])
                        .map_err(|e| e.to_string())?;
                }
                _ => {}
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.playlist_revision.fetch_add(1, Ordering::Release);
        Ok(true)
    }

    pub fn sqlite_history_get_all(&self, limit: usize) -> Result<Vec<ListeningEntry>, String> {
        let conn = self.db.lock();
        let mut stmt = conn
            .prepare("SELECT at, track_key, title, source, seconds FROM listening_history ORDER BY id ASC LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(ListeningEntry {
                    at: row.get(0)?,
                    key: row.get(1)?,
                    title: row.get(2)?,
                    source: row.get(3)?,
                    seconds: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    }

    pub fn sqlite_history_add(&self, entry: ListeningEntry, limit: usize) -> Result<(), String> {
        let mut conn = self.db.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO listening_history (at, track_key, title, source, seconds) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![entry.at, entry.key, entry.title, entry.source, entry.seconds],
        )
        .map_err(|e| e.to_string())?;
        let last_id = tx.last_insert_rowid();
        let cutoff = last_id - limit as i64;
        if cutoff > 0 {
            tx.execute(
                "DELETE FROM listening_history WHERE id <= ?1",
                params![cutoff],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn sqlite_history_replace(
        &self,
        entries: Vec<ListeningEntry>,
        limit: usize,
    ) -> Result<(), String> {
        let mut conn = self.db.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM listening_history", [])
            .map_err(|e| e.to_string())?;
        let start = entries.len().saturating_sub(limit);
        for entry in &entries[start..] {
            tx.execute(
                "INSERT INTO listening_history (at, track_key, title, source, seconds) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![entry.at, entry.key, entry.title, entry.source, entry.seconds],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

#[cfg(target_os = "windows")]
pub fn apply_auto_start(enabled: bool) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_WRITE, REG_SZ,
    };

    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run\0"
        .encode_utf16()
        .collect();
    let value_name: Vec<u16> = "BiuBiu\0".encode_utf16().collect();

    unsafe {
        let mut hkey = HKEY::default();
        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_WRITE,
            &mut hkey,
        );
        if status.is_err() {
            return Ok(());
        }
        if enabled {
            if let Ok(exe) = std::env::current_exe() {
                let cmd = format!("\"{}\"\0", exe.to_string_lossy());
                let wide: Vec<u16> = cmd.encode_utf16().collect();
                let bytes = std::slice::from_raw_parts(
                    wide.as_ptr() as *const u8,
                    wide.len() * std::mem::size_of::<u16>(),
                );
                let _ = RegSetValueExW(hkey, PCWSTR(value_name.as_ptr()), 0, REG_SZ, Some(bytes));
            }
        } else {
            let _ = RegDeleteValueW(hkey, PCWSTR(value_name.as_ptr()));
        }
        let _ = RegCloseKey(hkey);
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn apply_auto_start(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let dest = dirs::home_dir()
        .ok_or("无法定位用户目录")?
        .join("Library/LaunchAgents/com.hitmickey.biubiu.plist");
    #[cfg(target_os = "linux")]
    let dest = dirs::config_dir()
        .ok_or("无法定位配置目录")?
        .join("autostart/biubiu.desktop");
    if !enabled {
        return match std::fs::remove_file(dest) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.hitmickey.biubiu</string>
<key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>"#,
        quick_xml::escape::escape(exe.to_string_lossy())
    );
    #[cfg(target_os = "linux")]
    let content = {
        let exe = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or(exe);
        let argument = exe
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%");
        format!("[Desktop Entry]\nType=Application\nName=BiuBiu\nExec=\"{argument}\"\nX-GNOME-Autostart-enabled=true\n")
    };
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(dest, content).map_err(|e| e.to_string())
}
