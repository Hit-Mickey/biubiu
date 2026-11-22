use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use md5::{Digest, Md5};
use serde::Serialize;
use url::Url;

use crate::webdav::metadata::{decode_text_bytes, MAX_LYRIC_LENGTH};

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "m4a", "aac", "ogg", "wma", "aiff"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicItem {
    pub id: String,
    pub path: String,
    pub dir: String,
    pub title: String,
    pub size: u64,
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedLocalMusic {
    pub id: String,
    pub path: String,
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| AUDIO_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn canonical_path_for_id(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut s = canonical.to_string_lossy().to_string();
    if let Some(stripped) = s.strip_prefix("\\\\?\\") {
        s = stripped.to_string();
    }
    s.to_lowercase()
}

pub fn local_file_id(path: &Path) -> String {
    let canon = canonical_path_for_id(path);
    let mut hasher = Md5::new();
    hasher.update(canon.as_bytes());
    hex::encode(hasher.finalize())
}

fn list_dir_audio_files(dir: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_file() && is_audio_file(&path) {
            files.push(path);
        }
    }
    files
}

pub fn scan_local_music(dirs: Vec<String>) -> Vec<LocalMusicItem> {
    let mut items = Vec::new();
    for dir in dirs {
        for file in list_dir_audio_files(&dir) {
            let Ok(meta) = std::fs::metadata(&file) else {
                continue;
            };
            let id = local_file_id(&file);
            let format = file
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let fallback_title = file
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let mut title = fallback_title;
            let mut duration = None;
            if let Some(probe) = Probe::open(&file)
                .ok()
                .and_then(|p| p.guess_file_type().ok())
            {
                if let Ok(tagged) = probe.read() {
                    let secs = tagged.properties().duration().as_secs_f64();
                    if secs.is_finite() && secs > 0.0 {
                        duration = Some(secs);
                    }
                    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                        if let Some(t) = tag.title() {
                            let trimmed = t.trim();
                            if !trimmed.is_empty() {
                                title = trimmed.to_string();
                            }
                        }
                    }
                }
            }

            let created_time = meta
                .created()
                .or_else(|_| meta.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);

            items.push(LocalMusicItem {
                id,
                path: file.to_string_lossy().to_string(),
                dir: dir.clone(),
                title,
                size: meta.len(),
                format,
                duration,
                created_time,
            });
        }
    }
    items
}

pub fn resolve_local_music(ids: Vec<String>, dirs: Vec<String>) -> Vec<ResolvedLocalMusic> {
    let mut wanted: HashSet<String> = ids
        .into_iter()
        .filter(|id| id.len() == 32 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')))
        .collect();
    let mut out = Vec::new();
    if wanted.is_empty() {
        return out;
    }
    for dir in dirs {
        for file in list_dir_audio_files(&dir) {
            let id = local_file_id(&file);
            if wanted.remove(&id) {
                out.push(ResolvedLocalMusic {
                    id,
                    path: file.to_string_lossy().to_string(),
                });
            }
            if wanted.is_empty() {
                return out;
            }
        }
    }
    out
}

pub fn delete_local_music_file(file_path: &str, roots: &[String]) -> bool {
    let p = Path::new(file_path);
    if !p.is_file()
        || !is_audio_file(p)
        || !p
            .parent()
            .and_then(|parent| parent.canonicalize().ok())
            .is_some_and(|parent| {
                roots
                    .iter()
                    .any(|root| Path::new(root).canonicalize().ok().as_ref() == Some(&parent))
            })
    {
        return false;
    }
    std::fs::remove_file(p).is_ok()
}

pub fn file_url_to_path_candidates(audio_url: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !audio_url.starts_with("file://") {
        return out;
    }
    if let Ok(parsed) = Url::parse(audio_url) {
        if let Ok(p) = parsed.to_file_path() {
            out.push(p);
        }
    }
    let mut legacy = audio_url.strip_prefix("file://").unwrap_or("").to_string();
    if cfg!(target_os = "windows")
        && legacy.starts_with('/')
        && legacy.len() > 2
        && legacy.as_bytes()[2] == b':'
    {
        legacy = legacy[1..].to_string();
    }
    let legacy_path = PathBuf::from(legacy);
    if !out.contains(&legacy_path) {
        out.push(legacy_path);
    }
    out
}

pub fn read_local_lyrics(audio_url: &str, allowed_roots: &[String]) -> Option<String> {
    let canon_roots: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .collect();

    for candidate in file_url_to_path_candidates(audio_url) {
        if !candidate.is_absolute() || !is_audio_file(&candidate) {
            continue;
        }
        let Ok(audio_canon) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        if !audio_canon.is_file() {
            continue;
        }
        let Some(parent) = audio_canon.parent() else {
            continue;
        };
        if !canon_roots.iter().any(|r| r == parent) {
            continue;
        }

        // Check sidecar .spl then .lrc in the same directory
        for ext in ["spl", "lrc"] {
            let sidecar = audio_canon.with_extension(ext);
            if let Ok(sc_canon) = std::fs::canonicalize(&sidecar) {
                if sc_canon.parent() == Some(parent) {
                    if let Ok(meta) = std::fs::metadata(&sc_canon) {
                        if meta.is_file() && meta.len() > 0 && meta.len() <= MAX_LYRIC_LENGTH as u64
                        {
                            if let Ok(bytes) = std::fs::read(&sc_canon) {
                                let text = decode_text_bytes(&bytes);
                                if !text.is_empty() {
                                    return Some(text);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Fallback to embedded audio lyrics
        if let Some(probe) = Probe::open(&audio_canon)
            .ok()
            .and_then(|p| p.guess_file_type().ok())
        {
            if let Ok(tagged) = probe.read() {
                if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                    if let Some(lyric) = tag.get_string(&ItemKey::Lyrics) {
                        let trimmed = lyric.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.chars().take(MAX_LYRIC_LENGTH).collect());
                        }
                    }
                }
            }
        }
        return None;
    }
    None
}
