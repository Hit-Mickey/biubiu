pub mod audio_engine;
pub mod bili_http;
pub mod commands;
pub mod desktop_lyrics;
pub mod download;
pub mod external_playlist;
pub mod font;
pub mod http_audio;
pub mod local_music;
pub mod lyrics;
pub mod media_server;
pub mod migration;
mod play_report;
pub mod shortcut;
pub mod state;
pub mod storage;
pub mod thumbar;
pub mod tray;
pub mod updater;
pub mod webdav;
pub mod window_mgr;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tauri::{Manager, RunEvent};

use crate::audio_engine::AudioEngineHandle;
use crate::bili_http::BiliHttpClient;
use crate::desktop_lyrics::DesktopLyricsManager;
use crate::download::DownloadManager;
use crate::state::AppState;
use crate::storage::StorageManager;
use crate::updater::UpdaterState;
use crate::webdav::library::WebDavManager;
use crate::window_mgr::WindowLifecycle;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                window_mgr::request_show_main(app, state.inner());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::store_get,
            commands::store_set,
            commands::store_clear,
            commands::playlist_revision,
            commands::playlist_entry,
            commands::sqlite_playlists_commit,
            commands::sqlite_history_get_all,
            commands::sqlite_history_add,
            commands::sqlite_history_replace,
            commands::dialog_select_directory,
            commands::dialog_select_file,
            commands::shell_show_file_in_folder,
            commands::shell_open_directory,
            commands::shell_open_external,
            commands::font_get_list,
            commands::app_log,
            commands::bili_http_request,
            commands::load_bilibili_cookies,
            commands::sample_audio_mirror,
            commands::cookie_get,
            commands::cookie_set,
            commands::app_get_version,
            commands::app_set_proxy,
            commands::player_update_playback_state,
            commands::external_playlist_read,
            commands::external_playlist_cancel,
            commands::lyrics_search_netease,
            commands::lyrics_get_netease,
            commands::lyrics_search_lrclib,
            commands::lyrics_search_qq,
            commands::lyrics_get_qq,
            commands::lyrics_get_track,
            commands::lyrics_update_track,
            commands::lyrics_read_local,
            commands::lyrics_get_playback_subtitles,
            commands::lyrics_save_playback_subtitles,
            commands::shortcut_register,
            commands::shortcut_unregister,
            commands::shortcut_register_all,
            commands::shortcut_unregister_all,
            commands::updater_check,
            commands::updater_download,
            commands::updater_install,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            commands::window_is_maximized,
            commands::window_is_fullscreen,
            commands::mini_player_toggle,
            commands::mini_player_get_state,
            commands::mini_player_command,
            commands::desktop_lyrics_set_visible,
            commands::desktop_lyrics_set_locked,
            commands::desktop_lyrics_set_unlock_hovered,
            commands::desktop_lyrics_set_appearance,
            commands::desktop_lyrics_get_state,
            commands::desktop_lyrics_show_line,
            commands::audio_get_state,
            commands::audio_current_track,
            commands::sleep_timer_get,
            commands::sleep_timer_set,
            commands::audio_play,
            commands::audio_pause,
            commands::audio_stop,
            commands::audio_seek,
            commands::audio_set_volume,
            commands::audio_set_muted,
            commands::audio_set_rate,
            commands::audio_set_loop,
            commands::audio_set_metadata,
            commands::audio_sync_queue,
            commands::audio_set_fft_enabled,
            commands::download_get_list,
            commands::download_add_task,
            commands::download_add_task_list,
            commands::download_pause_task,
            commands::download_resume_task,
            commands::download_cancel_task,
            commands::download_retry_task,
            commands::download_clear_list,
            commands::local_music_scan,
            commands::local_music_resolve,
            commands::local_music_delete_file,
            commands::webdav_get_library,
            commands::webdav_test_list,
            commands::webdav_save_list,
            commands::webdav_refresh_list,
            commands::webdav_delete_list,
            commands::webdav_remove_tracks,
            commands::webdav_get_track_metadata,
            commands::webdav_get_lyrics,
            commands::webdav_set_preferences,
            commands::webdav_clear_cache,
            commands::webdav_get_backup_targets,
            commands::webdav_list_backups,
            commands::webdav_upload_backup,
            commands::webdav_download_backup,
        ])
        .setup(move |app| {
            let data_dir = AppState::resolve_data_dir();
            let legacy = migration::locate(&data_dir);
            let mut notice = legacy.as_ref().map(|_| "已读取旧版配置。请重新登录 B 站，并为需要认证的 WebDAV 列表填写密码。");
            let copied = legacy.as_deref().is_some_and(|dir| {
                match migration::copy_settings(dir, &data_dir) {
                    Ok(()) => true,
                    Err(err) => {
                        eprintln!("[migration] {err}");
                        notice = Some("部分旧版配置读取失败。下次启动会重试。");
                        false
                    }
                }
            });
            let storage = Arc::new(
                StorageManager::new(data_dir.clone())
                    .expect("failed to initialize storage manager"),
            );
            if let Some(dir) = legacy.filter(|_| copied) {
                if let Err(err) = tauri::async_runtime::block_on(migration::import_library(
                    &dir, &data_dir, &storage,
                )) {
                    eprintln!("[migration] {err}");
                    notice = Some("旧曲库将在下次启动时重试。也可从旧版导出，然后在设置的「曲库与备份」中导入。");
                }
            }
            let initial_proxy = storage.get_proxy_settings();
            let http = Arc::new(
                BiliHttpClient::new(data_dir.clone(), initial_proxy)
                    .expect("failed to initialize HTTP client"),
            );
            let webdav = Arc::new(WebDavManager::new(storage.clone(), http.clone()));
            let media_token = uuid::Uuid::new_v4().to_string();

            let placeholder_ffmpeg = std::path::PathBuf::from(if cfg!(target_os = "windows") {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
            let audio = AudioEngineHandle::new(
                http.clone(),
                webdav.clone(),
                storage.clone(),
                placeholder_ffmpeg.clone(),
            );
            let downloads = DownloadManager::new(storage.clone(), http.clone(), placeholder_ffmpeg);
            let desktop_lyrics = DesktopLyricsManager::new(storage.clone());

            let resource_dir = app.path().resource_dir().ok();
            let state = Arc::new(AppState {
                data_dir,
                resource_dir,
                media_port: RwLock::new(0),
                media_token: media_token.clone(),
                storage: storage.clone(),
                http: http.clone(),
                webdav: webdav.clone(),
                audio: audio.clone(),
                downloads: downloads.clone(),
                desktop_lyrics: desktop_lyrics.clone(),
                updater: Arc::new(Mutex::new(UpdaterState::default())),
                external_playlist_cancels: Arc::new(Mutex::new(HashMap::new())),
                registered_shortcuts: Arc::new(Mutex::new(HashMap::new())),
                window_lifecycle: WindowLifecycle::new(),
                migration_notice: Mutex::new(notice),
                is_quitting: Arc::new(AtomicBool::new(false)),
            });

            let resolved_ffmpeg = state.resolve_ffmpeg_path();
            state.audio.set_ffmpeg_path(resolved_ffmpeg.clone());
            state.downloads.set_ffmpeg_path(resolved_ffmpeg);

            let port = tauri::async_runtime::block_on(media_server::start_media_server(
                media_token,
                webdav.clone(),
            ))
            .unwrap_or(0);
            *state.media_port.write() = port;

            let app_handle = app.handle().clone();
            state.webdav.set_app_handle(app_handle.clone());
            state.audio.set_app_handle(app_handle.clone());
            state.downloads.set_app_handle(app_handle.clone());

            app.manage(state.clone());

            #[cfg(not(target_os = "macos"))]
            {
                if let Err(err) = tray::setup_tray(&app_handle, &state) {
                    eprintln!("[biubiu:tray] setup failed: {err}");
                }
            }

            window_mgr::init_main_window_on_startup(&app_handle, &state)?;
            shortcut::register_all_shortcuts(&app_handle, &state);

            // Startup background jobs: Bilibili auth cookies, WebDAV refresh, update check
            let http_bg = state.http.clone();
            let webdav_bg = state.webdav.clone();
            tauri::async_runtime::spawn(async move {
                http_bg.ensure_auth_cookies().await;
            });
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                loop {
                    for id in webdav_bg.list_ids() {
                        let _ = webdav_bg.refresh_list(&id).await;
                    }
                    use chrono::{Local, TimeZone};
                    let now = Local::now();
                    let mut next = now.date_naive().and_hms_opt(11, 0, 0).unwrap();
                    if next <= now.naive_local() {
                        next = now
                            .date_naive()
                            .succ_opt()
                            .unwrap()
                            .and_hms_opt(11, 0, 0)
                            .unwrap();
                    }
                    let delay = Local
                        .from_local_datetime(&next)
                        .earliest()
                        .and_then(|value| (value - now).to_std().ok())
                        .unwrap_or(Duration::from_secs(3600));
                    tokio::time::sleep(delay).await;
                }
            });
            updater::start_background_update_check(app_handle);

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building BiuBiu Tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                if !state.is_quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        }
        RunEvent::WindowEvent { label, event, .. } => {
            if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                window_mgr::handle_run_window_event(app_handle, state.inner(), &label, &event);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                window_mgr::request_show_main(app_handle, state.inner());
            }
        }
        RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                state.downloads.quit_and_save();
                state.audio.save_progress();
                state.audio.stop();
                state.http.save_cookies();
            }
        }
        _ => {}
    });
}
