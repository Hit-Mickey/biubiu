use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use parking_lot::{Mutex, RwLock};
use reqwest::header::{ORIGIN, RANGE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::bili_http::{BiliHttpClient, BILI_ORIGIN, BILI_REFERER, USER_AGENT_STR};
use crate::storage::StorageManager;

const CHUNK_SIZE: u64 = 10 * 1024 * 1024;
const MAX_CONCURRENT_TASKS: usize = 3;
const MAX_CONCURRENT_CHUNKS: usize = 4;
const AUDIO_QUALITY_SORT: [u64; 8] = [30257, 30216, 30259, 30260, 30232, 30280, 30250, 30251];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDownloadChunk {
    #[serde(rename = "type")]
    pub chunk_type: String,
    pub name: String,
    pub start: u64,
    pub end: u64,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDownloadTask {
    pub id: String,
    #[serde(default = "default_output_type")]
    pub output_file_type: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bvid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cid: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codecs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_bandwidth: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_frame_rate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_path: Option<String>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub convert_progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDownloadTaskInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default = "default_output_type")]
    pub output_file_type: String,
    #[serde(default)]
    pub title: String,
    pub cover: Option<String>,
    pub bvid: Option<String>,
    pub cid: Option<Value>,
    pub sid: Option<Value>,
    pub created_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullMediaDownloadTask {
    pub id: String,
    #[serde(default = "default_output_type")]
    pub output_file_type: String,
    #[serde(default)]
    pub title: String,
    pub cover: Option<String>,
    pub created_time: Option<i64>,
    pub bvid: Option<String>,
    pub cid: Option<Value>,
    pub sid: Option<Value>,
    pub audio_url: Option<String>,
    pub audio_codecs: Option<String>,
    pub audio_bandwidth: Option<u64>,
    pub video_url: Option<String>,
    pub video_resolution: Option<String>,
    pub video_frame_rate: Option<String>,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub audio_total_bytes: u64,
    #[serde(default)]
    pub video_total_bytes: u64,
    #[serde(default)]
    pub downloaded_bytes: u64,
    #[serde(default)]
    pub download_progress: u32,
    #[serde(default)]
    pub merge_progress: u32,
    #[serde(default)]
    pub convert_progress: u32,
    #[serde(default = "default_status")]
    pub status: String,
    pub file_name: Option<String>,
    pub temp_dir: Option<String>,
    pub save_dir: Option<String>,
    pub save_path: Option<String>,
    pub audio_temp_path: Option<String>,
    pub video_temp_path: Option<String>,
    #[serde(default)]
    pub chunks: Vec<MediaDownloadChunk>,
    pub error: Option<String>,
}

impl FullMediaDownloadTask {
    fn to_public(&self) -> MediaDownloadTask {
        MediaDownloadTask {
            id: self.id.clone(),
            output_file_type: self.output_file_type.clone(),
            title: self.title.clone(),
            cover: self.cover.clone(),
            bvid: self.bvid.clone(),
            cid: self.cid.clone(),
            sid: self.sid.clone(),
            audio_codecs: self.audio_codecs.clone(),
            audio_bandwidth: self.audio_bandwidth,
            video_resolution: self.video_resolution.clone(),
            video_frame_rate: self.video_frame_rate.clone(),
            save_path: self.save_path.clone(),
            status: self.status.clone(),
            total_bytes: if self.total_bytes > 0 {
                Some(self.total_bytes)
            } else {
                None
            },
            download_progress: Some(self.download_progress),
            merge_progress: Some(self.merge_progress),
            convert_progress: Some(self.convert_progress),
            created_time: self.created_time,
            error: self.error.clone(),
        }
    }

    fn audio_ext(&self) -> &'static str {
        let codecs = self.audio_codecs.as_deref().unwrap_or("").to_lowercase();
        if codecs.contains("flac") {
            ".flac"
        } else if codecs.contains("mp3") {
            ".mp3"
        } else {
            ".m4a"
        }
    }

    fn video_ext(&self) -> &'static str {
        let codecs = self.audio_codecs.as_deref().unwrap_or("").to_lowercase();
        if codecs.contains("flac") {
            ".mkv"
        } else {
            ".mp4"
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BroadcastPayload {
    #[serde(rename = "type")]
    pub payload_type: &'static str,
    pub data: Vec<MediaDownloadTask>,
}

fn default_output_type() -> String {
    "audio".to_string()
}

fn default_status() -> String {
    "waiting".to_string()
}

pub struct DownloadManager {
    storage: Arc<StorageManager>,
    http: Arc<BiliHttpClient>,
    ffmpeg_path: RwLock<PathBuf>,
    app_handle: RwLock<Option<AppHandle>>,
    order: RwLock<Vec<String>>,
    tasks: RwLock<HashMap<String, FullMediaDownloadTask>>,
    cancels: Mutex<HashMap<String, CancellationToken>>,
    semaphore: Arc<Semaphore>,
    last_broadcast: Mutex<Instant>,
}

impl DownloadManager {
    pub fn new(
        storage: Arc<StorageManager>,
        http: Arc<BiliHttpClient>,
        ffmpeg_path: PathBuf,
    ) -> Arc<Self> {
        let mgr = Arc::new(Self {
            storage,
            http,
            ffmpeg_path: RwLock::new(ffmpeg_path),
            app_handle: RwLock::new(None),
            order: RwLock::new(Vec::new()),
            tasks: RwLock::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_TASKS)),
            last_broadcast: Mutex::new(Instant::now() - Duration::from_secs(10)),
        });
        mgr.load_persisted_tasks();
        mgr
    }

    pub fn set_app_handle(&self, app: AppHandle) {
        *self.app_handle.write() = Some(app);
    }

    pub fn set_ffmpeg_path(&self, path: PathBuf) {
        *self.ffmpeg_path.write() = path;
    }

    fn load_persisted_tasks(&self) {
        let Ok(Some(raw)) = self.storage.read_json("media-downloads") else {
            return;
        };
        let Some(root) = raw.as_object() else {
            return;
        };

        let mut loaded: Vec<FullMediaDownloadTask> = Vec::new();
        if let Some(nested) = root.get("downloads").and_then(|v| v.as_object()) {
            for value in nested.values() {
                if let Ok(mut task) = serde_json::from_value::<FullMediaDownloadTask>(value.clone())
                {
                    normalize_restored_status(&mut task);
                    loaded.push(task);
                }
            }
        }
        for (key, value) in root {
            if key.starts_with("downloads.") {
                if let Ok(mut task) = serde_json::from_value::<FullMediaDownloadTask>(value.clone())
                {
                    normalize_restored_status(&mut task);
                    loaded.push(task);
                }
            }
        }

        loaded.sort_by_key(|t| t.created_time.unwrap_or(0));
        let mut order = self.order.write();
        let mut map = self.tasks.write();
        for task in loaded {
            if !map.contains_key(&task.id) {
                order.push(task.id.clone());
                map.insert(task.id.clone(), task);
            }
        }
    }

    pub fn get_task_list(&self) -> Vec<MediaDownloadTask> {
        let order = self.order.read();
        let tasks = self.tasks.read();
        order
            .iter()
            .filter_map(|id| tasks.get(id).map(|t| t.to_public()))
            .collect()
    }

    pub fn add_task(self: &Arc<Self>, input: MediaDownloadTaskInput) {
        self.add_tasks(vec![input]);
    }

    pub fn add_tasks(self: &Arc<Self>, inputs: Vec<MediaDownloadTaskInput>) {
        #[cfg(desktop)]
        let default_dir = self
            .storage
            .get_download_dir()
            .to_string_lossy()
            .to_string();
        #[cfg(target_os = "android")]
        let default_dir = self
            .storage
            .get_app_setting_string("downloadPath")
            .filter(|dir| dir.starts_with("content://"))
            .unwrap_or_default();
        let mut to_schedule = Vec::new();
        {
            let mut order = self.order.write();
            let mut tasks = self.tasks.write();
            for input in inputs {
                let id = input
                    .id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| safe_component(s))
                    .map(ToString::to_string)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                if tasks.contains_key(&id) {
                    continue;
                }
                let title = if input.title.trim().is_empty() {
                    format!("biu下载-{}", id)
                } else {
                    input.title.trim().to_string()
                };
                let task = FullMediaDownloadTask {
                    id: id.clone(),
                    output_file_type: if input.output_file_type == "video" {
                        "video".to_string()
                    } else {
                        "audio".to_string()
                    },
                    title,
                    cover: input.cover,
                    created_time: Some(
                        input
                            .created_time
                            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
                    ),
                    bvid: input.bvid,
                    cid: input.cid,
                    sid: input.sid,
                    audio_url: None,
                    audio_codecs: None,
                    audio_bandwidth: None,
                    video_url: None,
                    video_resolution: None,
                    video_frame_rate: None,
                    total_bytes: 0,
                    audio_total_bytes: 0,
                    video_total_bytes: 0,
                    downloaded_bytes: 0,
                    download_progress: 0,
                    merge_progress: 0,
                    convert_progress: 0,
                    status: "waiting".to_string(),
                    file_name: None,
                    temp_dir: None,
                    save_dir: Some(default_dir.clone()),
                    save_path: None,
                    audio_temp_path: None,
                    video_temp_path: None,
                    chunks: Vec::new(),
                    error: None,
                };
                order.push(id.clone());
                tasks.insert(id.clone(), task);
                to_schedule.push(id);
            }
        }

        if !to_schedule.is_empty() {
            self.broadcast_full();
            for id in to_schedule {
                self.spawn_task(id, false);
            }
        }
    }

    pub fn pause_task(&self, id: &str) {
        if let Some(cancel) = self.cancels.lock().remove(id) {
            cancel.cancel();
        }
        let mut updated = None;
        if let Some(task) = self.tasks.write().get_mut(id) {
            match task.status.as_str() {
                "downloading" | "waiting" => task.status = "downloadPaused".to_string(),
                "merging" => task.status = "mergePaused".to_string(),
                "converting" => task.status = "convertPaused".to_string(),
                _ => {}
            }
            updated = Some(task.to_public());
        }
        if let Some(item) = updated {
            self.broadcast_update(vec![item], true);
        }
    }

    pub fn resume_task(self: &Arc<Self>, id: &str) {
        let can_resume = self
            .tasks
            .read()
            .get(id)
            .map(|t| {
                matches!(
                    t.status.as_str(),
                    "downloadPaused" | "mergePaused" | "convertPaused"
                )
            })
            .unwrap_or(false);
        if can_resume {
            self.spawn_task(id.to_string(), true);
        }
    }

    pub fn retry_task(self: &Arc<Self>, id: &str) {
        if let Some(cancel) = self.cancels.lock().remove(id) {
            cancel.cancel();
        }
        let found = if let Some(task) = self.tasks.write().get_mut(id) {
            task.status = "waiting".to_string();
            task.error = None;
            task.download_progress = 0;
            task.merge_progress = 0;
            task.convert_progress = 0;
            task.downloaded_bytes = 0;
            true
        } else {
            false
        };
        if found {
            self.broadcast_full();
            self.spawn_task(id.to_string(), false);
        }
    }

    pub async fn cancel_task(&self, id: &str) {
        if let Some(cancel) = self.cancels.lock().remove(id) {
            cancel.cancel();
        }
        let removed = {
            self.order.write().retain(|x| x != id);
            self.tasks.write().remove(id)
        };
        if let Some(task) = removed {
            cleanup_temp_dir(task.temp_dir.as_deref(), &self.storage).await;
        }
        self.broadcast_full();
        self.save_tasks_snapshot();
    }

    pub async fn clear_tasks(&self) {
        let cancels: Vec<CancellationToken> = self.cancels.lock().drain().map(|(_, c)| c).collect();
        for c in cancels {
            c.cancel();
        }
        let removed: Vec<FullMediaDownloadTask> = {
            self.order.write().clear();
            self.tasks.write().drain().map(|(_, t)| t).collect()
        };
        for task in removed {
            cleanup_temp_dir(task.temp_dir.as_deref(), &self.storage).await;
        }
        let _ = self.storage.clear_json("media-downloads");
        self.broadcast_full();
    }

    pub fn quit_and_save(&self) {
        let cancels: Vec<CancellationToken> = self.cancels.lock().drain().map(|(_, c)| c).collect();
        for c in cancels {
            c.cancel();
        }
        self.save_tasks_snapshot();
    }

    fn save_tasks_snapshot(&self) {
        let order = self.order.read();
        let tasks = self.tasks.read();
        let mut downloads_map = serde_json::Map::new();
        for id in order.iter() {
            if let Some(task) = tasks.get(id) {
                let mut saved = task.clone();
                normalize_restored_status(&mut saved);
                if let Ok(val) = serde_json::to_value(saved) {
                    downloads_map.insert(id.clone(), val);
                }
            }
        }
        let root = serde_json::json!({ "downloads": downloads_map });
        let _ = self.storage.write_json("media-downloads", &root);
    }

    fn broadcast_full(&self) {
        let Some(app) = self.app_handle.read().clone() else {
            return;
        };
        let payload = BroadcastPayload {
            payload_type: "full",
            data: self.get_task_list(),
        };
        let _ = app.emit("download://sync", payload);
    }

    fn broadcast_update(&self, items: Vec<MediaDownloadTask>, force: bool) {
        if items.is_empty() {
            return;
        }
        {
            let mut last = self.last_broadcast.lock();
            if !force && last.elapsed() < Duration::from_millis(250) {
                return;
            }
            *last = Instant::now();
        }
        let Some(app) = self.app_handle.read().clone() else {
            return;
        };
        let payload = BroadcastPayload {
            payload_type: "update",
            data: items,
        };
        let _ = app.emit("download://sync", payload);
    }

    fn spawn_task(self: &Arc<Self>, id: String, is_resume: bool) {
        let token = CancellationToken::new();
        if let Some(old) = self.cancels.lock().insert(id.clone(), token.clone()) {
            old.cancel();
        }
        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let permit = tokio::select! {
                _ = token.cancelled() => return,
                res = mgr.semaphore.clone().acquire_owned() => match res {
                    Ok(p) => p,
                    Err(_) => return,
                },
            };
            let _permit = permit;
            if token.is_cancelled() {
                return;
            }

            let res = mgr.run_task(&id, is_resume, &token).await;
            mgr.cancels.lock().remove(&id);

            if let Err(err) = res {
                if !token.is_cancelled() {
                    let mut updated = None;
                    if let Some(task) = mgr.tasks.write().get_mut(&id) {
                        if !matches!(
                            task.status.as_str(),
                            "downloadPaused" | "mergePaused" | "convertPaused"
                        ) {
                            task.status = "failed".to_string();
                            task.error = Some(err);
                            updated = Some(task.to_public());
                        }
                    }
                    if let Some(item) = updated {
                        mgr.broadcast_update(vec![item], true);
                    }
                }
            }
            mgr.save_tasks_snapshot();
        });
    }

    async fn run_task(
        &self,
        id: &str,
        is_resume: bool,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let mut task = self
            .tasks
            .read()
            .get(id)
            .cloned()
            .ok_or_else(|| "下载任务不存在".to_string())?;

        if task.cid.is_none() && task.sid.is_none() {
            if let Some(bvid) = task.bvid.clone() {
                let view = self.http.get_web_interface_view(&bvid).await?;
                if let Some(first_page) = view
                    .get("data")
                    .and_then(|d| d.get("pages"))
                    .and_then(|p| p.as_array())
                    .and_then(|arr| arr.first())
                {
                    if let Some(cid) = first_page.get("cid") {
                        task.cid = Some(cid.clone());
                        self.sync_task(&task, false);
                    }
                }
            }
        }

        let start_stage = if is_resume {
            task.status.clone()
        } else {
            "downloadPaused".to_string()
        };

        if start_stage != "mergePaused" && start_stage != "convertPaused" {
            task.status = "downloading".to_string();
            task.error = None;
            self.sync_task(&task, true);

            let need_url = (task.output_file_type == "audio"
                && !is_url_valid(task.audio_url.as_deref()))
                || (task.output_file_type == "video"
                    && (!is_url_valid(task.video_url.as_deref())
                        || (task.audio_codecs.is_some()
                            && !is_url_valid(task.audio_url.as_deref()))));
            if need_url {
                self.resolve_download_urls(&mut task).await?;
                self.sync_task(&task, true);
            }

            if cancel.is_cancelled() {
                return Ok(());
            }

            self.resolve_content_lengths(&mut task).await?;

            let temp_dir = download_temp_root(&self.storage).join(&task.id);
            tokio::fs::create_dir_all(&temp_dir)
                .await
                .map_err(|e| format!("创建临时目录失败: {e}"))?;

            task.temp_dir = Some(temp_dir.to_string_lossy().to_string());
            if task.audio_total_bytes > 0 {
                task.audio_temp_path =
                    Some(temp_dir.join("audio.m4s").to_string_lossy().to_string());
            }
            if task.output_file_type == "video" {
                task.video_temp_path =
                    Some(temp_dir.join("video.m4s").to_string_lossy().to_string());
            }

            let expected_total: u64 = task.chunks.iter().map(|c| c.end - c.start + 1).sum();
            if task.chunks.is_empty() || expected_total != task.total_bytes {
                task.chunks.clear();
                if task.audio_total_bytes > 0 {
                    build_chunks(&mut task.chunks, "audio", task.audio_total_bytes);
                }
                if task.output_file_type == "video" && task.video_total_bytes > 0 {
                    build_chunks(&mut task.chunks, "video", task.video_total_bytes);
                }
            }
            self.sync_task(&task, true);

            self.download_chunks(&mut task, &temp_dir, cancel).await?;
            if cancel.is_cancelled() {
                return Ok(());
            }
        }

        if start_stage != "convertPaused" {
            task.status = "merging".to_string();
            self.sync_task(&task, true);
            self.merge_chunks(&mut task, cancel).await?;
            if cancel.is_cancelled() {
                return Ok(());
            }
        }

        task.status = "converting".to_string();
        self.sync_task(&task, true);
        self.convert_with_ffmpeg(&mut task, cancel).await?;
        if cancel.is_cancelled() {
            return Ok(());
        }

        cleanup_temp_dir(task.temp_dir.as_deref(), &self.storage).await;
        task.chunks.clear();
        task.download_progress = 100;
        task.merge_progress = 100;
        task.convert_progress = 100;
        task.status = "completed".to_string();
        task.error = None;
        self.sync_task(&task, true);
        Ok(())
    }

    fn sync_task(&self, task: &FullMediaDownloadTask, force_emit: bool) {
        let public = task.to_public();
        if let Some(entry) = self.tasks.write().get_mut(&task.id) {
            *entry = task.clone();
        }
        self.broadcast_update(vec![public], force_emit);
    }

    async fn resolve_download_urls(&self, task: &mut FullMediaDownloadTask) -> Result<(), String> {
        if let Some(sid) = task.sid.as_ref().and_then(value_to_string) {
            let (mid, vip_status) = self.read_user_mid_and_vip();
            let res = self
                .http
                .get_audio_web_stream_url(&sid, mid, vip_status)
                .await?;
            if let Some(data) = res.get("data") {
                if let Some(cdn) = data
                    .get("cdns")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|v| v.as_str())
                {
                    let stream_type = data.get("type").and_then(|t| t.as_i64()).unwrap_or(0);
                    task.audio_url = Some(cdn.to_string());
                    task.audio_codecs =
                        Some(if stream_type == 3 { "flac" } else { "aac" }.to_string());
                    task.audio_bandwidth = Some(stream_audio_bandwidth(stream_type));
                }
            }
        } else if let (Some(bvid), Some(cid)) = (
            task.bvid.as_deref(),
            task.cid.as_ref().and_then(value_to_string),
        ) {
            let dash_res = self.http.get_dash_playurl(bvid, &cid, 4048).await?;
            let dash = dash_res
                .get("data")
                .and_then(|d| d.get("dash"))
                .ok_or_else(|| "无法获取 DASH 媒体流".to_string())?;

            let mut audio_list: Vec<&Value> = dash
                .get("audio")
                .and_then(|a| a.as_array())
                .map(|arr| arr.iter().collect())
                .unwrap_or_default();
            audio_list.sort_by(|a, b| {
                let bw_a = a.get("bandwidth").and_then(|v| v.as_u64()).unwrap_or(0);
                let bw_b = b.get("bandwidth").and_then(|v| v.as_u64()).unwrap_or(0);
                if bw_a != bw_b {
                    return bw_b.cmp(&bw_a);
                }
                let idx_a = a
                    .get("id")
                    .and_then(|v| v.as_u64())
                    .and_then(|id| AUDIO_QUALITY_SORT.iter().position(|x| *x == id));
                let idx_b = b
                    .get("id")
                    .and_then(|v| v.as_u64())
                    .and_then(|id| AUDIO_QUALITY_SORT.iter().position(|x| *x == id));
                match (idx_a, idx_b) {
                    (None, None) => std::cmp::Ordering::Equal,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (Some(ia), Some(ib)) => ib.cmp(&ia),
                }
            });

            let flac_audio = dash
                .get("flac")
                .and_then(|f| f.get("audio"))
                .filter(|v| !v.is_null());
            let dolby_audio = dash
                .get("dolby")
                .and_then(|d| d.get("audio"))
                .and_then(|a| a.as_array())
                .and_then(|arr| arr.first());
            let chosen_audio = flac_audio
                .or(dolby_audio)
                .or_else(|| audio_list.first().copied());

            if let Some(a) = chosen_audio {
                task.audio_url = extract_dash_url(a);
                task.audio_codecs = a
                    .get("codecs")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string);
                task.audio_bandwidth = a.get("bandwidth").and_then(|v| v.as_u64());
            }

            if task.output_file_type == "video" {
                if let Some(best_video) = dash
                    .get("video")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.first())
                {
                    task.video_url = extract_dash_url(best_video);
                    let w = best_video
                        .get("width")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let h = best_video
                        .get("height")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    if w > 0 && h > 0 {
                        task.video_resolution = Some(format!("{w}*{h}"));
                    }
                    let fps = best_video
                        .get("frameRate")
                        .or_else(|| best_video.get("frame_rate"))
                        .and_then(|v| {
                            v.as_str()
                                .map(|s| s.to_string())
                                .or_else(|| v.as_f64().map(|f| f.to_string()))
                        });
                    if let Some(fps_str) = fps {
                        if let Ok(num) = fps_str.parse::<f64>() {
                            task.video_frame_rate = Some((num.floor() as i64).to_string());
                        }
                    }
                }
            }
        }

        if task.output_file_type == "audio" && task.audio_url.is_none() {
            return Err("无法获取音频下载地址".to_string());
        }
        if task.output_file_type == "video" && task.video_url.is_none() {
            return Err("无法获取视频下载地址".to_string());
        }
        Ok(())
    }

    fn read_user_mid_and_vip(&self) -> (i64, i64) {
        let info = self.storage.read_json("user-login-info").ok().flatten();
        let mid = info
            .as_ref()
            .and_then(|v| {
                v.get("mid")
                    .or_else(|| v.get("userInfo").and_then(|u| u.get("mid")))
            })
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let vip = info
            .as_ref()
            .and_then(|v| {
                v.get("vipStatus")
                    .or_else(|| v.get("userInfo").and_then(|u| u.get("vipStatus")))
            })
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        (mid, vip)
    }

    async fn resolve_content_lengths(
        &self,
        task: &mut FullMediaDownloadTask,
    ) -> Result<(), String> {
        task.total_bytes = 0;
        if let Some(url) = task.audio_url.as_deref() {
            let len = self.fetch_content_length(url).await?;
            if len == 0 {
                return Err("无法获取音频文件大小".to_string());
            }
            task.audio_total_bytes = len;
            task.total_bytes += len;
        }
        if task.output_file_type == "video" {
            if let Some(url) = task.video_url.as_deref() {
                let len = self.fetch_content_length(url).await?;
                if len == 0 {
                    return Err("无法获取视频文件大小".to_string());
                }
                task.video_total_bytes = len;
                task.total_bytes += len;
            }
        }
        Ok(())
    }

    async fn fetch_content_length(&self, url: &str) -> Result<u64, String> {
        let client = self.http.client();
        if let Ok(resp) = client
            .head(url)
            .header(REFERER, BILI_REFERER)
            .header(ORIGIN, BILI_ORIGIN)
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(12))
            .send()
            .await
        {
            if let Some(len) = resp.content_length().filter(|l| *l > 0) {
                return Ok(len);
            }
            if let Some(val) = resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|l| *l > 0)
            {
                return Ok(val);
            }
        }

        let resp = client
            .get(url)
            .header(REFERER, BILI_REFERER)
            .header(ORIGIN, BILI_ORIGIN)
            .header(USER_AGENT, USER_AGENT_STR)
            .header(RANGE, "bytes=0-0")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("请求文件大小失败: {e}"))?;

        if let Some(cr) = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
        {
            if let Some(total) = cr.split('/').nth(1).and_then(|s| s.parse::<u64>().ok()) {
                return Ok(total);
            }
        }

        resp.content_length()
            .filter(|l| *l > 0)
            .ok_or_else(|| "无法解析文件大小".to_string())
    }

    async fn download_chunks(
        &self,
        task: &mut FullMediaDownloadTask,
        temp_dir: &Path,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let mut initial_bytes = 0u64;
        for chunk in &mut task.chunks {
            let chunk_path = temp_dir.join(&chunk.name);
            let expected = chunk.end - chunk.start + 1;
            if let Ok(meta) = tokio::fs::metadata(&chunk_path).await {
                if meta.len() == expected {
                    chunk.done = true;
                    initial_bytes += expected;
                } else {
                    chunk.done = false;
                    if meta.len() > expected {
                        tokio::fs::remove_file(&chunk_path)
                            .await
                            .map_err(|e| e.to_string())?;
                    } else {
                        initial_bytes += meta.len();
                    }
                }
            } else {
                chunk.done = false;
            }
        }

        let downloaded_counter = Arc::new(std::sync::atomic::AtomicU64::new(initial_bytes));
        task.downloaded_bytes = initial_bytes;
        task.download_progress = percent(initial_bytes, task.total_bytes);
        self.sync_task(task, true);

        let chunk_sem = Arc::new(Semaphore::new(MAX_CONCURRENT_CHUNKS));
        let mut handles = tokio::task::JoinSet::new();
        let total_bytes = task.total_bytes;

        for (idx, chunk) in task.chunks.iter().cloned().enumerate() {
            if chunk.done {
                continue;
            }
            let url = if chunk.chunk_type == "video" {
                task.video_url
                    .clone()
                    .ok_or_else(|| "缺少视频链接".to_string())?
            } else {
                task.audio_url
                    .clone()
                    .ok_or_else(|| "缺少音频链接".to_string())?
            };
            let chunk_path = temp_dir.join(&chunk.name);
            let client = self.http.client();
            let sem = chunk_sem.clone();
            let cancel_c = cancel.clone();
            let counter = downloaded_counter.clone();
            let tasks_map = self.tasks.read().get(&task.id).cloned();
            let app_handle = self.app_handle.read().clone();

            handles.spawn(async move {
                let _permit = tokio::select! {
                    _ = cancel_c.cancelled() => return Ok::<usize, String>(idx),
                    p = sem.acquire_owned() => p.map_err(|e| e.to_string())?,
                };
                if cancel_c.is_cancelled() {
                    return Ok(idx);
                }

                let existing_len = tokio::fs::metadata(&chunk_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                let expected = chunk.end - chunk.start + 1;
                if existing_len >= expected {
                    return Ok(idx);
                }

                let mut received = existing_len;
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&chunk_path)
                    .await
                    .map_err(|e| format!("打开分块文件失败: {e}"))?;

                let mut last_err = String::new();
                for attempt in 0..3 {
                    if cancel_c.is_cancelled() {
                        return Ok(idx);
                    }
                    let range_start = chunk.start + received;
                    let req = client
                        .get(&url)
                        .header(REFERER, BILI_REFERER)
                        .header(ORIGIN, BILI_ORIGIN)
                        .header(USER_AGENT, USER_AGENT_STR)
                        .header(RANGE, format!("bytes={}-{}", range_start, chunk.end))
                        .timeout(Duration::from_secs(30));

                    match req.send().await {
                        Ok(resp)
                            if (resp.status().as_u16() == 206
                                && resp
                                    .headers()
                                    .get("content-range")
                                    .and_then(|h| h.to_str().ok())
                                    .and_then(|s| s.split('/').next())
                                    == Some(
                                        format!("bytes {range_start}-{}", chunk.end).as_str(),
                                    ))
                                || (resp.status().as_u16() == 200
                                    && range_start == 0
                                    && resp.content_length() == Some(expected)) =>
                        {
                            let mut stream = resp.bytes_stream();
                            let mut last_emit = Instant::now();
                            let mut ok = true;
                            while let Some(item) = tokio::select! {
                                _ = cancel_c.cancelled() => None,
                                next = stream.next() => next,
                            } {
                                match item {
                                    Ok(bytes) => {
                                        if bytes.len() as u64 > expected - received {
                                            return Err("下载分块长度不匹配".to_string());
                                        }
                                        file.write_all(&bytes)
                                            .await
                                            .map_err(|e| format!("写入分块失败: {e}"))?;
                                        received += bytes.len() as u64;
                                        let done_total = counter.fetch_add(
                                            bytes.len() as u64,
                                            std::sync::atomic::Ordering::Relaxed,
                                        ) + bytes.len() as u64;
                                        if last_emit.elapsed() >= Duration::from_millis(300) {
                                            last_emit = Instant::now();
                                            if let (Some(app), Some(mut t)) =
                                                (&app_handle, tasks_map.clone())
                                            {
                                                t.downloaded_bytes = done_total;
                                                t.download_progress =
                                                    percent(done_total, total_bytes);
                                                t.status = "downloading".to_string();
                                                let _ = app.emit(
                                                    "download://sync",
                                                    BroadcastPayload {
                                                        payload_type: "update",
                                                        data: vec![t.to_public()],
                                                    },
                                                );
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        last_err = e.to_string();
                                        ok = false;
                                        break;
                                    }
                                }
                            }
                            if cancel_c.is_cancelled() {
                                return Ok(idx);
                            }
                            if ok && received == expected {
                                file.flush().await.map_err(|e| e.to_string())?;
                                return Ok(idx);
                            }
                        }
                        Ok(resp) => {
                            last_err = format!("HTTP {}", resp.status().as_u16());
                        }
                        Err(e) => {
                            last_err = e.to_string();
                        }
                    }

                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(400 * (attempt + 1) as u64)).await;
                    }
                }
                Err(format!("分块 {} 下载失败: {}", chunk.name, last_err))
            });
        }

        while let Some(result) = handles.join_next().await {
            let res = result.map_err(|e| e.to_string())??;
            if !cancel.is_cancelled() {
                if let Some(c) = task.chunks.get_mut(res) {
                    c.done = true;
                }
            }
        }

        let final_downloaded = downloaded_counter.load(std::sync::atomic::Ordering::Relaxed);
        task.downloaded_bytes = final_downloaded;
        task.download_progress = percent(final_downloaded, task.total_bytes);
        self.sync_task(task, true);
        Ok(())
    }

    async fn merge_chunks(
        &self,
        task: &mut FullMediaDownloadTask,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let temp_dir = PathBuf::from(
            task.temp_dir
                .as_deref()
                .ok_or_else(|| "缺少临时目录".to_string())?,
        );
        let mut merged_bytes = 0u64;
        if let Some(p) = task.audio_temp_path.as_deref() {
            if let Ok(m) = tokio::fs::metadata(p).await {
                merged_bytes += m.len();
            }
        }
        if let Some(p) = task.video_temp_path.as_deref() {
            if let Ok(m) = tokio::fs::metadata(p).await {
                merged_bytes += m.len();
            }
        }
        task.merge_progress = percent(merged_bytes, task.total_bytes);
        self.sync_task(task, true);

        if let Some(audio_dest) = task.audio_temp_path.clone() {
            self.merge_chunks_for_type(
                task,
                "audio",
                &temp_dir,
                Path::new(&audio_dest),
                &mut merged_bytes,
                cancel,
            )
            .await?;
        }
        if cancel.is_cancelled() {
            return Ok(());
        }
        if let Some(video_dest) = task.video_temp_path.clone() {
            self.merge_chunks_for_type(
                task,
                "video",
                &temp_dir,
                Path::new(&video_dest),
                &mut merged_bytes,
                cancel,
            )
            .await?;
        }
        if cancel.is_cancelled() {
            return Ok(());
        }

        for chunk in &task.chunks {
            let _ = tokio::fs::remove_file(temp_dir.join(&chunk.name)).await;
        }
        task.chunks.clear();
        task.merge_progress = 100;
        self.sync_task(task, true);
        Ok(())
    }

    async fn merge_chunks_for_type(
        &self,
        task: &mut FullMediaDownloadTask,
        chunk_type: &str,
        temp_dir: &Path,
        dest_path: &Path,
        merged_bytes: &mut u64,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let chunks: Vec<MediaDownloadChunk> = task
            .chunks
            .iter()
            .filter(|c| c.chunk_type == chunk_type)
            .cloned()
            .collect();
        if chunks.is_empty() {
            return Ok(());
        }

        let mut start_idx = 0usize;
        if let Ok(meta) = tokio::fs::metadata(dest_path).await {
            let existing = meta.len();
            let mut acc = 0u64;
            for (i, c) in chunks.iter().enumerate() {
                let sz = c.end - c.start + 1;
                if existing >= acc + sz {
                    acc += sz;
                    start_idx = i + 1;
                } else {
                    if let Ok(file) = tokio::fs::OpenOptions::new()
                        .write(true)
                        .open(dest_path)
                        .await
                    {
                        let _ = file.set_len(acc).await;
                    } else {
                        let _ = tokio::fs::remove_file(dest_path).await;
                        start_idx = 0;
                    }
                    break;
                }
            }
        }

        if start_idx >= chunks.len() {
            return Ok(());
        }

        let mut out = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dest_path)
            .await
            .map_err(|e| format!("打开合并目标失败: {e}"))?;

        let mut buf = vec![0u8; 256 * 1024];
        for chunk in &chunks[start_idx..] {
            if cancel.is_cancelled() {
                return Ok(());
            }
            let chunk_path = temp_dir.join(&chunk.name);
            let mut reader = tokio::fs::File::open(&chunk_path)
                .await
                .map_err(|e| format!("读取分块 {} 失败: {e}", chunk.name))?;
            loop {
                if cancel.is_cancelled() {
                    return Ok(());
                }
                let n = reader.read(&mut buf).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                *merged_bytes += n as u64;
                task.merge_progress = percent(*merged_bytes, task.total_bytes);
                self.sync_task(task, false);
            }
        }
        out.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn convert_with_ffmpeg(
        &self,
        task: &mut FullMediaDownloadTask,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        #[cfg(target_os = "android")]
        let save_dir = self.storage.get_download_dir();
        #[cfg(desktop)]
        let save_dir = task
            .save_dir
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.storage.get_download_dir());
        tokio::fs::create_dir_all(&save_dir)
            .await
            .map_err(|e| format!("创建下载目录失败: {e}"))?;

        let sanitized = sanitize_filename(&task.title);
        let ext = if task.output_file_type == "video" {
            task.video_ext()
        } else {
            task.audio_ext()
        };
        let desired = save_dir.join(format!("{sanitized}{ext}"));
        let final_output = available_output_path(&desired);

        let ffmpeg = self.ffmpeg_path.read().clone();
        let mut cmd = tokio::process::Command::new(&ffmpeg);
        cmd.arg("-y");

        if task.output_file_type == "video" {
            let video_tmp = task
                .video_temp_path
                .as_deref()
                .ok_or_else(|| "缺少视频临时文件".to_string())?;
            cmd.args(["-i", video_tmp]);
            if let Some(audio_tmp) = task.audio_temp_path.as_deref() {
                if Path::new(audio_tmp).is_file() {
                    cmd.args(["-i", audio_tmp, "-c:v", "copy", "-c:a", "copy", "-shortest"]);
                } else {
                    cmd.args(["-c:v", "copy"]);
                }
            } else {
                cmd.args(["-c:v", "copy"]);
            }
        } else {
            let audio_tmp = task
                .audio_temp_path
                .as_deref()
                .ok_or_else(|| "缺少音频临时文件".to_string())?;
            cmd.args(["-i", audio_tmp, "-c:a", "copy"]);
        }

        cmd.arg(&final_output)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 FFmpeg ({}) 失败: {e}", ffmpeg.display()))?;

        let status = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = tokio::fs::remove_file(&final_output).await;
                return Ok(());
            }
            res = child.wait() => res.map_err(|e| e.to_string())?,
        };

        if !status.success() {
            let mut stderr_msg = String::new();
            if let Some(mut err_pipe) = child.stderr.take() {
                let _ = err_pipe.read_to_string(&mut stderr_msg).await;
            }
            let tail = stderr_msg
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("FFmpeg 转换失败");
            return Err(format!("FFmpeg 转换失败: {tail}"));
        }

        #[cfg(desktop)]
        let saved = final_output.to_string_lossy().into_owned();
        #[cfg(target_os = "android")]
        let saved = {
            // Older tasks stored their private staging path instead of a document tree URI.
            let directory = match task.save_dir.as_deref() {
                Some(path) if Path::new(path).is_absolute() => {
                    self.storage.get_app_setting_string("downloadPath")
                }
                value => value.map(str::to_owned),
            };
            let published = crate::android::call::<String>(
                "publishDownload",
                serde_json::json!({
                    "path":final_output,"directory":directory
                }),
            )
            .await;
            if !matches!(&published, Ok(path) if Path::new(path) == final_output) {
                let _ = tokio::fs::remove_file(&final_output).await;
            }
            published?
        };
        task.save_path = Some(saved);
        task.file_name = final_output
            .file_name()
            .and_then(|n| n.to_str())
            .map(ToString::to_string);
        task.convert_progress = 100;
        self.sync_task(task, true);
        Ok(())
    }
}

