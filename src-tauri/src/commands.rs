use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use crate::audio_engine::{
    MiniCommandPayload, NativeAudioStateSnapshot, NativeQueueSnapshot, NativeTrackMetadata,
    PlayRequest,
};
use crate::bili_http::{RustHttpRequest, RustHttpResponse};
use crate::desktop_lyrics::{
    DesktopLyricLine, DesktopLyricsAppearancePatch, DesktopLyricsWindowState,
};
use crate::download::{MediaDownloadTask, MediaDownloadTaskInput};
use crate::external_playlist::{self, ExternalPlaylist, ExternalPlaylistRef};
use crate::font::{self, FontInfo};
use crate::local_music::{self, LocalMusicItem, ResolvedLocalMusic};
use crate::lyrics::{
    self, GetNeteaseLyricsParams, LyricText, QQLyricSong, SearchLrclibParams, SearchNeteaseParams,
};
use crate::shortcut;
use crate::state::{AppState, ProxySettings};
use crate::storage::{ListeningEntry, PlaylistOp};
use crate::thumbar;
use crate::updater::{self, CheckAppUpdateResult};
use crate::webdav::library::{
    BackupTarget, SaveWebDavListResult, WebDavLibraryPublic, WebDavListInput, WebDavPreferences,
    WebDavRemoveResult, WebDavTrackPublic,
};
use crate::window_mgr;

// ======================== Store & SQLite ========================

#[tauri::command]
pub fn store_get(state: State<'_, Arc<AppState>>, name: String) -> Result<Option<Value>, String> {
    state.storage.store_get(&name)
}

#[tauri::command]
pub fn store_set(
    state: State<'_, Arc<AppState>>,
    name: String,
    value: Value,
) -> Result<(), String> {
    let reporting = value
        .pointer("/appSettings/reportPlayHistory")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    state.storage.store_set(&name, value)?;
    if name == "app-settings" {
        state.audio.reporter.set_enabled(reporting);
        let ffmpeg = state.resolve_ffmpeg_path();
        state.audio.set_ffmpeg_path(ffmpeg.clone());
        state.downloads.set_ffmpeg_path(ffmpeg);
    }
    Ok(())
}

#[tauri::command]
pub fn store_clear(state: State<'_, Arc<AppState>>, name: String) -> Result<(), String> {
    state.storage.store_clear(&name)
}

#[tauri::command]
pub fn playlist_revision(state: State<'_, Arc<AppState>>) -> u64 {
    state.storage.playlist_revision()
}

