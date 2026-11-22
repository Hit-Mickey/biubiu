use std::collections::HashMap;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::StreamExt;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, Response};
use url::Url;

const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'[')
    .add(b']');

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:creationdate/>
    <D:getetag/>
  </D:prop>
</D:propfind>"#;

#[derive(Debug, Clone)]
pub struct WebDavEntry {
    pub path: String,
    pub filename: String,
    pub collection: bool,
    pub size: Option<u64>,
    pub modified_at: Option<i64>,
    pub created_at: Option<i64>,
    pub etag: Option<String>,
}

#[derive(Debug)]
pub struct WebDavHttpError {
    pub status: u16,
    pub message: String,
}

impl WebDavHttpError {
    pub fn new(status: u16) -> Self {
        let message = match status {
            401 => "WebDAV 认证失败，请检查用户名和密码".to_string(),
            403 => "无权访问该 WebDAV 资源".to_string(),
            404 => "WebDAV 路径不存在".to_string(),
            405 => "WebDAV 服务器不支持该操作".to_string(),
            _ => format!("WebDAV 请求失败（HTTP {status}）"),
        };
        Self { status, message }
    }
}

impl std::fmt::Display for WebDavHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub fn audio_mime_type(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "flac" => Some("audio/flac"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "opus" => Some("audio/opus"),
        "wma" => Some("audio/x-ms-wma"),
        "aiff" | "aif" => Some("audio/aiff"),
        "webm" => Some("audio/webm"),
        _ => None,
    }
}

