use std::sync::Arc;

use biubiu_lib::desktop_lyrics::{DesktopLyricsAppearancePatch, DesktopLyricsManager};
use biubiu_lib::local_music::read_local_lyrics;
use biubiu_lib::lyrics::{assert_lyrics_key, update_track_lyrics};
use biubiu_lib::shortcut::{merge_default_shortcut_settings, normalize_accelerator};
use biubiu_lib::storage::{ListeningEntry, PlaylistOp, StorageManager};
use biubiu_lib::webdav::cache::WebDavCache;
use biubiu_lib::webdav::client::{normalize_webdav_url, relative_folder, WebDavEntry};
use biubiu_lib::webdav::crypto::{decrypt_secret, encrypt_secret};
use biubiu_lib::webdav::metadata::{decode_text_bytes, find_sidecars};

fn temp_test_dir(prefix: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp test dir");
    dir
}

#[test]
fn webdav_url_and_crypto_and_cache() {
    assert_eq!(
        normalize_webdav_url("https://example.com/dav").unwrap(),
        "https://example.com/dav/"
    );
    assert!(normalize_webdav_url("ftp://example.com/dav").is_err());
    assert!(normalize_webdav_url("https://user:pass@example.com/dav").is_err());
    assert_eq!(
        relative_folder("/dav/music/", "/dav/music/album/track.flac"),
        "album"
    );

    let secret = "super-secret-webdav-password!@#";
    let encrypted = encrypt_secret(secret).expect("encrypt");
    assert_ne!(encrypted, secret);
    assert_eq!(decrypt_secret(&encrypted).expect("decrypt"), secret);

    let dir = temp_test_dir("biubiu-webdav-cache-test");
    let cache = WebDavCache::new(&dir);
    let saved = cache
        .write_cached_bytes("deadbeef01", b"audio-bytes")
        .expect("save cached audio");
    assert!(saved.is_file());
    assert_eq!(
        cache.get_cached_file("deadbeef01").as_deref(),
        Some(saved.as_path())
    );
    cache.clear().expect("clear cache");
    assert!(cache.get_cached_file("deadbeef01").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn webdav_sidecar_matching_prefers_spl_and_matches_cover() {
    let entries = vec![
        WebDavEntry {
            path: "/music/song%201.flac".to_string(),
            filename: "song 1.flac".to_string(),
            collection: false,
            size: Some(1000),
            modified_at: None,
            created_at: None,
            etag: None,
        },
        WebDavEntry {
            path: "/music/song%201.lrc".to_string(),
            filename: "song 1.lrc".to_string(),
            collection: false,
            size: Some(100),
            modified_at: None,
            created_at: None,
            etag: None,
        },
        WebDavEntry {
            path: "/music/song%201.spl".to_string(),
            filename: "song 1.spl".to_string(),
            collection: false,
            size: Some(120),
            modified_at: None,
            created_at: None,
            etag: None,
        },
        WebDavEntry {
            path: "/music/song%201.jpg".to_string(),
            filename: "song 1.jpg".to_string(),
            collection: false,
            size: Some(500),
            modified_at: None,
            created_at: None,
            etag: None,
        },
    ];
    let map = find_sidecars(&entries);
    let (cover, lyric) = map.get("/music/song%201.flac").expect("sidecar found");
    assert_eq!(cover.as_deref(), Some("/music/song%201.jpg"));
    assert_eq!(lyric.as_deref(), Some("/music/song%201.spl"));
}

#[test]
fn local_lyrics_respects_root_sandbox_and_utf16le() {
    let dir = temp_test_dir("biubiu-local-lyrics-test");
    let audio = dir.join("曲 #100%.mp3");
    let lrc = dir.join("曲 #100%.lrc");
    let spl = dir.join("曲 #100%.spl");
    std::fs::write(&audio, b"").unwrap();

    let mut utf16 = vec![0xFFu8, 0xFE];
    for u in "[00:01]歌词".encode_utf16() {
        utf16.extend_from_slice(&u.to_le_bytes());
    }
    std::fs::write(&lrc, &utf16).unwrap();
    assert_eq!(decode_text_bytes(&utf16), "[00:01]歌词");

    let file_url = format!("file://{}", audio.to_string_lossy().replace('\\', "/"));
    let allowed = vec![dir.to_string_lossy().to_string()];
    assert_eq!(
        read_local_lyrics(&file_url, &allowed).as_deref(),
        Some("[00:01]歌词")
    );

    std::fs::write(&spl, "[00:02]word<00:03>end").unwrap();
    assert_eq!(
        read_local_lyrics(&file_url, &allowed).as_deref(),
        Some("[00:02]word<00:03>end")
    );

    let other_dir = vec![dir.join("other").to_string_lossy().to_string()];
    assert!(read_local_lyrics(&file_url, &other_dir).is_none());
    assert!(read_local_lyrics("https://example.org/test.mp3", &allowed).is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn storage_sqlite_playlists_history_and_lyrics_cache() {
    let dir = temp_test_dir("biubiu-storage-test");
    let storage = Arc::new(StorageManager::new(dir.clone()).expect("init storage"));

    assert!(assert_lyrics_key("BV1-12").is_ok());
    assert!(assert_lyrics_key("webdav-same").is_ok());
    assert!(assert_lyrics_key("__proto__").is_err());
    assert!(assert_lyrics_key("local-foo.bar").is_err());

    update_track_lyrics(
        &storage,
        "BV1-12",
        serde_json::json!({ "type": "adopt", "text": { "lyrics": "[00:01]hello" } }),
    )
    .expect("adopt lyrics");
    update_track_lyrics(
        &storage,
        "BV1-12",
        serde_json::json!({ "type": "preferences", "offset": -250, "fontSize": 24 }),
    )
    .expect("update preferences");
    let saved = storage
        .get_track_lyrics("BV1-12")
        .expect("read lyrics")
        .expect("lyrics present");
    assert_eq!(saved["lyrics"], "[00:01]hello");
    assert_eq!(saved["offset"], -250);
    assert_eq!(saved["fontSize"], 24);

    storage
        .sqlite_playlists_commit(
            vec![PlaylistOp {
                op: "put".to_string(),
                key: Some("p1".to_string()),
                value: Some(serde_json::json!({ "id": "p1", "name": "Favorites" })),
            }],
            None,
        )
        .expect("put playlist");
    let all = storage.sqlite_playlists_get_all().expect("get playlists");
    assert_eq!(all.get("p1").unwrap()["name"], "Favorites");

    for i in 0..5 {
        storage
            .sqlite_history_add(
                ListeningEntry {
                    at: 1000 + i,
                    key: format!("track-{i}"),
                    title: format!("Song {i}"),
                    source: "bilibili".to_string(),
                    seconds: 180.0,
                },
                3,
            )
            .expect("add history");
    }
    let hist = storage.sqlite_history_get_all(10).expect("get history");
    assert_eq!(hist.len(), 3);
    assert_eq!(hist[0].key, "track-2");
    assert_eq!(hist[2].key, "track-4");

    let dlm = DesktopLyricsManager::new(storage.clone());
    assert_eq!(dlm.get_state().appearance.color, "#ffffff");
    assert_eq!(dlm.get_state().appearance.font_size, 26);
    assert!(dlm.get_state().appearance.split_bilingual);
    let _ = DesktopLyricsAppearancePatch {
        color: Some("#AABBCC".to_string()),
        font_size: Some(30),
        ..Default::default()
    };

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn shortcut_accelerator_normalization() {
    let expected_mod = if cfg!(target_os = "macos") {
        "Super"
    } else {
        "Control"
    };
    assert_eq!(
        normalize_accelerator("CommandOrControl+Alt+Left"),
        format!("{expected_mod}+Alt+ArrowLeft")
    );
    assert_eq!(
        normalize_accelerator("CommandOrControl+Alt+P"),
        format!("{expected_mod}+Alt+KeyP")
    );
    assert_eq!(
        normalize_accelerator("CommandOrControl+Alt+G"),
        format!("{expected_mod}+Alt+KeyG")
    );

    let legacy = serde_json::json!({
        "enableGlobalShortcuts": true,
        "shortcuts": [
            { "id": "togglePlay", "name": "播放/暂停", "shortcut": "CommandOrControl+P" }
        ],
        "globalShortcuts": [
            { "id": "togglePlay", "name": "播放/暂停", "shortcut": "" }
        ]
    });
    let (merged, changed) = merge_default_shortcut_settings(Some(legacy));
    assert!(changed);
    let local = merged["shortcuts"].as_array().unwrap();
    let global = merged["globalShortcuts"].as_array().unwrap();
    assert_eq!(
        global
            .iter()
            .find(|item| item["id"] == "togglePlay")
            .and_then(|item| item["shortcut"].as_str()),
        Some("")
    );
    assert_eq!(
        local
            .iter()
            .find(|item| item["id"] == "toggleLyrics")
            .and_then(|item| item["shortcut"].as_str()),
        Some("CommandOrControl+G")
    );
    assert_eq!(
        global
            .iter()
            .find(|item| item["id"] == "toggleLyrics")
            .and_then(|item| item["shortcut"].as_str()),
        Some("CommandOrControl+Alt+G")
    );
    let (_, changed_again) = merge_default_shortcut_settings(Some(merged));
    assert!(!changed_again);

    let v1_lyrics = serde_json::json!({
        "enableGlobalShortcuts": true,
        "shortcuts": [
            { "id": "toggleLyrics", "name": "打开/关闭桌面歌词", "shortcut": "CommandOrControl+L" }
        ],
        "globalShortcuts": [
            { "id": "toggleLyrics", "name": "打开/关闭桌面歌词", "shortcut": "CommandOrControl+Alt+L", "isConflict": true }
        ]
    });
    let mut occupied = v1_lyrics.clone();
    occupied["globalShortcuts"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": "prev", "name": "上一首", "shortcut": "CommandOrControl+Alt+G"
        }));
    let (preserved, _) = merge_default_shortcut_settings(Some(occupied));
    assert_eq!(
        preserved["globalShortcuts"][0]["shortcut"],
        "CommandOrControl+Alt+L"
    );
    let (migrated, migrated_changed) = merge_default_shortcut_settings(Some(v1_lyrics));
    assert!(migrated_changed);
    assert_eq!(
        migrated["shortcuts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "toggleLyrics")
            .and_then(|item| item["shortcut"].as_str()),
        Some("CommandOrControl+G")
    );
    assert_eq!(
        migrated["globalShortcuts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "toggleLyrics")
            .and_then(|item| item["shortcut"].as_str()),
        Some("CommandOrControl+Alt+G")
    );

    let mut custom_v2 = migrated;
    if let Some(item) = custom_v2["shortcuts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["id"] == "toggleLyrics")
    {
        item["shortcut"] = serde_json::json!("CommandOrControl+L");
    }
    let (preserved, preserved_changed) = merge_default_shortcut_settings(Some(custom_v2));
    assert!(!preserved_changed);
    assert_eq!(
        preserved["shortcuts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "toggleLyrics")
            .and_then(|item| item["shortcut"].as_str()),
        Some("CommandOrControl+L")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_audio_reuses_stream_and_seeks_when_the_server_ignores_ranges() {
    use axum::{routing::get, Router};
    use std::io::{Read, Seek, SeekFrom};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let router = Router::new().route(
        "/song",
        get(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            async { "0123456789" }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/song", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    tokio::task::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        let mut song =
            biubiu_lib::http_audio::HttpAudio::open(client, url, Default::default()).unwrap();
        let mut part = [0u8; 3];
        song.read_exact(&mut part).unwrap();
        assert_eq!(&part, b"012");
        song.read_exact(&mut part).unwrap();
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        song.seek(SeekFrom::Start(2)).unwrap();
        song.read_exact(&mut part).unwrap();
        assert_eq!(&part, b"234");
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    })
    .await
    .unwrap();
    server.abort();
}

#[tokio::test]
async fn webdav_redirect_stable_track_id_and_backup_roundtrip() {
    use axum::{
        body::Bytes,
        extract::Request,
        http::{HeaderValue, StatusCode},
        response::IntoResponse,
        routing::any,
        Router,
    };
    use biubiu_lib::{
        bili_http::BiliHttpClient, state::ProxySettings, webdav::library::WebDavManager,
    };
    use sha2::{Digest, Sha256};
    let uploaded = Arc::new(parking_lot::Mutex::new(Vec::<u8>::new()));
    let saved = uploaded.clone();
    let router = Router::new().fallback(any(move |req: Request| {
        let saved = saved.clone();
        async move {
            let route = req.uri().path().to_string();
            match (req.method().as_str(), route.as_str()) {
                ("PROPFIND", "/dav/") => (StatusCode::TEMPORARY_REDIRECT, [("location", "/dav/index")]).into_response(),
                ("PROPFIND", "/dav/index") => (StatusCode::MULTI_STATUS,
                    r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/song.mp3</D:href><D:propstat><D:prop><D:getcontentlength>123</D:getcontentlength><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>"#).into_response(),
                ("MKCOL", "/dav/BiuBiu-Backups/") => StatusCode::CREATED.into_response(),
                ("PUT", _) if route.starts_with("/dav/BiuBiu-Backups/") => {
                    assert_eq!(req.headers().get("if-none-match"), Some(&HeaderValue::from_static("*")));
                    let bytes = axum::body::to_bytes(req.into_body(), 8192).await.unwrap();
                    *saved.lock() = bytes.to_vec();
                    StatusCode::CREATED.into_response()
                }
                ("GET", _) if route.starts_with("/dav/BiuBiu-Backups/") => Bytes::from(saved.lock().clone()).into_response(),
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(StorageManager::new(dir.path().into()).unwrap());
    db.write_json("webdav", &serde_json::json!({"lists":[{"id":"test","name":"Test","url":url,"username":"",
        "directory":"","includeSubdirectories":false,"lazyMetadata":true,"removeRemoteFiles":false}]})).unwrap();
    let http = Arc::new(BiliHttpClient::new(dir.path().into(), ProxySettings::default()).unwrap());
    let lib = Arc::new(WebDavManager::new(db, http));
    lib.refresh_list("test").await.unwrap();
    let expected = hex::encode(Sha256::digest(
        serde_json::to_vec(&["test", &url, "", "/dav/song.mp3"]).unwrap(),
    ));
    assert_eq!(lib.get_library().lists[0].tracks[0].id, expected);
    let data = r#"{"format":"biubiu-desktop","version":1}"#;
    let name = lib.upload_backup("test", data).await.unwrap();
    assert_eq!(lib.download_backup("test", &name).await.unwrap(), data);
    assert!(lib.download_backup("test", "../other.json").await.is_err());
    server.abort();
}

#[tokio::test]
async fn webdav_refresh_finishes_without_blocking_on_tags_and_preserves_legacy_metadata() {
    use axum::{extract::Request, http::StatusCode, response::IntoResponse, routing::any, Router};
    use biubiu_lib::{
        bili_http::BiliHttpClient, state::ProxySettings, webdav::library::WebDavManager,
    };
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicUsize, Ordering};

    let tag_fetches = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Notify::new());
    let fetches_seen = tag_fetches.clone();
    let gate = release.clone();
    let router = Router::new().fallback(any(move |req: Request| {
        let fetches_seen = fetches_seen.clone();
        let gate = gate.clone();
        async move {
            match (req.method().as_str(), req.uri().path()) {
                ("PROPFIND", "/dav/") => (
                    StatusCode::MULTI_STATUS,
                    concat!(
                        r#"<D:multistatus xmlns:D="DAV:">"#,
                        r#"<D:response><D:href>/dav/migrated.mp3</D:href><D:propstat><D:prop>"#,
                        r#"<D:getcontentlength>1024</D:getcontentlength><D:getetag>"v1"</D:getetag>"#,
                        r#"<D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"#,
                        r#"<D:response><D:href>/dav/fresh.mp3</D:href><D:propstat><D:prop>"#,
                        r#"<D:getcontentlength>2048</D:getcontentlength><D:getetag>"v2"</D:getetag>"#,
                        r#"<D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"#,
                        r#"</D:multistatus>"#
                    ),
                )
                    .into_response(),
                ("GET", "/dav/migrated.mp3") => {
                    fetches_seen.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::OK, vec![0u8; 64]).into_response()
                }
                ("GET", "/dav/fresh.mp3") => {
                    fetches_seen.fetch_add(1, Ordering::SeqCst);
                    gate.notified().await;
                    (StatusCode::OK, vec![0u8; 64]).into_response()
                }
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });

    let migrated_id = hex::encode(Sha256::digest(
        serde_json::to_vec(&["legacy", &url, "", "/dav/migrated.mp3"]).unwrap(),
    ));
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(StorageManager::new(dir.path().into()).unwrap());
    db.write_json(
        "webdav",
        &serde_json::json!({
            "lists": [{
                "id": "legacy",
                "name": "Legacy",
                "url": url,
                "username": "",
                "directory": "",
                "includeSubdirectories": false,
                "lazyMetadata": false,
                "removeRemoteFiles": false,
                "tracks": [{
                    "id": migrated_id,
                    "path": "/dav/migrated.mp3",
                    "title": "Saved Title",
                    "artist": "Saved Artist",
                    "filename": "migrated.mp3",
                    "folder": "",
                    "format": "mp3",
                    "size": 1024,
                    "etag": "\"v1\"",
                    "hasCover": true,
                    "metadataParsed": true
                }]
            }]
        }),
    )
    .unwrap();

    let http = Arc::new(BiliHttpClient::new(dir.path().into(), ProxySettings::default()).unwrap());
    let lib = Arc::new(WebDavManager::new(db, http));
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lib.refresh_list("legacy"),
    )
    .await
    .expect("refresh_list must not block on slow tag fetches")
    .unwrap();

    let snapshot = lib.get_library();
    assert!(!snapshot.lists[0].is_syncing);
    let migrated = snapshot.lists[0]
        .tracks
        .iter()
        .find(|t| t.filename == "migrated.mp3")
        .unwrap();
    assert_eq!(migrated.title, "Saved Title");
    assert_eq!(migrated.artist.as_deref(), Some("Saved Artist"));
    assert!(migrated.has_cover);

    release.notify_waiters();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(
        tag_fetches.load(Ordering::SeqCst),
        1,
        "only the new unparsed track should be probed for tags"
    );
    server.abort();
}

#[tokio::test]
async fn cancelled_external_playlist_never_sends_a_request() {
    use biubiu_lib::external_playlist::{fetch_public_playlist, ExternalPlaylistRef};
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    let client = reqwest::Client::new();
    for source in ["qq", "netease"] {
        let playlist = ExternalPlaylistRef {
            source: source.into(),
            id: "123".into(),
        };
        assert!(fetch_public_playlist(&client, playlist, cancel.clone())
            .await
            .unwrap_err()
            .contains("取消"));
    }
}

#[test]
fn settings_migration_can_retry_without_overwriting_the_new_profile() {
    let root = tempfile::tempdir().unwrap();
    let old = root.path().join("old");
    let new = root.path().join("new");
    std::fs::create_dir(&old).unwrap();
    std::fs::write(
        old.join("app-settings.json"),
        r#"{"appSettings":{"themeMode":"light"}}"#,
    )
    .unwrap();
    std::fs::write(old.join("webdav.json"), b"{").unwrap();
    assert!(biubiu_lib::migration::copy_settings(&old, &new).is_err());
    std::fs::write(
        new.join("app-settings.json"),
        r#"{"appSettings":{"themeMode":"dark"}}"#,
    )
    .unwrap();
    std::fs::write(
        old.join("webdav.json"),
        r#"{"lists":[],"passwords":{"fixture":"old-format"}}"#,
    )
    .unwrap();
    biubiu_lib::migration::copy_settings(&old, &new).unwrap();
    let db = StorageManager::new(new).unwrap();
    assert_eq!(
        db.get_app_setting_string("themeMode").as_deref(),
        Some("dark")
    );
    assert_eq!(
        db.read_json("webdav").unwrap().unwrap()["passwords"],
        serde_json::json!({})
    );
    assert!(std::fs::read_to_string(old.join("webdav.json"))
        .unwrap()
        .contains("old-format"));
    assert!(!db
        .sqlite_playlists_commit(vec![], Some(db.playlist_revision() + 1))
        .unwrap());
}

#[tokio::test]
async fn window_lifecycle_serializes_ops_and_wakes_destroy_waiters() {
    use biubiu_lib::window_mgr::WindowLifecycle;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let lifecycle = WindowLifecycle::new();

    // Destroy waiters are isolated per window label and wake all registered listeners.
    let mut mini_rx = lifecycle.register_destroyed_waiter("mini");
    let mut main_rx = lifecycle.register_destroyed_waiter("main");
    assert!(mini_rx.try_recv().is_err());
    assert!(main_rx.try_recv().is_err());

    lifecycle.notify_destroyed("mini");
    tokio::time::timeout(std::time::Duration::from_millis(200), mini_rx)
        .await
        .expect("mini destroy waiter timed out")
        .expect("mini destroy waiter cancelled");
    assert!(main_rx.try_recv().is_err());

    lifecycle.notify_destroyed("main");
    tokio::time::timeout(std::time::Duration::from_millis(200), main_rx)
        .await
        .expect("main destroy waiter timed out")
        .expect("main destroy waiter cancelled");

    // Operation lock strictly serializes overlapping window transitions in FIFO order.
    let order = Arc::new(parking_lot::Mutex::new(Vec::<usize>::new()));
    let active = Arc::new(AtomicUsize::new(0));
    let first_guard = lifecycle.lock_op().await;
    active.fetch_add(1, Ordering::SeqCst);

    let lc1 = lifecycle.clone();
    let ord1 = order.clone();
    let act1 = active.clone();
    let t1 = tokio::spawn(async move {
        let _g = lc1.lock_op().await;
        assert_eq!(act1.fetch_add(1, Ordering::SeqCst), 0);
        ord1.lock().push(1);
        act1.fetch_sub(1, Ordering::SeqCst);
    });
    tokio::task::yield_now().await;

    let lc2 = lifecycle.clone();
    let ord2 = order.clone();
    let act2 = active.clone();
    let t2 = tokio::spawn(async move {
        let _g = lc2.lock_op().await;
        assert_eq!(act2.fetch_add(1, Ordering::SeqCst), 0);
        ord2.lock().push(2);
        act2.fetch_sub(1, Ordering::SeqCst);
    });
    tokio::task::yield_now().await;

    assert!(order.lock().is_empty());
    active.fetch_sub(1, Ordering::SeqCst);
    drop(first_guard);

    t1.await.unwrap();
    t2.await.unwrap();
    assert_eq!(*order.lock(), vec![1, 2]);
}
