use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use parking_lot::Mutex;
use reqwest::header::{CONTENT_TYPE, ORIGIN, REFERER, USER_AGENT};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::bili_http::USER_AGENT_STR;
use crate::storage::StorageManager;
use crate::webdav::metadata::MAX_LYRIC_LENGTH;

static QQ_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

#[derive(PartialEq, Eq)]
pub enum LyricSource {
    Local(String),
    WebDav(String),
    Bilibili(String),
}

type LyricSlot = Arc<tokio::sync::Mutex<Option<Value>>>;

struct PlaybackEntry {
    id: String,
    source: LyricSource,
    value: LyricSlot,
}

#[derive(Default)]
struct PlaybackCache {
    revision: u64,
    entry: Option<PlaybackEntry>,
}

#[derive(Default)]
pub struct PlaybackLyrics(Mutex<PlaybackCache>);

impl PlaybackLyrics {
    pub fn retain_track(&self, id: Option<&str>) {
        let mut cache = self.0.lock();
        if cache
            .entry
            .as_ref()
            .is_some_and(|entry| Some(entry.id.as_str()) != id)
        {
            cache.entry = None;
        }
    }

    // The per-song lock coalesces reads across windows. Switching songs detaches an
    // outstanding read so a slow server cannot block or overwrite the new song.
    pub async fn read(
        &self,
        id: &str,
        source: LyricSource,
        load: impl Future<Output = Result<Option<Value>, String>>,
    ) -> Result<(u64, Option<Value>), String> {
        let (revision, slot) = {
            let mut cache = self.0.lock();
            if !cache
                .entry
                .as_ref()
                .is_some_and(|e| e.id == id && e.source == source)
            {
                cache.revision += 1;
                cache.entry = Some(PlaybackEntry {
                    id: id.to_owned(),
                    source,
                    value: LyricSlot::default(),
                });
            }
            (cache.revision, cache.entry.as_ref().unwrap().value.clone())
        };
        let mut value = slot.lock().await;
        if value.is_none() {
            *value = load.await?;
        }
        Ok((revision, value.clone()))
    }