fn normalize_restored_status(task: &mut FullMediaDownloadTask) {
    task.status = match task.status.as_str() {
        "downloading" | "waiting" => "downloadPaused".to_string(),
        "merging" => "mergePaused".to_string(),
        "converting" => "convertPaused".to_string(),
        other => other.to_string(),
    };
}

fn value_to_string(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    } else if let Some(n) = v.as_i64() {
        return Some(n.to_string());
    } else if let Some(n) = v.as_u64() {
        return Some(n.to_string());
    }
    None
}

fn extract_dash_url(val: &Value) -> Option<String> {
    val.get("baseUrl")
        .or_else(|| val.get("base_url"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            val.get("backupUrl")
                .or_else(|| val.get("backup_url"))
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
        })
}

fn stream_audio_bandwidth(stream_type: i64) -> u64 {
    match stream_type {
        0 => 128_000,
        1 => 192_000,
        2 => 320_000,
        _ => 0,
    }
}

fn is_url_valid(url: Option<&str>) -> bool {
    let Some(raw) = url else {
        return false;
    };
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    let now_secs = chrono::Utc::now().timestamp();
    for (k, v) in parsed.query_pairs() {
        if k == "deadline" {
            if let Ok(deadline) = v.parse::<i64>() {
                return deadline - 60 > now_secs;
            }
        }
    }
    true
}