#[tauri::command]
pub fn playlist_entry(
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Option<Value>, String> {
    state.storage.playlist_entry(&key)
}

#[tauri::command]
pub fn sqlite_playlists_commit(
    state: State<'_, Arc<AppState>>,
    ops: Vec<PlaylistOp>,
    revision: u64,
) -> Result<bool, String> {
    state.storage.sqlite_playlists_commit(ops, Some(revision))
}

#[tauri::command]
pub fn sqlite_history_get_all(
    state: State<'_, Arc<AppState>>,
    limit: usize,
) -> Result<Vec<ListeningEntry>, String> {
    state.storage.sqlite_history_get_all(limit)
}

#[tauri::command]
pub fn sqlite_history_add(
    state: State<'_, Arc<AppState>>,
    entry: ListeningEntry,
    limit: usize,
) -> Result<(), String> {
    state.storage.sqlite_history_add(entry, limit)
}

#[tauri::command]
pub fn sqlite_history_replace(
    state: State<'_, Arc<AppState>>,
    entries: Vec<ListeningEntry>,
    limit: usize,
) -> Result<(), String> {
    state.storage.sqlite_history_replace(entries, limit)
}

// ======================== Dialog, Shell, Font, Log ========================

#[tauri::command]
pub async fn dialog_select_directory(
    app: AppHandle,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let resolved_title = title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("选择目录")
        .to_string();
    tokio::task::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title(resolved_title)
            .blocking_pick_folder();
        picked.and_then(|fp| fp.into_path().ok().map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dialog_select_file(app: AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("选择文件")
            .blocking_pick_file();
        picked.and_then(|fp| fp.into_path().ok().map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn shell_show_file_in_folder(app: AppHandle, file_path: String) -> Result<bool, String> {
    if file_path.trim().is_empty() || !Path::new(&file_path).exists() {
        return Err("文件路径不存在".to_string());
    }
    app.opener()
        .reveal_item_in_dir(&file_path)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn shell_open_directory(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    path: Option<String>,
) -> Result<bool, String> {
    let target = path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            state
                .storage
                .get_download_dir()
                .to_string_lossy()
                .to_string()
        });
    let _ = std::fs::create_dir_all(&target);
    Ok(app.opener().open_path(&target, None::<&str>).is_ok())
}

#[tauri::command]
pub fn shell_open_external(app: AppHandle, url: String) -> Result<bool, String> {
    let url = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "https" | "http") {
        return Ok(false);
    }
    Ok(app.opener().open_url(url.as_str(), None::<&str>).is_ok())
}

#[tauri::command]
pub async fn font_get_list() -> Result<Vec<FontInfo>, String> {
    tokio::task::spawn_blocking(font::get_system_fonts)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_log(level: String, message: String) {
    eprintln!("[biubiu:{level}] {message}");
}

// ======================== HTTP, Cookies, App ========================

#[tauri::command]
pub async fn bili_http_request(
    state: State<'_, Arc<AppState>>,
    req: RustHttpRequest,
) -> Result<RustHttpResponse, String> {
    state.http.execute_request(req).await
}

#[tauri::command]
pub async fn load_bilibili_cookies(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.http.load_homepage_cookies().await
}

#[tauri::command]
pub async fn sample_audio_mirror(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<u64, String> {
    state.http.sample_audio_mirror(&url).await
}

#[tauri::command]
pub fn cookie_get(state: State<'_, Arc<AppState>>, key: String) -> Option<String> {
    state.http.get_cookie(&key)
}

#[tauri::command]
pub fn cookie_set(
    state: State<'_, Arc<AppState>>,
    name: String,
    value: String,
    expiration_date: Option<i64>,
) -> Result<(), String> {
    state.http.set_cookie(&name, &value, expiration_date)
}

#[tauri::command]
pub fn app_get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn app_set_proxy(
    state: State<'_, Arc<AppState>>,
    proxy_settings: Option<ProxySettings>,
) -> Result<(), String> {
    state.http.set_proxy(proxy_settings.unwrap_or_default())
}

#[tauri::command]
pub fn player_update_playback_state(app: AppHandle, is_playing: bool) {
    thumbar::update_thumbar_state(&app, is_playing);
}

// ======================== External Playlists ========================

#[tauri::command]
pub async fn external_playlist_read(
    state: State<'_, Arc<AppState>>,
    playlist_ref: ExternalPlaylistRef,
    request_id: String,
) -> Result<ExternalPlaylist, String> {
    let token = CancellationToken::new();
    {
        let mut map = state.external_playlist_cancels.lock();
        if let Some(old) = map.insert(request_id.clone(), token.clone()) {
            old.cancel();
        }
    }
    let client = state.http.plain_client();
    let res = external_playlist::fetch_public_playlist(&client, playlist_ref, token).await;
    state.external_playlist_cancels.lock().remove(&request_id);
    res
}

#[tauri::command]
pub fn external_playlist_cancel(state: State<'_, Arc<AppState>>, request_id: String) {
    if let Some(token) = state.external_playlist_cancels.lock().remove(&request_id) {
        token.cancel();
    }
}

// ======================== Lyrics ========================

#[tauri::command]
pub async fn lyrics_search_netease(
    state: State<'_, Arc<AppState>>,
    params: SearchNeteaseParams,
) -> Result<Value, String> {
    lyrics::search_netease(&state.http.plain_client(), params).await
}

#[tauri::command]
pub async fn lyrics_get_netease(
    state: State<'_, Arc<AppState>>,
    params: GetNeteaseLyricsParams,
) -> Result<Value, String> {
    lyrics::get_netease_lyrics(&state.http.plain_client(), params).await
}

#[tauri::command]
pub async fn lyrics_search_lrclib(
    state: State<'_, Arc<AppState>>,
    params: SearchLrclibParams,
) -> Result<Value, String> {
    lyrics::search_lrclib(&state.http.plain_client(), params).await
}

#[tauri::command]
pub async fn lyrics_search_qq(
    state: State<'_, Arc<AppState>>,
    keyword: String,
) -> Result<Vec<QQLyricSong>, String> {
    lyrics::search_qq(&state.http.plain_client(), &keyword).await
}

#[tauri::command]
pub async fn lyrics_get_qq(
    state: State<'_, Arc<AppState>>,
    mid: String,
) -> Result<LyricText, String> {
    lyrics::get_qq_lyrics(&state.http.plain_client(), &mid).await
}

#[tauri::command]
pub fn lyrics_get_track(
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Option<Value>, String> {
    lyrics::assert_lyrics_key(&key)?;
    state.storage.get_track_lyrics(&key)
}

#[tauri::command]
pub fn lyrics_update_track(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    key: String,
    change: Value,
) -> Result<(), String> {
    use tauri::Emitter;
    let adopted = change["type"] == "adopt";
    let record = lyrics::update_track_lyrics(&state.storage, &key, change)?;
    let _ = app.emit_to("desktop-lyrics", "lyrics://updated", serde_json::json!({
        "key": key, "offset": record["offset"].as_f64().unwrap_or(0.0), "text": adopted.then_some(&record)
    }));
    Ok(())
}

#[tauri::command]
pub async fn lyrics_read_local(
    state: State<'_, Arc<AppState>>,
    track_id: String,
    audio_url: String,
) -> Result<Option<Value>, String> {
    let (_, value) = state
        .audio
        .lyrics
        .read(
            &track_id,
            lyrics::LyricSource::Local(audio_url.clone()),
            async {
                let dirs = state.storage.get_local_music_dirs();
                tokio::task::spawn_blocking(move || {
                    local_music::read_local_lyrics(&audio_url, &dirs)
                })
                .await
                .map(|text| text.filter(|s| !s.trim().is_empty()).map(Value::String))
                .map_err(|e| e.to_string())
            },
        )
        .await?;
    Ok(value)
}

#[tauri::command]
pub async fn lyrics_get_playback_subtitles(
    state: State<'_, Arc<AppState>>,
    track_id: String,
    source_key: String,
) -> Result<(u64, Option<Value>), String> {
    state
        .audio
        .lyrics
        .read(
            &track_id,
            lyrics::LyricSource::Bilibili(source_key),
            async { Ok(None) },
        )
        .await
}

#[tauri::command]
pub async fn lyrics_save_playback_subtitles(
    state: State<'_, Arc<AppState>>,
    revision: u64,
    lines: Vec<Value>,
) -> Result<(), String> {
    state.audio.lyrics.save_subtitles(revision, lines).await;
    Ok(())
}

// ======================== Shortcuts ========================

#[tauri::command]
pub fn shortcut_register(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
    accelerator: String,
) -> bool {
    shortcut::register_shortcut(&app, state.inner(), &id, &accelerator)
}

#[tauri::command]
pub fn shortcut_unregister(app: AppHandle, state: State<'_, Arc<AppState>>, id: String) {
    shortcut::unregister_shortcut(&app, state.inner(), &id);
}

#[tauri::command]
pub fn shortcut_register_all(app: AppHandle, state: State<'_, Arc<AppState>>) {
    shortcut::register_all_shortcuts(&app, state.inner());
}

#[tauri::command]
pub fn shortcut_unregister_all(app: AppHandle, state: State<'_, Arc<AppState>>) {
    shortcut::unregister_all_shortcuts(&app, state.inner());
}

// ======================== Updater ========================

#[tauri::command]
pub async fn updater_check(
    state: State<'_, Arc<AppState>>,
) -> Result<CheckAppUpdateResult, String> {
    Ok(updater::check_for_updates(state.inner()).await)
}

#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    updater::download_update(app, state.inner().clone()).await
}

#[tauri::command]
pub fn updater_install(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    updater::install_update(&app, state.inner())
}

// ======================== Window, Mini Player, Desktop Lyrics ========================

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn window_close(app: AppHandle, state: State<'_, Arc<AppState>>, window: WebviewWindow) {
    window_mgr::handle_close_request(&app, state.inner(), window.label());
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
pub fn window_is_fullscreen(window: WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[tauri::command]
pub async fn mini_player_toggle(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    window_mgr::toggle_mini_player_async(&app, state.inner()).await
}

#[tauri::command]
pub fn mini_player_get_state(state: State<'_, Arc<AppState>>) -> NativeAudioStateSnapshot {
    state.audio.get_state()
}

#[tauri::command]
pub fn mini_player_command(
    app_state: State<'_, Arc<AppState>>,
    command: String,
    state: Option<MiniCommandPayload>,
) {
    app_state.audio.handle_mini_command(&command, state);
}

#[tauri::command]
pub async fn desktop_lyrics_set_visible(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    open: bool,
) -> Result<(), String> {
    state
        .desktop_lyrics
        .set_visible_async(&app, state.inner(), open)
        .await
}

#[tauri::command]
pub fn desktop_lyrics_set_locked(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    locked: bool,
) -> Result<(), String> {
    state.desktop_lyrics.set_locked(&app, locked)
}

#[tauri::command]
pub fn desktop_lyrics_set_unlock_hovered(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    hovered: bool,
) {
    state.desktop_lyrics.set_unlock_hovered(&app, hovered);
}

#[tauri::command]
pub fn desktop_lyrics_set_appearance(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    appearance: DesktopLyricsAppearancePatch,
) -> Result<(), String> {
    state.desktop_lyrics.set_appearance(&app, appearance)
}

#[tauri::command]
pub fn desktop_lyrics_get_state(state: State<'_, Arc<AppState>>) -> DesktopLyricsWindowState {
    state.desktop_lyrics.get_state()
}

#[tauri::command]
pub fn desktop_lyrics_show_line(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    line: DesktopLyricLine,
) {
    state.desktop_lyrics.show_line(&app, line);
}

// ======================== Native Audio Engine ========================

#[tauri::command]
pub fn audio_current_track(
    state: State<'_, Arc<AppState>>,
) -> Option<crate::audio_engine::NativeQueueTrack> {
    state.audio.current_track()
}

#[tauri::command]
pub fn sleep_timer_get(state: State<'_, Arc<AppState>>) -> u64 {
    state
        .audio
        .sleep_deadline
        .load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
pub fn sleep_timer_set(state: State<'_, Arc<AppState>>, deadline: u64) {
    state
        .audio
        .sleep_deadline
        .store(deadline, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn audio_get_state(state: State<'_, Arc<AppState>>) -> NativeAudioStateSnapshot {
    state.audio.get_state()
}

#[tauri::command]
pub async fn audio_play(
    state: State<'_, Arc<AppState>>,
    src: String,
    start_secs: f64,
    volume: f32,
    muted: bool,
    rate: f32,
    looping: bool,
) -> Result<NativeAudioStateSnapshot, String> {
    let audio = state.audio.clone();
    let request = audio.reserve_play();
    tauri::async_runtime::spawn_blocking(move || {
        audio.play(PlayRequest {
            request,
            src,
            start_secs,
            volume,
            muted,
            rate,
            looping,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn audio_pause(state: State<'_, Arc<AppState>>) {
    state.audio.pause();
}

#[tauri::command]
pub fn audio_stop(state: State<'_, Arc<AppState>>) {
    state.audio.stop();
}

#[tauri::command]
pub fn audio_seek(state: State<'_, Arc<AppState>>, position_secs: f64) {
    state.audio.seek(position_secs);
}

#[tauri::command]
pub fn audio_set_volume(state: State<'_, Arc<AppState>>, volume: f32) {
    state.audio.set_volume(volume);
}

#[tauri::command]
pub fn audio_set_muted(state: State<'_, Arc<AppState>>, muted: bool) {
    state.audio.set_muted(muted);
}

#[tauri::command]
pub fn audio_set_rate(state: State<'_, Arc<AppState>>, rate: f32) {
    state.audio.set_rate(rate);
}

#[tauri::command]
pub fn audio_set_loop(state: State<'_, Arc<AppState>>, looping: bool) {
    state.audio.set_loop(looping);
}

#[tauri::command]
pub fn audio_set_metadata(state: State<'_, Arc<AppState>>, meta: NativeTrackMetadata) {
    state.audio.set_metadata(meta);
}

#[tauri::command]
pub fn audio_sync_queue(state: State<'_, Arc<AppState>>, snapshot: NativeQueueSnapshot) {
    state.audio.sync_queue(snapshot);
}

#[tauri::command]
pub fn audio_set_fft_enabled(state: State<'_, Arc<AppState>>, enabled: bool) {
    state.audio.set_fft_enabled(enabled);
}

// ======================== Downloads ========================

#[tauri::command]
pub fn download_get_list(state: State<'_, Arc<AppState>>) -> Vec<MediaDownloadTask> {
    state.downloads.get_task_list()
}

#[tauri::command]
pub fn download_add_task(state: State<'_, Arc<AppState>>, media: MediaDownloadTaskInput) {
    state.downloads.add_task(media);
}

#[tauri::command]
pub fn download_add_task_list(
    state: State<'_, Arc<AppState>>,
    media_list: Vec<MediaDownloadTaskInput>,
) {
    state.downloads.add_tasks(media_list);
}

#[tauri::command]
pub fn download_pause_task(state: State<'_, Arc<AppState>>, id: String) {
    state.downloads.pause_task(&id);
}

#[tauri::command]
pub fn download_resume_task(state: State<'_, Arc<AppState>>, id: String) {
    state.downloads.resume_task(&id);
}

#[tauri::command]
pub async fn download_cancel_task(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    state.downloads.cancel_task(&id).await;
    Ok(())
}

#[tauri::command]
pub fn download_retry_task(state: State<'_, Arc<AppState>>, id: String) {
    state.downloads.retry_task(&id);
}

#[tauri::command]
pub async fn download_clear_list(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.downloads.clear_tasks().await;
    Ok(())
}

// ======================== Local Music ========================

#[tauri::command]
pub async fn local_music_scan(dirs: Vec<String>) -> Result<Vec<LocalMusicItem>, String> {
    tokio::task::spawn_blocking(move || local_music::scan_local_music(dirs))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_music_resolve(
    state: State<'_, Arc<AppState>>,
    ids: Vec<String>,
) -> Result<Vec<ResolvedLocalMusic>, String> {
    let dirs = state.storage.get_local_music_dirs();
    tokio::task::spawn_blocking(move || local_music::resolve_local_music(ids, dirs))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_music_delete_file(state: State<'_, Arc<AppState>>, file_path: String) -> bool {
    local_music::delete_local_music_file(&file_path, &state.storage.get_local_music_dirs())
}

// ======================== WebDAV & Backup ========================

#[tauri::command]
pub fn webdav_get_library(state: State<'_, Arc<AppState>>) -> WebDavLibraryPublic {
    state.webdav.get_library()
}

#[tauri::command]
pub async fn webdav_test_list(
    state: State<'_, Arc<AppState>>,
    list: WebDavListInput,
) -> Result<(), String> {
    state.webdav.test_list(list).await
}

#[tauri::command]
pub async fn webdav_save_list(
    state: State<'_, Arc<AppState>>,
    list: WebDavListInput,
) -> Result<SaveWebDavListResult, String> {
    state.webdav.save_list(list).await
}

#[tauri::command]
pub async fn webdav_refresh_list(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    state.webdav.refresh_list(&id).await
}

#[tauri::command]
pub fn webdav_delete_list(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.webdav.delete_list(&id)
}

#[tauri::command]
pub async fn webdav_remove_tracks(
    state: State<'_, Arc<AppState>>,
    id: String,
    track_ids: Vec<String>,
    delete_files: Option<bool>,
) -> Result<WebDavRemoveResult, String> {
    state
        .webdav
        .remove_tracks(&id, track_ids, delete_files.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn webdav_get_track_metadata(
    state: State<'_, Arc<AppState>>,
    list_id: String,
    track_id: String,
) -> Result<WebDavTrackPublic, String> {
    state.webdav.get_track_metadata(&list_id, &track_id).await
}

#[tauri::command]
pub async fn webdav_get_lyrics(
    state: State<'_, Arc<AppState>>,
    list_id: String,
    track_id: String,
) -> Result<Option<Value>, String> {
    let (_, value) = state
        .audio
        .lyrics
        .read(
            &track_id,
            lyrics::LyricSource::WebDav(list_id.clone()),
            async {
                let text = state.webdav.get_track_lyrics(&list_id, &track_id).await?;
                Ok(text.filter(|s| !s.trim().is_empty()).map(Value::String))
            },
        )
        .await?;
    Ok(value)
}

#[tauri::command]
pub fn webdav_set_preferences(state: State<'_, Arc<AppState>>, preferences: WebDavPreferences) {
    state.webdav.set_preferences(preferences);
}

#[tauri::command]
pub fn webdav_clear_cache(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.webdav.clear_cache()
}

#[tauri::command]
pub fn webdav_get_backup_targets(state: State<'_, Arc<AppState>>) -> Vec<BackupTarget> {
    state.webdav.get_backup_targets()
}

#[tauri::command]
pub async fn webdav_list_backups(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<String>, String> {
    state.webdav.list_backups(&id).await
}

#[tauri::command]
pub async fn webdav_upload_backup(
    state: State<'_, Arc<AppState>>,
    id: String,
    text: String,
) -> Result<String, String> {
    state.webdav.upload_backup(&id, &text).await
}

#[tauri::command]
pub async fn webdav_download_backup(
    state: State<'_, Arc<AppState>>,
    id: String,
    name: String,
) -> Result<String, String> {
    state.webdav.download_backup(&id, &name).await
}
