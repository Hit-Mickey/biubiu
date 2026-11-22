use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::audio_engine::NativeQueueTrack;
use crate::bili_http::{BiliHttpClient, BILI_ORIGIN, BILI_REFERER, USER_AGENT_STR};
use crate::storage::StorageManager;

struct Session {
    track_id: String,
    aid: String,
    cid: Option<String>,
    bvid: Option<String>,
    part: Option<i32>,
    id: String,
    started: i64,
    maximum: u64,
    last: Instant,
    paused: bool,
}

struct Request {
    path: &'static str,
    query: Value,
    form: Value,
}

pub struct PlayReporter {
    enabled: Arc<AtomicBool>,
    session: Mutex<Option<Session>>,
    requests: mpsc::Sender<Request>,
}

fn pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| {
            (
                k.clone(),
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string()),
            )
        })
        .collect()
}

impl PlayReporter {
    pub fn new(http: Arc<BiliHttpClient>, storage: &StorageManager) -> Self {
        let enabled = Arc::new(AtomicBool::new(
            storage
                .read_json("app-settings")
                .ok()
                .flatten()
                .and_then(|v| v.pointer("/appSettings/reportPlayHistory")?.as_bool())
                .unwrap_or(true),
        ));
        let gate = enabled.clone();
        let (requests, mut queue) = mpsc::channel::<Request>(32);
        tauri::async_runtime::spawn(async move {
            while let Some(req) = queue.recv().await {
                if !gate.load(Ordering::Acquire) {
                    continue;
                }
                let mut query = pairs(&req.query);
                let mut form = pairs(&req.form);
                if let Some(mid) = http.get_cookie("DedeUserID") {
                    if req.path.ends_with("heartbeat") {
                        query.push(("w_mid".into(), mid));
                    } else {
                        form.push(("mid".into(), mid));
                    }
                }
                if let Some(csrf) = http.get_cookie("bili_jct") {
                    form.push(("csrf".into(), csrf));
                }
                let signed = http.encode_params_wbi(query).await;
                if !gate.load(Ordering::Acquire) {
                    continue;
                }
                let _ = http
                    .client()
                    .post(format!("https://api.bilibili.com{}", req.path))
                    .query(&signed)
                    .form(&form)
                    .header("Origin", BILI_ORIGIN)
                    .header("Referer", BILI_REFERER)
                    .header("User-Agent", USER_AGENT_STR)
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await;
            }
        });
        Self {
            enabled,
            requests,
            session: Mutex::new(None),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
        if !enabled {
            self.session.lock().take();
        }
    }

    pub fn playing(&self, track: &NativeQueueTrack, position: f64, duration: f64) {
        if !self.enabled.load(Ordering::Acquire) {
            return;
        }
        let mut guard = self.session.lock();
        let Some(aid) = track.aid.as_ref().filter(|s| {
            s.parse::<u64>().is_ok()
                && track.track_type == "mv"
                && !matches!(track.source.as_deref(), Some("local" | "webdav"))
        }) else {
            guard.take();
            return;
        };
        let fresh = guard.as_ref().is_none_or(|s| s.track_id != track.id);
        if fresh {
            let s = Session {
                track_id: track.id.clone(),
                aid: aid.clone(),
                cid: track.cid.clone(),
                bvid: track.bvid.clone(),
                part: track.page_index,
                id: uuid::Uuid::new_v4().simple().to_string(),
                started: chrono::Utc::now().timestamp(),
                maximum: 0,
                last: Instant::now(),
                paused: false,
            };
            let _ = self.requests.try_send(Request { path: "/x/click-interface/click/web/h5",
                query: json!({"w_aid":s.aid,"w_part":s.part,"w_type":3,"w_ftime":s.started,"w_stime":s.started,"web_location":1315873}),
                form: json!({"aid":s.aid,"cid":s.cid,"part":s.part,"type":3,"sub_type":0,"ftime":s.started,"stime":s.started,
                    "session":s.id,"outer":0,"platform":"web","referer_url":s.bvid.as_ref().map(|id|format!("https://www.bilibili.com/video/{id}"))}) });
            *guard = Some(s);
        }
        if let Some(s) = guard.as_mut() {
            s.maximum = s.maximum.max(position as u64);
            let kind = if fresh {
                1
            } else if s.paused {
                3
            } else {
                0
            };
            if kind != 0 || s.last.elapsed() >= Duration::from_secs(30) {
                self.heartbeat(s, kind, position, duration);
            }
        }
    }

    pub fn finish(&self, ended: bool, position: f64, duration: f64) {
        let mut guard = self.session.lock();
        if let Some(s) = guard.as_mut() {
            if ended || !s.paused {
                self.heartbeat(s, if ended { 4 } else { 2 }, position, duration);
            }
        }
        if ended {
            guard.take();
        }
    }

    fn heartbeat(&self, s: &mut Session, kind: u8, position: f64, duration: f64) {
        let p = position as u64;
        let d = duration as u64;
        s.maximum = s.maximum.max(p);
        s.last = Instant::now();
        s.paused = kind == 2;
        let _ = self.requests.try_send(Request { path: "/x/click-interface/web/heartbeat",
            query: json!({"w_start_ts":s.started,"w_aid":s.aid,"w_dt":2,"w_realtime":p,"w_playedtime":p,
                "w_real_played_time":p,"w_video_duration":d,"w_last_play_progress_time":s.maximum,"web_location":1315873}),
            form: json!({"aid":s.aid,"cid":s.cid,"bvid":s.bvid,"session":s.id,"start_ts":s.started,"played_time":p,"realtime":p,
                "real_played_time":p,"video_duration":d,"last_play_progress_time":s.maximum,"max_play_progress_time":s.maximum,
                "dt":2,"outer":0,"play_type":kind}) });
    }
}