fn build_chunks(out: &mut Vec<MediaDownloadChunk>, chunk_type: &str, total_size: u64) {
    let mut start = 0u64;
    let mut idx = 0usize;
    while start < total_size {
        let end = (start + CHUNK_SIZE - 1).min(total_size - 1);
        out.push(MediaDownloadChunk {
            chunk_type: chunk_type.to_string(),
            name: format!("{chunk_type}_chunk_{idx}"),
            start,
            end,
            done: false,
        });
        start = end + 1;
        idx += 1;
    }
}

fn percent(done: u64, total: u64) -> u32 {
    if total == 0 {
        return 0;
    }
    ((done as f64 / total as f64) * 100.0)
        .round()
        .clamp(0.0, 100.0) as u32
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "biubiu-download".to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

fn available_output_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..10000 {
        let candidate = dir.join(format!("{stem} ({i}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

fn safe_component(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn download_temp_root(_storage: &StorageManager) -> PathBuf {
    #[cfg(target_os = "android")]
    let base = _storage.data_dir().to_path_buf();
    #[cfg(desktop)]
    let base = std::env::temp_dir();
    base.join("biu-temp-downloader")
}

async fn cleanup_temp_dir(dir: Option<&str>, storage: &StorageManager) {
    if let Some(d) = dir {
        let path = Path::new(d);
        let root = download_temp_root(storage);
        if path.parent() == Some(root.as_path())
            && path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(safe_component)
        {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
    }
}