    pub async fn save_subtitles(&self, revision: u64, lines: Vec<Value>) {
        if lines.is_empty() {
            return;
        }
        let slot = {
            let cache = self.0.lock();
            cache
                .entry
                .as_ref()
                .filter(|entry| {
                    cache.revision == revision && matches!(entry.source, LyricSource::Bilibili(_))
                })
                .map(|entry| entry.value.clone())
        };
        if let Some(slot) = slot {
            slot.lock().await.get_or_insert(Value::Array(lines));
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SearchNeteaseParams {
    pub s: String,
    #[serde(rename = "type")]
    pub search_type: i32,
    pub limit: i32,
    pub offset: i32,
}

#[derive(Debug, Deserialize)]
pub struct GetNeteaseLyricsParams {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct SearchLrclibParams {
    pub q: String,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct QQLyricSong {
    pub mid: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: i64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricText {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t_lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roma_lyrics: Option<String>,
}

pub fn assert_lyrics_key(key: &str) -> Result<(), String> {
    let Some((left, right)) = key.split_once('-') else {
        return Err("无效的歌曲标识".to_string());
    };
    let valid_part = |s: &str, max: usize| {
        !s.is_empty()
            && s.len() <= max
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if !valid_part(left, 100) || !valid_part(right, 128) {
        return Err("无效的歌曲标识".to_string());
    }
    Ok(())
}

pub fn update_track_lyrics(
    storage: &StorageManager,
    key: &str,
    change: Value,
) -> Result<Value, String> {
    assert_lyrics_key(key)?;
    let mut next: Map<String, Value> = storage
        .get_track_lyrics(key)?
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let change_type = change.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match change_type {
        "preferences" => {
            if let Some(offset) = change.get("offset").and_then(|v| v.as_f64()) {
                if offset.is_finite() {
                    let clamped = offset.clamp(-5000.0, 5000.0);
                    let val = if clamped.fract() == 0.0 {
                        json!(clamped as i64)
                    } else {
                        json!(clamped)
                    };
                    next.insert("offset".to_string(), val);
                }
            }
            if let Some(font_size) = change.get("fontSize").and_then(|v| v.as_f64()) {
                if font_size.is_finite() {
                    let clamped = font_size.clamp(12.0, 48.0);
                    let val = if clamped.fract() == 0.0 {
                        json!(clamped as i64)
                    } else {
                        json!(clamped)
                    };
                    next.insert("fontSize".to_string(), val);
                }
            }
        }
        "adopt" => {
            let text = change
                .get("text")
                .and_then(|v| v.as_object())
                .ok_or_else(|| "无效的歌词操作".to_string())?;
            let mut parsed = Map::new();
            for field in ["lyrics", "tLyrics", "romaLyrics"] {
                if let Some(val) = text.get(field) {
                    if val.is_null() {
                        continue;
                    }
                    let Some(s) = val.as_str() else {
                        return Err("歌词内容过长或格式无效".to_string());
                    };
                    if s.is_empty() {
                        continue;
                    }
                    if s.len() > MAX_LYRIC_LENGTH {
                        return Err("歌词内容过长或格式无效".to_string());
                    }
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        parsed.insert(field.to_string(), Value::String(trimmed.to_string()));
                    }
                }
            }
            if !parsed.contains_key("lyrics") {
                return Err("请填写歌词原文".to_string());
            }
            next.remove("edited");
            next.remove("lyrics");
            next.remove("tLyrics");
            next.remove("romaLyrics");
            for (k, v) in parsed {
                next.insert(k, v);
            }
        }
        _ => return Err("无效的歌词操作".to_string()),
    }

    let record = Value::Object(next);
    storage.set_track_lyrics(key, &record)?;
    Ok(record)
}

pub async fn search_netease(client: &Client, params: SearchNeteaseParams) -> Result<Value, String> {
    let resp = client
        .get("https://interface.music.163.com/api/search/get")
        .query(&[
            ("s", params.s),
            ("type", params.search_type.to_string()),
            ("limit", params.limit.to_string()),
            ("offset", params.offset.to_string()),
        ])
        .header(REFERER, "https://music.163.com/")
        .header(ORIGIN, "https://music.163.com")
        .header(USER_AGENT, USER_AGENT_STR)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

pub async fn get_netease_lyrics(
    client: &Client,
    params: GetNeteaseLyricsParams,
) -> Result<Value, String> {
    let resp = client
        .get("https://interface.music.163.com/api/song/lyric")
        .query(&[
            ("id", params.id.to_string()),
            ("tv", "-1".to_string()),
            ("lv", "-1".to_string()),
            ("rv", "-1".to_string()),
            ("kv", "-1".to_string()),
            ("yv", "-1".to_string()),
            ("_nmclfl", "1".to_string()),
        ])
        .header(REFERER, "https://music.163.com/")
        .header(ORIGIN, "https://music.163.com")
        .header(USER_AGENT, USER_AGENT_STR)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

pub async fn search_lrclib(client: &Client, params: SearchLrclibParams) -> Result<Value, String> {
    let mut query: Vec<(&str, String)> = vec![("q", params.q)];
    if let Some(t) = params.track_name {
        query.push(("track_name", t));
    }
    if let Some(a) = params.artist_name {
        query.push(("artist_name", a));
    }
    if let Some(al) = params.album_name {
        query.push(("album_name", al));
    }
    let resp = client
        .get("https://lrclib.net/api/search")
        .query(&query)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

struct QQGuard;
impl Drop for QQGuard {
    fn drop(&mut self) {
        QQ_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

fn acquire_qq_slot() -> Result<QQGuard, String> {
    let prev = QQ_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    if prev >= 2 {
        QQ_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        return Err("请稍后再试".to_string());
    }
    Ok(QQGuard)
}

fn is_valid_qq_mid(mid: &str) -> bool {
    !mid.is_empty() && mid.len() <= 32 && mid.chars().all(|c| c.is_ascii_alphanumeric())
}

pub async fn search_qq(client: &Client, keyword: &str) -> Result<Vec<QQLyricSong>, String> {
    let trimmed = keyword.trim();
    if trimmed.is_empty() || keyword.len() > 128 {
        return Ok(Vec::new());
    }
    let _guard = acquire_qq_slot()?;
    let payload = json!({
        "comm": { "ct": "19", "cv": "1859", "uin": "0" },
        "req": {
            "module": "music.search.SearchCgiService",
            "method": "DoSearchForQQMusicDesktop",
            "param": {
                "query": trimmed,
                "page_num": 1,
                "num_per_page": 12,
                "grp": 1,
                "search_type": 0
            }
        }
    });
    let resp = client
        .post("https://u.y.qq.com/cgi-bin/musicu.fcg")
        .header(REFERER, "https://y.qq.com/")
        .header(CONTENT_TYPE, "application/json")
        .body(payload.to_string())
        .timeout(Duration::from_secs(7))
        .send()
        .await
        .map_err(|_| "QQ 音乐暂不可用".to_string())?;
    if !resp.status().is_success() {
        return Err("QQ 音乐暂不可用".to_string());
    }
    let data: Value = resp
        .json()
        .await
        .map_err(|_| "QQ 音乐暂不可用".to_string())?;
    if data.pointer("/req/code").and_then(|v| v.as_i64()) != Some(0) {
        return Err("QQ 音乐搜索失败".to_string());
    }
    let list = data
        .pointer("/req/data/body/song/list")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for song in list.into_iter().take(12) {
        let Some(mid) = song.get("mid").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(name) = song.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if !is_valid_qq_mid(mid) {
            continue;
        }
        let album = song
            .pointer("/album/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let artist = song
            .get("singer")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" / ")
            })
            .unwrap_or_default();
        let duration = song.get("interval").and_then(|v| v.as_i64()).unwrap_or(0);
        out.push(QQLyricSong {
            mid: mid.to_string(),
            title: name.to_string(),
            artist,
            album,
            duration,
        });
    }
    Ok(out)
}

pub async fn get_qq_lyrics(client: &Client, mid: &str) -> Result<LyricText, String> {
    if !is_valid_qq_mid(mid) {
        return Err("无效的 QQ 歌曲 ID".to_string());
    }
    let _guard = acquire_qq_slot()?;
    let resp = client
        .get("https://i.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg")
        .query(&[
            ("songmid", mid),
            ("format", "json"),
            ("nobase64", "0"),
            ("g_tk", "5381"),
        ])
        .header(REFERER, "https://y.qq.com/")
        .timeout(Duration::from_secs(7))
        .send()
        .await
        .map_err(|_| "QQ 音乐暂不可用".to_string())?;
    if !resp.status().is_success() {
        return Err("QQ 音乐暂不可用".to_string());
    }
    let data: Value = resp
        .json()
        .await
        .map_err(|_| "QQ 音乐暂不可用".to_string())?;
    decode_qq_lyrics(&data)
}

fn decode_qq_lyrics(data: &Value) -> Result<LyricText, String> {
    if data.get("retcode").and_then(|v| v.as_i64()) != Some(0) {
        return Err("QQ 音乐歌词暂不可用".to_string());
    }
    let decode_b64 = |field: &str| -> Option<String> {
        let raw = data.get(field)?.as_str()?;
        if raw.len() > 1024 * 1024 {
            return None;
        }
        let bytes = STANDARD.decode(raw).ok()?;
        let text = String::from_utf8(bytes).ok()?;
        let truncated: String = text.chars().take(MAX_LYRIC_LENGTH).collect();
        let trimmed = truncated.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    Ok(LyricText {
        lyrics: decode_b64("lyric"),
        t_lyrics: decode_b64("trans"),
        roma_lyrics: decode_b64("roma"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn windows_share_a_pending_read_and_only_keep_the_current_track() {
        let cache = PlaybackLyrics::default();
        let calls = AtomicUsize::new(0);
        let read = || {
            cache.read("a", LyricSource::WebDav("list".into()), async {
                calls.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
                Ok(Some(json!("A")))
            })
        };
        let (first, second) = tokio::join!(read(), read());
        assert_eq!(first.unwrap(), second.unwrap());
        cache.retain_track(Some("a"));
        assert_eq!(read().await.unwrap().1, Some(json!("A")));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        cache.retain_track(Some("b"));
        let source = || LyricSource::Local("b.lrc".into());
        assert!(cache
            .read("b", source(), async { Err("offline".into()) })
            .await
            .is_err());
        assert_eq!(
            cache
                .read("b", source(), async { Ok(None) })
                .await
                .unwrap()
                .1,
            None
        );
        assert_eq!(
            cache
                .read("b", source(), async { Ok(Some(json!("B"))) })
                .await
                .unwrap()
                .1,
            Some(json!("B"))
        );
        cache.retain_track(None);
        read().await.unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn a_late_lyric_read_or_subtitle_write_cannot_replace_the_current_song() {
        let cache = PlaybackLyrics::default();
        let (start, started) = tokio::sync::oneshot::channel();
        let (finish, waiting) = tokio::sync::oneshot::channel();
        let old = cache.read("old", LyricSource::WebDav("list".into()), async {
            start.send(()).unwrap();
            waiting.await.unwrap();
            Ok(Some(json!("old lyric")))
        });
        let new = async {
            started.await.unwrap();
            let source = || LyricSource::Bilibili("part1".into());
            let (old_revision, _) = cache
                .read("video", source(), async { Ok(None) })
                .await
                .unwrap();
            cache.retain_track(None);
            let (revision, _) = cache
                .read("video", source(), async { Ok(None) })
                .await
                .unwrap();
            cache
                .save_subtitles(old_revision, vec![json!("stale")])
                .await;
            assert_eq!(
                cache
                    .read("video", source(), async { Ok(None) })
                    .await
                    .unwrap()
                    .1,
                None
            );
            cache
                .save_subtitles(revision, vec![json!("new lyric")])
                .await;
            finish.send(()).unwrap();
        };
        let (old_result, ()) = tokio::join!(old, new);
        assert_eq!(old_result.unwrap().1, Some(json!("old lyric")));
        assert_eq!(
            cache
                .read("video", LyricSource::Bilibili("part1".into()), async {
                    Ok(None)
                })
                .await
                .unwrap()
                .1,
            Some(json!(["new lyric"]))
        );
    }
    #[test]
    fn qq_lyrics_preserve_timing_and_ignore_invalid_optional_fields() {
        let lrc = "[00:01.00]原文";
        let data = json!({"retcode":0, "lyric": STANDARD.encode(lrc), "trans": STANDARD.encode("翻译"), "roma":"%%"});
        let lyric = decode_qq_lyrics(&data).unwrap();
        assert_eq!(lyric.lyrics.as_deref(), Some(lrc));
        assert_eq!(lyric.t_lyrics.as_deref(), Some("翻译"));
        assert!(lyric.roma_lyrics.is_none());
        assert!(decode_qq_lyrics(&json!({"retcode":1})).is_err());
    }
}