pub fn normalize_webdav_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请填写 WebDAV 服务器地址".to_string());
    }
    let mut parsed = Url::parse(trimmed).map_err(|_| "WebDAV 服务器地址格式无效".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("WebDAV 服务器地址仅支持 http 或 https".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("请在独立字段填写用户名和密码，不要包含在地址中".to_string());
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    let mut path = parsed.path().to_string();
    if !path.ends_with('/') {
        path.push('/');
    }
    parsed.set_path(&path);
    Ok(parsed.to_string())
}

pub fn resolve_webdav_directory(base: &Url, dir: &str) -> String {
    let mut base_path = base.path().to_string();
    if !base_path.ends_with('/') {
        base_path.push('/');
    }
    let cleaned = dir.trim().replace('\\', "/");
    let segments: Vec<String> = cleaned
        .split('/')
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .map(|s| utf8_percent_encode(s, PATH_SEGMENT_ENCODE_SET).to_string())
        .collect();
    if segments.is_empty() {
        base_path
    } else {
        format!("{base_path}{}/", segments.join("/"))
    }
}

pub fn decode_path_segment(seg: &str) -> String {
    percent_decode_str(seg).decode_utf8_lossy().to_string()
}

pub fn relative_folder(root_dir: &str, file_path: &str) -> String {
    let rel = file_path.strip_prefix(root_dir).unwrap_or(file_path);
    if let Some(idx) = rel.rfind('/') {
        rel[..idx]
            .split('/')
            .filter(|s| !s.is_empty())
            .map(decode_path_segment)
            .collect::<Vec<_>>()
            .join("/")
    } else {
        String::new()
    }
}

#[derive(Clone)]
pub struct WebDavClient {
    pub base: Url,
    client: Client,
    authorization: Option<String>,
}

impl WebDavClient {
    pub fn new(client: Client, url: &str, username: &str, password: &str) -> Result<Self, String> {
        let normalized = normalize_webdav_url(url)?;
        let base = Url::parse(&normalized).map_err(|_| "WebDAV 地址无效".to_string())?;
        let authorization = if !username.is_empty() {
            Some(format!(
                "Basic {}",
                STANDARD.encode(format!("{username}:{password}"))
            ))
        } else {
            None
        };
        Ok(Self {
            base,
            client,
            authorization,
        })
    }

    pub async fn request(
        &self,
        path: &str,
        method: Method,
        extra_headers: Option<HeaderMap>,
        body: Option<Vec<u8>>,
        streaming: bool,
    ) -> Result<Response, String> {
        let mut current = self.base.clone();
        current.set_path(path);
        if !current.path().starts_with(self.base.path()) {
            return Err("WebDAV 路径超出服务器目录".to_string());
        }

        let mut headers = extra_headers.unwrap_or_default();
        if let Some(auth) = &self.authorization {
            if let Ok(val) = HeaderValue::from_str(auth) {
                headers.insert(AUTHORIZATION, val);
            }
        }

        for _ in 0..=5 {
            let mut builder = self
                .client
                .request(method.clone(), current.clone())
                .headers(headers.clone());
            if let Some(ref b) = body {
                builder = builder.body(b.clone());
            }
            if !streaming {
                builder = builder.timeout(Duration::from_secs(30));
            }
            let resp = builder.send().await.map_err(|e| {
                if e.is_timeout() {
                    "连接 WebDAV 超时，请检查服务器地址及网络".to_string()
                } else {
                    "无法连接 WebDAV 服务器，请检查地址及网络".to_string()
                }
            })?;

            let status = resp.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                    let next = current
                        .join(loc)
                        .map_err(|_| "无法跟随 WebDAV 服务器重定向".to_string())?;
                    if !matches!(next.scheme(), "http" | "https")
                        || !next.username().is_empty()
                        || next.password().is_some()
                    {
                        return Err("无法跟随 WebDAV 服务器重定向".to_string());
                    }
                    let same_origin = next.origin() == current.origin();
                    let secure_upgrade = current.scheme() == "http"
                        && next.scheme() == "https"
                        && current.host_str() == next.host_str()
                        && current.port() == next.port();
                    if !same_origin && !secure_upgrade {
                        if method != Method::GET && method != Method::HEAD {
                            return Err("无法跟随 WebDAV 服务器重定向".to_string());
                        }
                        headers.remove(AUTHORIZATION);
                    }
                    if matches!(method.as_str(), "DELETE" | "PUT" | "MKCOL")
                        && next.path() != current.path()
                    {
                        return Err("无法跟随 WebDAV 服务器重定向".to_string());
                    }
                    current = next;
                    continue;
                }
            }
            return Ok(resp);
        }

        Err("无法跟随 WebDAV 服务器重定向".to_string())
    }

    pub async fn list(&self, directory: &str) -> Result<Vec<WebDavEntry>, WebDavHttpError> {
        let mut headers = HeaderMap::new();
        headers.insert("Depth", HeaderValue::from_static("1"));
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/xml; charset=utf-8"),
        );
        let method = Method::from_bytes(b"PROPFIND").unwrap();
        let resp = self
            .request(
                directory,
                method,
                Some(headers),
                Some(PROPFIND_BODY.as_bytes().to_vec()),
                false,
            )
            .await
            .map_err(|m| WebDavHttpError {
                status: 0,
                message: m,
            })?;
        let status = resp.status().as_u16();
        if !resp.status().is_success() && status != 207 {
            return Err(WebDavHttpError::new(status));
        }
        let final_url = resp.url().clone();
        let bytes = read_limited_bytes(resp, 32 * 1024 * 1024, false)
            .await
            .map_err(|m| WebDavHttpError {
                status: 0,
                message: m,
            })?;
        let xml = crate::webdav::metadata::decode_text_bytes(&bytes);
        Ok(parse_propfind_xml(&xml, &self.base, directory, &final_url))
    }

    pub async fn remove(&self, path: &str) -> Result<(), String> {
        let resp = self
            .request(path, Method::DELETE, None, None, false)
            .await?;
        let status = resp.status().as_u16();
        if status == 404 {
            return Ok(());
        }
        if !resp.status().is_success() {
            return Err(WebDavHttpError::new(status).message);
        }
        if status == 207 {
            return Err("WebDAV 返回了部分删除结果，请更新列表确认文件状态".to_string());
        }
        Ok(())
    }
}

pub async fn read_limited_bytes(
    resp: Response,
    limit: usize,
    truncate: bool,
) -> Result<Vec<u8>, String> {
    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let remaining = limit.saturating_sub(out.len());
        if chunk.len() > remaining {
            if truncate {
                out.extend_from_slice(&chunk[..remaining]);
                break;
            } else {
                return Err("WebDAV 返回的数据过大".to_string());
            }
        }
        out.extend_from_slice(&chunk);
        if truncate && out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn local_tag_name(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    s.rsplit(':').next().unwrap_or(&s).to_ascii_lowercase()
}

fn parse_http_or_iso_date(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(trimmed) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp_millis());
    }
    None
}

