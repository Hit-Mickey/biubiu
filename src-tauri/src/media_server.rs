use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use reqwest::header::{ACCEPT_ENCODING, RANGE};
use reqwest::Method;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::webdav::client::audio_mime_type;
use crate::webdav::library::{track_version, WebDavManager};

#[derive(Clone)]
struct MediaServerState {
    token: String,
    webdav: Arc<WebDavManager>,
}

pub async fn start_media_server(token: String, webdav: Arc<WebDavManager>) -> Result<u16, String> {
    let state = MediaServerState { token, webdav };
    let app = Router::new()
        .route(
            "/webdav/cover/{list_id}/{track_id}",
            get(handle_webdav_cover),
        )
        .route(
            "/webdav/audio/{list_id}/{track_id}",
            get(handle_webdav_audio),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind media server failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(port)
}

fn check_token(state: &MediaServerState, query: &HashMap<String, String>) -> bool {
    query
        .get("token")
        .map(|t| t == &state.token)
        .unwrap_or(false)
}

async fn handle_webdav_cover(
    State(state): State<MediaServerState>,
    Path((list_id, track_id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !check_token(&state, &query) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())
            .unwrap();
    }

    match state.webdav.get_track_cover(&list_id, &track_id).await {
        Ok(Some((mime, bytes))) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime)
            .header("Content-Length", bytes.len().to_string())
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "max-age=300")
            .header("X-Content-Type-Options", "nosniff")
            .body(Body::from(bytes))
            .unwrap(),
        _ => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Access-Control-Allow-Origin", "*")
            .body(Body::empty())
            .unwrap(),
    }
}

async fn handle_webdav_audio(
    State(state): State<MediaServerState>,
    Path((list_id, track_id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    req_headers: HeaderMap,
) -> Response {
    if !check_token(&state, &query) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())
            .unwrap();
    }

    let Ok((client, track, cache_audio)) = state.webdav.open_track(&list_id, &track_id) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    let mime = audio_mime_type(&track.format).unwrap_or("application/octet-stream");
    let version = track_version(&track);

    if cache_audio {
        if let Some(cached_path) = state.webdav.cached_audio_path(&version) {
            if let Ok(resp) = serve_local_file_range(&cached_path, mime, &req_headers).await {
                return resp;
            }
        }
    }

    let mut up_headers = reqwest::header::HeaderMap::new();
    up_headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    if let Some(range) = req_headers.get("range").and_then(|v| v.to_str().ok()) {
        if let Ok(hv) = HeaderValue::from_str(range) {
            up_headers.insert(RANGE, hv);
        }
    }

    let Ok(upstream) = client
        .request(&track.path, Method::GET, Some(up_headers), None, true)
        .await
    else {
        return Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(Body::empty())
            .unwrap();
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff");

    for name in ["content-length", "content-range", "accept-ranges"] {
        if let Some(val) = upstream.headers().get(name) {
            if let Ok(s) = val.to_str() {
                builder = builder.header(name, s);
            }
        }
    }

    let body = Body::from_stream(upstream.bytes_stream());
    builder.body(body).unwrap()
}

async fn serve_local_file_range(
    path: &std::path::Path,
    mime: &str,
    req_headers: &HeaderMap,
) -> Result<Response, std::io::Error> {
    let mut file = tokio::fs::File::open(path).await?;
    let file_size = file.metadata().await?.len();

    let range_header = req_headers.get("range").and_then(|v| v.to_str().ok());
    if let Some(range_str) = range_header {
        if let Some((start, end)) = parse_byte_range(range_str, file_size) {
            file.seek(std::io::SeekFrom::Start(start)).await?;
            let len = end - start + 1;
            let limited = file.take(len);
            let stream = ReaderStream::new(limited);
            return Ok(Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", len.to_string())
                .header("Content-Range", format!("bytes {start}-{end}/{file_size}"))
                .header("Access-Control-Allow-Origin", "*")
                .body(Body::from_stream(stream))
                .unwrap());
        }
    }

    let stream = ReaderStream::new(file);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", file_size.to_string())
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from_stream(stream))
        .unwrap())
}

fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;
    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        let len = suffix.min(total);
        Some((total - len, total - 1))
    } else {
        let start: u64 = start_s.parse().ok()?;
        if start >= total {
            return None;
        }
        let end = if end_s.is_empty() {
            total - 1
        } else {
            end_s.parse::<u64>().ok()?.min(total - 1)
        };
        if start <= end {
            Some((start, end))
        } else {
            None
        }
    }
}
