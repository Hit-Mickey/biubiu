use std::collections::HashMap;
use std::io::Cursor;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use super::client::{read_limited_bytes, WebDavClient, WebDavEntry};

pub const MAX_LYRIC_LENGTH: usize = 512 * 1024;
const INITIAL_PROBE_BYTES: usize = 128 * 1024;
const MAX_PROBE_BYTES: usize = 2 * 1024 * 1024;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTrack {
    pub id: String,
    pub path: String,
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
    pub etag: Option<String>,
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
    #[serde(default)]
    pub has_cover: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyric_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags_version: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub metadata_parsed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedAudioTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub year: Option<u32>,
    pub disc: Option<u32>,
    pub track: Option<u32>,
    pub lossless: Option<bool>,
    pub cover: Option<(String, Vec<u8>)>,
    pub lyrics: Option<String>,
}

pub fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return cow.trim().to_string();
    }
    if bytes.len() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return cow.trim().to_string();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.trim_start_matches('\u{feff}').trim().to_string();
    }
    let (cow, _, _) = encoding_rs::GB18030.decode(bytes);
    cow.trim().to_string()
}

pub fn is_supported_audio_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp3"
            | "flac"
            | "wav"
            | "m4a"
            | "aac"
            | "ogg"
            | "oga"
            | "opus"
            | "wma"
            | "aiff"
            | "aif"
            | "webm"
    )
}

pub fn image_mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

pub fn file_stem_and_ext(filename: &str) -> (String, String) {
    if let Some(dot) = filename.rfind('.') {
        if dot > 0 && dot + 1 < filename.len() {
            return (
                filename[..dot].to_string(),
                filename[dot + 1..].to_ascii_lowercase(),
            );
        }
    }
    (filename.to_string(), String::new())
}

pub fn find_sidecars(entries: &[WebDavEntry]) -> HashMap<String, (Option<String>, Option<String>)> {
    let mut covers_by_stem: HashMap<String, String> = HashMap::new();
    let mut lyrics_by_stem: HashMap<String, (u8, String)> = HashMap::new();
    let mut folder_cover: Option<String> = None;

    for entry in entries {
        if entry.collection {
            continue;
        }
        let (stem, ext) = file_stem_and_ext(&entry.filename);
        let lower_stem = stem.to_ascii_lowercase();
        if image_mime_for_ext(&ext).is_some() {
            if matches!(lower_stem.as_str(), "cover" | "folder" | "front") && folder_cover.is_none()
            {
                folder_cover = Some(entry.path.clone());
            }
            covers_by_stem
                .entry(lower_stem)
                .or_insert_with(|| entry.path.clone());
        } else if ext == "spl" || ext == "lrc" {
            let prio = if ext == "spl" { 2 } else { 1 };
            match lyrics_by_stem.get(&lower_stem) {
                Some((old_p, _)) if *old_p >= prio => {}
                _ => {
                    lyrics_by_stem.insert(lower_stem, (prio, entry.path.clone()));
                }
            }
        }
    }

    let mut out = HashMap::new();
    for entry in entries {
        if entry.collection {
            continue;
        }
        let (stem, ext) = file_stem_and_ext(&entry.filename);
        if !is_supported_audio_ext(&ext) {
            continue;
        }
        let lower_stem = stem.to_ascii_lowercase();
        let cover = covers_by_stem
            .get(&lower_stem)
            .cloned()
            .or_else(|| folder_cover.clone());
        let lyric = lyrics_by_stem.get(&lower_stem).map(|(_, p)| p.clone());
        out.insert(entry.path.clone(), (cover, lyric));
    }
    out
}

pub fn parse_tags_from_bytes(bytes: &[u8], format_hint: &str) -> ParsedAudioTags {
    parse_tags_from_bytes_checked(bytes, format_hint).0
}