fn parse_propfind_xml(
    xml: &str,
    base: &Url,
    requested_dir: &str,
    response_url: &Url,
) -> Vec<WebDavEntry> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut in_response = false;
    let mut in_propstat = false;
    let mut in_resourcetype = false;
    let mut current_tag = String::new();

    let mut href = String::new();
    let mut propstat_ok = true;
    let mut ps_collection = false;
    let mut ps_size: Option<u64> = None;
    let mut ps_modified: Option<i64> = None;
    let mut ps_created: Option<i64> = None;
    let mut ps_etag: Option<String> = None;
    let mut ps_displayname: Option<String> = None;

    let mut resp_collection = false;
    let mut resp_size: Option<u64> = None;
    let mut resp_modified: Option<i64> = None;
    let mut resp_created: Option<i64> = None;
    let mut resp_etag: Option<String> = None;
    let mut resp_displayname: Option<String> = None;

    let mut found: HashMap<String, WebDavEntry> = HashMap::new();
    let req_norm = requested_dir.trim_end_matches('/');
    let base_norm = base.path();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "response" => {
                        in_response = true;
                        href.clear();
                        resp_collection = false;
                        resp_size = None;
                        resp_modified = None;
                        resp_created = None;
                        resp_etag = None;
                        resp_displayname = None;
                    }
                    "propstat" if in_response => {
                        in_propstat = true;
                        propstat_ok = true;
                        ps_collection = false;
                        ps_size = None;
                        ps_modified = None;
                        ps_created = None;
                        ps_etag = None;
                        ps_displayname = None;
                    }
                    "resourcetype" if in_propstat => {
                        in_resourcetype = true;
                    }
                    "collection" if in_resourcetype => {
                        ps_collection = true;
                    }
                    _ => {
                        current_tag = tag;
                    }
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = local_tag_name(e.name().as_ref());
                if tag == "collection" && in_resourcetype {
                    ps_collection = true;
                }
            }
            Ok(Event::Text(ref e)) => {
                if !in_response {
                    buf.clear();
                    continue;
                }
                let text = e.unescape().map(|s| s.to_string()).unwrap_or_default();
                match current_tag.as_str() {
                    "href" if !in_propstat => href.push_str(&text),
                    "status" if in_propstat => {
                        if !text.contains(" 200 ") && !text.contains(" 200") {
                            propstat_ok = false;
                        }
                    }
                    "getcontentlength" if in_propstat => {
                        if let Ok(v) = text.trim().parse::<u64>() {
                            ps_size = Some(v);
                        }
                    }
                    "getlastmodified" if in_propstat => {
                        ps_modified = parse_http_or_iso_date(&text);
                    }
                    "creationdate" if in_propstat => {
                        ps_created = parse_http_or_iso_date(&text);
                    }
                    "getetag" if in_propstat => {
                        let t = text.trim();
                        if !t.is_empty() {
                            ps_etag = Some(t.to_string());
                        }
                    }
                    "displayname" if in_propstat => {
                        let t = text.trim();
                        if !t.is_empty() {
                            ps_displayname = Some(t.to_string());
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = local_tag_name(e.name().as_ref());
                match tag.as_str() {
                    "resourcetype" => in_resourcetype = false,
                    "propstat" => {
                        if propstat_ok {
                            resp_collection |= ps_collection;
                            if ps_size.is_some() {
                                resp_size = ps_size;
                            }
                            if ps_modified.is_some() {
                                resp_modified = ps_modified;
                            }
                            if ps_created.is_some() {
                                resp_created = ps_created;
                            }
                            if ps_etag.is_some() {
                                resp_etag = ps_etag.take();
                            }
                            if ps_displayname.is_some() {
                                resp_displayname = ps_displayname.take();
                            }
                        }
                        in_propstat = false;
                    }
                    "response" => {
                        in_response = false;
                        if let Ok(resolved) = response_url.join(href.trim()) {
                            if resolved.origin() != response_url.origin() {
                                continue;
                            }
                            let mut entry_path = resolved.path().to_string();
                            if resp_collection && !entry_path.ends_with('/') {
                                entry_path.push('/');
                            }
                            let entry_norm = entry_path.trim_end_matches('/');
                            if !href.trim().is_empty()
                                && entry_path.starts_with(base_norm)
                                && entry_norm.rsplit_once('/').map(|(parent, _)| parent)
                                    == Some(req_norm)
                            {
                                let last_seg = entry_norm.rsplit('/').next().unwrap_or("");
                                let filename = if !last_seg.is_empty() {
                                    decode_path_segment(last_seg)
                                } else {
                                    resp_displayname.clone().unwrap_or_default()
                                };
                                if !filename.is_empty() {
                                    found.insert(
                                        entry_path.clone(),
                                        WebDavEntry {
                                            path: entry_path,
                                            filename,
                                            collection: resp_collection,
                                            size: resp_size,
                                            modified_at: resp_modified,
                                            created_at: resp_created.or(resp_modified),
                                            etag: resp_etag.clone(),
                                        },
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }
                current_tag.clear();
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    found.into_values().collect()
}
