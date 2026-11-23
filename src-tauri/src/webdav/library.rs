use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::stream::{self, StreamExt};
use parking_lot::{Mutex, RwLock};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

use crate::bili_http::BiliHttpClient;
use crate::storage::StorageManager;

use super::cache::WebDavCache;
use super::client::{
    normalize_webdav_url, read_limited_bytes, relative_folder, resolve_webdav_directory,
    WebDavClient, WebDavHttpError,
};
use super::crypto::{decrypt_secret, encrypt_secret};
use super::metadata::{
    file_stem_and_ext, find_sidecars, is_supported_audio_ext, read_cover_file, read_lyric_file,
    read_remote_audio_tags, ParsedAudioTags, StoredTrack,
};

const MAX_BACKUP_BYTES: usize = 8 * 1024 * 1024;
const TAG_CONCURRENCY: usize = 4;
const TAG_BATCH_SIZE: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavListConfig {
    pub name: String,
    pub url: String,
    pub username: String,
    pub directory: String,
    pub include_subdirectories: bool,
    pub lazy_metadata: bool,
    pub remove_remote_files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavListInput {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: Option<String>,
    pub directory: String,
    pub include_subdirectories: bool,
    pub lazy_metadata: bool,
    pub remove_remote_files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavTrackPublic {
    pub id: String,
    pub title: String,
    pub filename: String,
    pub folder: String,
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lossless: Option<bool>,
    pub has_cover: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavListPublic {
    pub id: String,
    pub name: String,
    pub url: String,
    pub username: String,
    pub directory: String,
    pub include_subdirectories: bool,
    pub lazy_metadata: bool,
    pub remove_remote_files: bool,
    pub tracks: Vec<WebDavTrackPublic>,
    pub synced_at: i64,
    pub has_password: bool,
    pub is_syncing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebDavPreferences {
    #[serde(default)]
    pub cache_audio: bool,
    #[serde(default)]
    pub debug_log: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavLibraryPublic {
    pub lists: Vec<WebDavListPublic>,
    pub preferences: WebDavPreferences,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavRemoveResult {
    pub removed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWebDavListResult {
    pub id: String,
    pub password_session_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupTarget {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredList {
    id: String,
    name: String,
    url: String,
    username: String,
    directory: String,
    include_subdirectories: bool,
    lazy_metadata: bool,
    remove_remote_files: bool,
    #[serde(default)]
    tracks: Vec<StoredTrack>,
    #[serde(default)]
    hidden_ids: Vec<String>,
    #[serde(default)]
    synced_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LibraryData {
    #[serde(default)]
    lists: Vec<StoredList>,
    #[serde(default)]
    passwords: HashMap<String, String>,
    #[serde(default)]
    preferences: WebDavPreferences,
}

pub struct WebDavManager {
    storage: Arc<StorageManager>,
    http: Arc<BiliHttpClient>,
    cache: WebDavCache,
    data: RwLock<LibraryData>,
    session_passwords: RwLock<HashMap<String, String>>,
    syncing: Mutex<HashMap<String, broadcast::Sender<Result<(), String>>>>,
    tag_batches: Mutex<HashMap<String, u64>>,
    next_tag_batch: AtomicU64,
    cache_jobs: Mutex<HashMap<String, tokio_util::sync::CancellationToken>>,
    errors: Mutex<HashMap<String, String>>,
    cover_cache: Mutex<HashMap<String, (String, Vec<u8>)>>,
    app_handle: RwLock<Option<AppHandle>>,
}

fn digest_parts(parts: &[&str]) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(parts).expect("JSON strings"),
    ))
}

pub fn track_version(track: &StoredTrack) -> String {
    let parts = (&track.id, &track.etag, track.size, track.modified_at);
    hex::encode(Sha256::digest(
        serde_json::to_vec(&parts).expect("JSON track version"),
    ))
}

fn password_key(url: &str, username: &str) -> String {
    digest_parts(&[url, username])
}

fn to_public_track(t: &StoredTrack) -> WebDavTrackPublic {
    WebDavTrackPublic {
        id: t.id.clone(),
        title: t.title.clone(),
        filename: t.filename.clone(),
        folder: t.folder.clone(),
        format: t.format.clone(),
        size: t.size,
        created_at: t.created_at,
        modified_at: t.modified_at,
        artist: t.artist.clone(),
        album: t.album.clone(),
        duration: t.duration,
        year: t.year,
        disc: t.disc,
        track: t.track,
        lossless: t.lossless,
        has_cover: t.has_cover,
    }
}

impl WebDavManager {
    pub fn new(storage: Arc<StorageManager>, http: Arc<BiliHttpClient>) -> Self {
        let cache = WebDavCache::new(storage.data_dir());
        let data = storage
            .read_json("webdav")
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value::<LibraryData>(v).ok())
            .unwrap_or_default();
        Self {
            storage,
            http,
            cache,
            data: RwLock::new(data),
            session_passwords: RwLock::new(HashMap::new()),
            syncing: Mutex::new(HashMap::new()),
            tag_batches: Mutex::new(HashMap::new()),
            next_tag_batch: AtomicU64::new(0),
            cache_jobs: Mutex::new(HashMap::new()),
            errors: Mutex::new(HashMap::new()),
            cover_cache: Mutex::new(HashMap::new()),
            app_handle: RwLock::new(None),
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    fn emit_change(&self, removed: Vec<String>) {
        if let Some(app) = self.app_handle.read().as_ref() {
            let _ = app.emit("webdav://change", removed);
        }
    }

    fn persist(&self, removed: Vec<String>) {
        let snapshot = self.data.read().clone();
        if let Ok(val) = serde_json::to_value(&snapshot) {
            let _ = self.storage.write_json("webdav", &val);
        }
        self.emit_change(removed);
    }

    fn resolve_password(&self, url: &str, username: &str) -> String {
        let key = password_key(url, username);
        if let Some(p) = self.session_passwords.read().get(&key) {
            return p.clone();
        }
        if let Some(enc) = self.data.read().passwords.get(&key) {
            if let Ok(plain) = decrypt_secret(enc) {
                return plain;
            }
        }
        String::new()
    }

    fn build_client(
        &self,
        url: &str,
        username: &str,
        password: &str,
    ) -> Result<WebDavClient, String> {
        WebDavClient::new(self.http.no_redirect_client(), url, username, password)
    }

    pub fn list_ids(&self) -> Vec<String> {
        self.data
            .read()
            .lists
            .iter()
            .map(|list| list.id.clone())
            .collect()
    }

    fn remember_cover(&self, version: &str, image: &(String, Vec<u8>)) {
        const MAX_BYTES: usize = 8 * 1024 * 1024;
        if image.1.len() > MAX_BYTES {
            return;
        }
        let mut cache = self.cover_cache.lock();
        if cache.len() >= 64
            || cache.values().map(|(_, bytes)| bytes.len()).sum::<usize>() + image.1.len()
                > MAX_BYTES
        {
            cache.clear();
        }
        cache.insert(version.to_owned(), image.clone());
    }

    pub fn get_library(&self) -> WebDavLibraryPublic {
        let data = self.data.read();
        let sess = self.session_passwords.read();
        let syncing = self.syncing.lock();
        let errors = self.errors.lock();
        let lists = data
            .lists
            .iter()
            .map(|l| {
                let hidden: HashSet<&str> = l.hidden_ids.iter().map(|s| s.as_str()).collect();
                let key = password_key(&l.url, &l.username);
                let has_password = data.passwords.contains_key(&key) || sess.contains_key(&key);
                WebDavListPublic {
                    id: l.id.clone(),
                    name: l.name.clone(),
                    url: l.url.clone(),
                    username: l.username.clone(),
                    directory: l.directory.clone(),
                    include_subdirectories: l.include_subdirectories,
                    lazy_metadata: l.lazy_metadata,
                    remove_remote_files: l.remove_remote_files,
                    tracks: l
                        .tracks
                        .iter()
                        .filter(|t| !hidden.contains(t.id.as_str()))
                        .map(to_public_track)
                        .collect(),
                    synced_at: l.synced_at,
                    has_password,
                    is_syncing: syncing.contains_key(&l.id),
                    error: errors.get(&l.id).cloned(),
                }
            })
            .collect();
        WebDavLibraryPublic {
            lists,
            preferences: data.preferences.clone(),
        }
    }

    pub fn get_preferences(&self) -> WebDavPreferences {
        self.data.read().preferences.clone()
    }

    pub fn set_preferences(&self, preferences: WebDavPreferences) {
        self.data.write().preferences = preferences;
        self.persist(Vec::new());
    }

    pub fn clear_cache(&self) -> Result<(), String> {
        for job in self.cache_jobs.lock().values() {
            job.cancel();
        }
        self.cover_cache.lock().clear();
        self.cache.clear()
    }

    pub fn get_backup_targets(&self) -> Vec<BackupTarget> {
        self.data
            .read()
            .lists
            .iter()
            .map(|l| BackupTarget {
                id: l.id.clone(),
                name: l.name.clone(),
            })
            .collect()
    }

    fn get_list_clone(&self, id: &str) -> Result<StoredList, String> {
        self.data
            .read()
            .lists
            .iter()
            .find(|l| l.id == id)
            .cloned()
            .ok_or_else(|| "未找到对应的 WebDAV 列表".to_string())
    }

    pub async fn test_list(&self, input: WebDavListInput) -> Result<(), String> {
        let url = normalize_webdav_url(&input.url)?;
        let username = input.username.trim().to_string();
        let password = match input.password {
            Some(p) if !p.is_empty() => p,
            _ => self.resolve_password(&url, &username),
        };
        let client = self.build_client(&url, &username, &password)?;
        let dir = resolve_webdav_directory(&client.base, &input.directory);
        client.list(&dir).await.map_err(|e| e.message)?;
        Ok(())
    }

    pub async fn save_list(
        self: &Arc<Self>,
        input: WebDavListInput,
    ) -> Result<SaveWebDavListResult, String> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err("请填写列表名称".to_string());
        }
        let url = normalize_webdav_url(&input.url)?;
        let username = input.username.trim().to_string();
        let directory = input.directory.trim().to_string();
        let id = input
            .id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let mut password_session_only = false;
        if let Some(pwd) = input.password {
            if !pwd.is_empty() {
                let key = password_key(&url, &username);
                self.session_passwords
                    .write()
                    .insert(key.clone(), pwd.clone());
                match encrypt_secret(&pwd) {
                    Ok(enc) => {
                        let previous = self.data.write().passwords.insert(key, enc);
                        if let Some(reference) = previous {
                            super::crypto::forget_secret(&reference);
                        }
                    }
                    Err(_) => {
                        password_session_only = true;
                    }
                }
            }
        }

        {
            let mut data = self.data.write();
            if let Some(existing) = data.lists.iter_mut().find(|l| l.id == id) {
                existing.name = name;
                existing.url = url;
                existing.username = username;
                existing.directory = directory;
                existing.include_subdirectories = input.include_subdirectories;
                existing.lazy_metadata = input.lazy_metadata;
                existing.remove_remote_files = input.remove_remote_files;
            } else {
                data.lists.push(StoredList {
                    id: id.clone(),
                    name,
                    url,
                    username,
                    directory,
                    include_subdirectories: input.include_subdirectories,
                    lazy_metadata: input.lazy_metadata,
                    remove_remote_files: input.remove_remote_files,
                    tracks: Vec::new(),
                    hidden_ids: Vec::new(),
                    synced_at: 0,
                });
            }
        }
        self.persist(Vec::new());
        self.tag_batches.lock().remove(&id);

        let this = self.clone();
        let refresh_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = this.refresh_list(&refresh_id).await;
        });

        Ok(SaveWebDavListResult {
            id,
            password_session_only,
        })
    }

    pub async fn refresh_list(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let list = self.get_list_clone(id)?;
        let waiter = {
            let mut s = self.syncing.lock();
            if let Some(existing) = s.get(id) {
                Some(existing.subscribe())
            } else {
                let (tx, _) = broadcast::channel(1);
                s.insert(id.to_string(), tx);
                None
            }
        };
        if let Some(mut rx) = waiter {
            return rx.recv().await.unwrap_or(Ok(()));
        }
        self.errors.lock().remove(id);
        self.emit_change(Vec::new());

        let password = self.resolve_password(&list.url, &list.username);
        let result = self.scan_list(&list, &password).await;

        let tx = self.syncing.lock().remove(id);
        match result {
            Ok((new_tracks, removed_ids)) => {
                let should_read_tags = !list.lazy_metadata;
                {
                    let mut data = self.data.write();
                    if let Some(target) = data.lists.iter_mut().find(|l| l.id == id) {
                        target.tracks = new_tracks;
                        target.hidden_ids.clear();
                        target.synced_at = chrono::Utc::now().timestamp_millis();
                    }
                }
                self.persist(removed_ids);
                if let Some(tx) = tx {
                    let _ = tx.send(Ok(()));
                }
                if should_read_tags {
                    self.spawn_tag_reader(id.to_string());
                } else {
                    self.tag_batches.lock().remove(id);
                }
                Ok(())
            }
            Err(err) => {
                self.errors.lock().insert(id.to_string(), err.clone());
                self.emit_change(Vec::new());
                if let Some(tx) = tx {
                    let _ = tx.send(Err(err.clone()));
                }
                Err(err)
            }
        }
    }

    async fn scan_list(
        &self,
        list: &StoredList,
        password: &str,
    ) -> Result<(Vec<StoredTrack>, Vec<String>), String> {
        let client = self.build_client(&list.url, &list.username, password)?;
        let root_dir = resolve_webdav_directory(&client.base, &list.directory);

        let prev_by_id: HashMap<String, StoredTrack> = list
            .tracks
            .iter()
            .map(|t| (t.id.clone(), t.clone()))
            .collect();

        let mut queue = vec![(root_dir.clone(), 0)];
        let mut visited = HashSet::new();
        let mut tracks: Vec<StoredTrack> = Vec::new();

        while let Some((dir, depth)) = queue.pop() {
            if !visited.insert(dir.clone()) {
                continue;
            }
            let entries = client.list(&dir).await.map_err(|e| e.message)?;
            let sidecars = find_sidecars(&entries);

            for entry in entries {
                if entry.collection {
                    if list.include_subdirectories && depth < 5 {
                        queue.push((entry.path, depth + 1));
                    }
                    continue;
                }
                let (stem, ext) = file_stem_and_ext(&entry.filename);
                if entry.size == Some(0) || !is_supported_audio_ext(&ext) {
                    continue;
                }
                let track_id = digest_parts(&[&list.id, &list.url, &list.username, &entry.path]);
                let folder = relative_folder(&root_dir, &entry.path);
                let (cover_path, lyric_path) =
                    sidecars.get(&entry.path).cloned().unwrap_or((None, None));

                let mut track = StoredTrack {
                    id: track_id.clone(),
                    path: entry.path,
                    title: stem,
                    filename: entry.filename,
                    folder,
                    format: ext,
                    size: entry.size,
                    created_at: entry.created_at,
                    modified_at: entry.modified_at,
                    etag: entry.etag,
                    artist: None,
                    album: None,
                    duration: None,
                    year: None,
                    disc: None,
                    track: None,
                    lossless: None,
                    has_cover: cover_path.is_some(),
                    cover_path,
                    lyric_path,
                    tags_version: None,
                    metadata_parsed: false,
                };

                let ver = track_version(&track);
                if let Some(prev) = prev_by_id.get(&track_id) {
                    let reused = prev.tags_version.as_deref() == Some(ver.as_str())
                        || (prev.metadata_parsed && track_version(prev) == ver);
                    if reused {
                        track.title = prev.title.clone();
                        track.artist = prev.artist.clone();
                        track.album = prev.album.clone();
                        track.duration = prev.duration;
                        track.year = prev.year;
                        track.disc = prev.disc;
                        track.track = prev.track;
                        track.lossless = prev.lossless;
                        track.has_cover = prev.has_cover || track.cover_path.is_some();
                        track.tags_version = Some(ver);
                        track.metadata_parsed = true;
                    }
                }

                tracks.push(track);
            }
        }

        tracks.sort_by(|a, b| a.folder.cmp(&b.folder).then(a.filename.cmp(&b.filename)));

        let new_ids: HashSet<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
        let removed: Vec<String> = list
            .tracks
            .iter()
            .filter(|t| !new_ids.contains(t.id.as_str()))
            .map(|t| t.id.clone())
            .collect();

        Ok((tracks, removed))
    }

    fn spawn_tag_reader(self: &Arc<Self>, list_id: String) {
        let Ok(list) = self.get_list_clone(&list_id) else {
            self.tag_batches.lock().remove(&list_id);
            return;
        };
        if list.lazy_metadata {
            self.tag_batches.lock().remove(&list_id);
            return;
        }
        let pending: Vec<StoredTrack> = list
            .tracks
            .iter()
            .filter(|track| {
                let ver = track_version(track);
                track.tags_version.as_deref() != Some(ver.as_str())
            })
            .cloned()
            .collect();
        if pending.is_empty() {
            self.tag_batches.lock().remove(&list_id);
            return;
        }
        let password = self.resolve_password(&list.url, &list.username);
        let Ok(client) = self.build_client(&list.url, &list.username, &password) else {
            return;
        };
        let batch_id = self.next_tag_batch.fetch_add(1, Ordering::SeqCst) + 1;
        self.tag_batches.lock().insert(list_id.clone(), batch_id);

        let this = self.clone();
        tokio::spawn(async move {
            for chunk in pending.chunks(TAG_BATCH_SIZE) {
                if this.tag_batches.lock().get(&list_id) != Some(&batch_id) {
                    return;
                }
                let client_ref = &client;
                let updates: Vec<(String, String, ParsedAudioTags)> =
                    stream::iter(chunk.iter().cloned())
                        .map(|track| async move {
                            let ver = track_version(&track);
                            let mut parsed =
                                read_remote_audio_tags(client_ref, &track).await.ok()?;
                            let has_cover = parsed.cover.is_some();
                            if has_cover {
                                parsed.cover = Some((String::new(), Vec::new()));
                            }
                            Some((track.id, ver, parsed))
                        })
                        .buffer_unordered(TAG_CONCURRENCY)
                        .filter_map(|item| async move { item })
                        .collect()
                        .await;
                if this.tag_batches.lock().get(&list_id) != Some(&batch_id) {
                    return;
                }
                if updates.is_empty() {
                    continue;
                }
                let mut changed = false;
                {
                    let mut data = this.data.write();
                    if let Some(target) = data.lists.iter_mut().find(|l| l.id == list_id) {
                        let mut updates_map: HashMap<String, (String, ParsedAudioTags)> = updates
                            .into_iter()
                            .map(|(track_id, ver, parsed)| (track_id, (ver, parsed)))
                            .collect();
                        for track in &mut target.tracks {
                            if let Some((ver, parsed)) = updates_map.remove(&track.id) {
                                if track_version(track) == ver {
                                    apply_parsed_tags(track, &parsed, &ver);
                                    changed = true;
                                }
                            }
                        }
                    }
                }
                if changed {
                    this.persist(Vec::new());
                }
            }
            let mut batches = this.tag_batches.lock();
            if batches.get(&list_id) == Some(&batch_id) {
                batches.remove(&list_id);
            }
        });
    }

    pub fn delete_list(&self, id: &str) -> Result<(), String> {
        let removed: Vec<String> = {
            let mut data = self.data.write();
            let Some(pos) = data.lists.iter().position(|l| l.id == id) else {
                return Ok(());
            };
            let list = data.lists.remove(pos);
            list.tracks.into_iter().map(|t| t.id).collect()
        };
        self.tag_batches.lock().remove(id);
        self.errors.lock().remove(id);
        self.persist(removed);
        Ok(())
    }

    pub async fn remove_tracks(
        &self,
        id: &str,
        track_ids: Vec<String>,
        delete_files: bool,
    ) -> Result<WebDavRemoveResult, String> {
        let list = self.get_list_clone(id)?;
        let target_set: HashSet<String> = track_ids.into_iter().collect();
        let mut removed = Vec::new();
        let mut first_error: Option<String> = None;

        if delete_files && list.remove_remote_files {
            let password = self.resolve_password(&list.url, &list.username);
            let client = self.build_client(&list.url, &list.username, &password)?;
            for track in &list.tracks {
                if !target_set.contains(&track.id) {
                    continue;
                }
                match client.remove(&track.path).await {
                    Ok(()) => removed.push(track.id.clone()),
                    Err(err) => {
                        if first_error.is_none() {
                            first_error = Some(err);
                        }
                    }
                }
            }
            let rem_set: HashSet<&str> = removed.iter().map(|s| s.as_str()).collect();
            {
                let mut data = self.data.write();
                if let Some(l) = data.lists.iter_mut().find(|l| l.id == id) {
                    l.tracks.retain(|t| !rem_set.contains(t.id.as_str()));
                }
            }
        } else {
            let mut data = self.data.write();
            if let Some(l) = data.lists.iter_mut().find(|l| l.id == id) {
                for tid in &target_set {
                    if l.tracks.iter().any(|t| &t.id == tid) {
                        if !l.hidden_ids.contains(tid) {
                            l.hidden_ids.push(tid.clone());
                        }
                        removed.push(tid.clone());
                    }
                }
            }
        }

        self.persist(removed.clone());
        Ok(WebDavRemoveResult {
            removed,
            error: first_error,
        })
    }

    pub async fn get_track_metadata(
        &self,
        list_id: &str,
        track_id: &str,
    ) -> Result<WebDavTrackPublic, String> {
        let list = self.get_list_clone(list_id)?;
        let mut track = list
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .cloned()
            .ok_or_else(|| "未找到 WebDAV 歌曲".to_string())?;

        let ver = track_version(&track);
        let already_parsed =
            track.tags_version.as_deref() == Some(ver.as_str()) || track.metadata_parsed;
        if !already_parsed {
            let password = self.resolve_password(&list.url, &list.username);
            let client = self.build_client(&list.url, &list.username, &password)?;
            if let Ok(parsed) = read_remote_audio_tags(&client, &track).await {
                if let Some(cover) = &parsed.cover {
                    self.remember_cover(&ver, cover);
                }
                apply_parsed_tags(&mut track, &parsed, &ver);
                {
                    let mut data = self.data.write();
                    if let Some(l) = data.lists.iter_mut().find(|l| l.id == list_id) {
                        if let Some(t) = l.tracks.iter_mut().find(|t| t.id == track_id) {
                            *t = track.clone();
                        }
                    }
                }
                self.persist(Vec::new());
            }
        }

        Ok(to_public_track(&track))
    }

    pub async fn get_track_cover(
        &self,
        list_id: &str,
        track_id: &str,
    ) -> Result<Option<(String, Vec<u8>)>, String> {
        let list = self.get_list_clone(list_id)?;
        let track = list
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .cloned()
            .ok_or_else(|| "未找到 WebDAV 歌曲".to_string())?;
        let ver = track_version(&track);
        if let Some(cached) = self.cover_cache.lock().get(&ver).cloned() {
            return Ok(Some(cached));
        }

        let password = self.resolve_password(&list.url, &list.username);
        let client = self.build_client(&list.url, &list.username, &password)?;
        if let Some(ref cover_path) = track.cover_path {
            if let Ok(Some(img)) = read_cover_file(&client, cover_path).await {
                self.remember_cover(&ver, &img);
                return Ok(Some(img));
            }
        }
        if let Ok(parsed) = read_remote_audio_tags(&client, &track).await {
            if let Some(img) = parsed.cover {
                self.remember_cover(&ver, &img);
                return Ok(Some(img));
            }
        }
        Ok(None)
    }

    pub async fn get_track_lyrics(
        &self,
        list_id: &str,
        track_id: &str,
    ) -> Result<Option<String>, String> {
        let list = self.get_list_clone(list_id)?;
        let track = list
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .cloned()
            .ok_or_else(|| "未找到 WebDAV 歌曲".to_string())?;
        let password = self.resolve_password(&list.url, &list.username);
        let client = self.build_client(&list.url, &list.username, &password)?;
        if let Some(ref lrc_path) = track.lyric_path {
            if let Ok(Some(text)) = read_lyric_file(&client, lrc_path).await {
                return Ok(Some(text));
            }
        }
        Ok(read_remote_audio_tags(&client, &track)
            .await
            .ok()
            .and_then(|parsed| parsed.lyrics))
    }

    pub fn open_track(
        &self,
        list_id: &str,
        track_id: &str,
    ) -> Result<(WebDavClient, StoredTrack, bool), String> {
        let list = self.get_list_clone(list_id)?;
        let hidden: HashSet<&str> = list.hidden_ids.iter().map(|s| s.as_str()).collect();
        let track = list
            .tracks
            .iter()
            .find(|t| t.id == track_id && !hidden.contains(t.id.as_str()))
            .cloned()
            .ok_or_else(|| "未找到 WebDAV 歌曲".to_string())?;
        let password = self.resolve_password(&list.url, &list.username);
        let client = self.build_client(&list.url, &list.username, &password)?;
        let cache_audio = self.data.read().preferences.cache_audio;
        Ok((client, track, cache_audio))
    }

    pub fn cached_audio_path(&self, version: &str) -> Option<PathBuf> {
        self.cache.get_cached_file(version)
    }

    pub fn cache_audio(
        self: &Arc<Self>,
        client: WebDavClient,
        track: StoredTrack,
        version: String,
    ) {
        let cancel = tokio_util::sync::CancellationToken::new();
        {
            let mut jobs = self.cache_jobs.lock();
            if jobs.contains_key(&version) || self.cached_audio_path(&version).is_some() {
                return;
            }
            jobs.insert(version.clone(), cancel.clone());
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {},
                _ = async {
                    let response = client.request(&track.path, Method::GET, None, None, true).await?;
                    if response.status() == reqwest::StatusCode::OK {
                        manager.cache.write_response(&version, response).await?;
                    }
                    Ok::<(), String>(())
                } => {}
            }
            manager.cache_jobs.lock().remove(&version);
        });
    }

    fn backup_connection(&self, id: &str) -> Result<(WebDavClient, String), String> {
        let list = self.get_list_clone(id)?;
        let password = self.resolve_password(&list.url, &list.username);
        let client = self.build_client(&list.url, &list.username, &password)?;
        let dir = format!(
            "{}BiuBiu-Backups/",
            resolve_webdav_directory(&client.base, &list.directory)
        );
        Ok((client, dir))
    }

    pub async fn list_backups(&self, id: &str) -> Result<Vec<String>, String> {
        let (client, dir) = self.backup_connection(id)?;
        match client.list(&dir).await {
            Ok(entries) => {
                let mut names: Vec<String> = entries
                    .into_iter()
                    .filter(|e| !e.collection && is_valid_backup_name(&e.filename))
                    .map(|e| e.filename)
                    .collect();
                names.sort();
                names.reverse();
                Ok(names)
            }
            Err(WebDavHttpError { status: 404, .. }) => Ok(Vec::new()),
            Err(e) => Err(e.message),
        }
    }

    pub async fn upload_backup(&self, id: &str, text: &str) -> Result<String, String> {
        if text.len() > MAX_BACKUP_BYTES {
            return Err("备份格式错误或超过 8 MiB".to_string());
        }
        let parsed: serde_json::Value =
            serde_json::from_str(text).map_err(|_| "备份格式错误或超过 8 MiB".to_string())?;
        let valid = parsed.get("format").and_then(|v| v.as_str()) == Some("biubiu-desktop")
            && parsed.get("version").and_then(|v| v.as_i64()) == Some(1);
        if !valid {
            return Err("备份格式错误或超过 8 MiB".to_string());
        }

        let (client, dir) = self.backup_connection(id)?;
        let mkcol = Method::from_bytes(b"MKCOL").unwrap();
        let mk_resp = client.request(&dir, mkcol, None, None, false).await?;
        let mk_status = mk_resp.status().as_u16();
        if mk_status != 405 && !mk_resp.status().is_success() {
            return Err(WebDavHttpError::new(mk_status).message);
        }

        let ts = chrono::Utc::now()
            .format("%Y-%m-%dT%H-%M-%S-%3fZ")
            .to_string();
        let short_id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let name = format!("biubiu-{ts}-{short_id}.json");

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("If-None-Match", HeaderValue::from_static("*"));
        let put_resp = client
            .request(
                &format!("{dir}{name}"),
                Method::PUT,
                Some(headers),
                Some(text.as_bytes().to_vec()),
                false,
            )
            .await?;
        if !put_resp.status().is_success() {
            return Err(WebDavHttpError::new(put_resp.status().as_u16()).message);
        }
        Ok(name)
    }

    pub async fn download_backup(&self, id: &str, name: &str) -> Result<String, String> {
        if !is_valid_backup_name(name) {
            return Err("无效的备份文件名".to_string());
        }
        let (client, dir) = self.backup_connection(id)?;
        let resp = client
            .request(&format!("{dir}{name}"), Method::GET, None, None, false)
            .await?;
        if !resp.status().is_success() {
            return Err(WebDavHttpError::new(resp.status().as_u16()).message);
        }
        let bytes = read_limited_bytes(resp, MAX_BACKUP_BYTES, false).await?;
        String::from_utf8(bytes).map_err(|_| "备份文件编码无效".to_string())
    }
}

fn apply_parsed_tags(track: &mut StoredTrack, parsed: &ParsedAudioTags, ver: &str) {
    if let Some(ref title) = parsed.title {
        track.title = title.clone();
    }
    if parsed.artist.is_some() {
        track.artist = parsed.artist.clone();
    }
    if parsed.album.is_some() {
        track.album = parsed.album.clone();
    }
    if parsed.duration.is_some() {
        track.duration = parsed.duration;
    }
    if parsed.year.is_some() {
        track.year = parsed.year;
    }
    if parsed.disc.is_some() {
        track.disc = parsed.disc;
    }
    if parsed.track.is_some() {
        track.track = parsed.track;
    }
    if parsed.lossless.is_some() {
        track.lossless = parsed.lossless;
    }
    if parsed.cover.is_some() {
        track.has_cover = true;
    }
    track.tags_version = Some(ver.to_string());
    track.metadata_parsed = true;
}

fn is_valid_backup_name(name: &str) -> bool {
    // biubiu-YYYY-MM-DDTHH-MM-SS-mmmZ-xxxxxxxx.json
    if !name.starts_with("biubiu-") || !name.ends_with(".json") {
        return false;
    }
    let inner = &name[7..name.len() - 5];
    let Some((ts, hex_part)) = inner.rsplit_once('-') else {
        return false;
    };
    hex_part.len() == 8
        && hex_part.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
        && ts.len() == 24
        && ts.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 | 19 => b == b'-',
            10 => b == b'T',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        })
}