fn parse_tags_from_bytes_checked(bytes: &[u8], format_hint: &str) -> (ParsedAudioTags, bool) {
    let mut result = ParsedAudioTags::default();
    let is_lossless_ext = matches!(format_hint, "flac" | "wav" | "aiff" | "aif");
    if is_lossless_ext {
        result.lossless = Some(true);
    }

    let cursor = Cursor::new(bytes);
    let Ok(probe) = Probe::new(cursor).guess_file_type() else {
        return (result, false);
    };
    let Ok(tagged) = probe.read() else {
        return (result, false);
    };

    let dur = tagged.properties().duration().as_secs_f64();
    if dur.is_finite() && dur > 0.0 {
        result.duration = Some((dur * 100.0).round() / 100.0);
    }

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        result.title = tag
            .title()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        result.artist = tag
            .artist()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        result.album = tag
            .album()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        result.year = tag.year();
        result.disc = tag.disk();
        result.track = tag.track();

        if let Some(pic) = tag.pictures().first() {
            let mime = pic
                .mime_type()
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| "image/jpeg".to_string());
            if !pic.data().is_empty() && pic.data().len() <= 8 * 1024 * 1024 {
                result.cover = Some((mime, pic.data().to_vec()));
            }
        }

        if let Some(lyric) = tag.get_string(&ItemKey::Lyrics) {
            let trimmed = lyric.trim();
            if !trimmed.is_empty() {
                let truncated: String = trimmed.chars().take(MAX_LYRIC_LENGTH).collect();
                result.lyrics = Some(truncated);
            }
        }
    }

    (result, true)
}

async fn fetch_probe_bytes(
    client: &WebDavClient,
    path: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "Range",
        HeaderValue::from_str(&format!("bytes=0-{}", max_bytes.saturating_sub(1))).unwrap(),
    );
    headers.insert("Accept-Encoding", HeaderValue::from_static("identity"));

    let resp = client
        .request(path, Method::GET, Some(headers), None, false)
        .await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    read_limited_bytes(resp, max_bytes, true).await
}

pub async fn read_remote_audio_tags(
    client: &WebDavClient,
    track: &StoredTrack,
) -> Result<ParsedAudioTags, String> {
    let initial_len = track
        .size
        .map_or(INITIAL_PROBE_BYTES, |s| {
            (s as usize).min(INITIAL_PROBE_BYTES)
        })
        .max(1);
    let first_bytes = fetch_probe_bytes(client, &track.path, initial_len).await?;
    let (first_parsed, parsed_ok) = parse_tags_from_bytes_checked(&first_bytes, &track.format);
    let reached_eof = track.size.is_some_and(|s| (first_bytes.len() as u64) >= s)
        || first_bytes.len() < initial_len;
    let suspicious_mp3_duration =
        track.format == "mp3" && !reached_eof && first_parsed.duration.is_some_and(|d| d < 10.0);
    if reached_eof || (parsed_ok && !suspicious_mp3_duration) {
        return Ok(first_parsed);
    }

    let fallback_len = track
        .size
        .map_or(MAX_PROBE_BYTES, |s| (s as usize).min(MAX_PROBE_BYTES))
        .max(initial_len);
    if fallback_len <= first_bytes.len() {
        return Ok(first_parsed);
    }
    let full_bytes = fetch_probe_bytes(client, &track.path, fallback_len).await?;
    Ok(parse_tags_from_bytes(&full_bytes, &track.format))
}

pub async fn read_cover_file(
    client: &WebDavClient,
    path: &str,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let ext = path.rsplit('.').next().unwrap_or("");
    let Some(mime) = image_mime_for_ext(ext) else {
        return Ok(None);
    };
    let resp = client.request(path, Method::GET, None, None, false).await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let bytes = read_limited_bytes(resp, 8 * 1024 * 1024, false).await?;
    if bytes.is_empty() {
        Ok(None)
    } else {
        Ok(Some((mime.to_string(), bytes)))
    }
}

pub async fn read_lyric_file(client: &WebDavClient, path: &str) -> Result<Option<String>, String> {
    let resp = client.request(path, Method::GET, None, None, false).await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let bytes = read_limited_bytes(resp, MAX_LYRIC_LENGTH, false).await?;
    let text = decode_text_bytes(&bytes);
    if text.is_empty() {
        Ok(None)
    } else {
        Ok(Some(text))
    }
}
