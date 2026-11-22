use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex as SyncMutex;
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::{oneshot, Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};

use crate::state::AppState;
use crate::thumbar;

const DESTROY_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAIN_THREAD_FENCE_TIMEOUT: Duration = Duration::from_secs(3);

/// Serializes every window creation and destruction across the application.
///
/// On Windows, `tauri-runtime-wry` holds its `web_context` mutex across
/// `WebView2` creation (`webview2_com::wait_with_pump`), which pumps Win32
/// messages on the main thread. If another window completes destruction
/// (`TaoWindowEvent::Destroyed` -> `WebviewWrapper::drop`) or another window
/// build runs during `wait_with_pump`, the main thread re-enters
/// `web_context.lock()` and deadlocks permanently.
#[derive(Default)]
pub struct WindowLifecycle {
    op_lock: AsyncMutex<()>,
    destroyed_waiters: SyncMutex<HashMap<String, Vec<oneshot::Sender<()>>>>,
}

impl WindowLifecycle {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn lock_op(&self) -> AsyncMutexGuard<'_, ()> {
        self.op_lock.lock().await
    }

    pub fn register_destroyed_waiter(&self, label: &str) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        self.destroyed_waiters
            .lock()
            .entry(label.to_string())
            .or_default()
            .push(tx);
        rx
    }

    pub fn notify_destroyed(&self, label: &str) {
        if let Some(waiters) = self.destroyed_waiters.lock().remove(label) {
            for tx in waiters {
                let _ = tx.send(());
            }
        }
    }

    fn clear_destroyed_waiters(&self, label: &str) {
        self.destroyed_waiters.lock().remove(label);
    }
}

/// Waits for one round-trip on the main UI event loop so any in-flight
/// `TaoWindowEvent::Destroyed` handler (including `WebviewWrapper::drop`) has
/// completely unwound before the caller proceeds.
pub async fn wait_main_thread_fence(app: &AppHandle) {
    let (tx, rx) = oneshot::channel();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(());
        })
        .is_err()
    {
        return;
    }
    let _ = tokio::time::timeout(MAIN_THREAD_FENCE_TIMEOUT, rx).await;
}

/// Destroys the window with `label` (if present) and waits until both
/// `WindowEvent::Destroyed` and a following main-thread event-loop turn finish.
pub async fn destroy_window_and_wait(app: &AppHandle, lifecycle: &WindowLifecycle, label: &str) {
    let rx = lifecycle.register_destroyed_waiter(label);
    let Some(win) = app.get_webview_window(label) else {
        lifecycle.clear_destroyed_waiters(label);
        wait_main_thread_fence(app).await;
        return;
    };

    if win.destroy().is_err() {
        lifecycle.clear_destroyed_waiters(label);
        if app.get_webview_window(label).is_none() {
            wait_main_thread_fence(app).await;
        }
        return;
    }

    let _ = tokio::time::timeout(DESTROY_WAIT_TIMEOUT, rx).await;
    lifecycle.clear_destroyed_waiters(label);
    wait_main_thread_fence(app).await;
}

/// Creates the initial main window synchronously during `tauri::Builder::setup`,
/// before the event loop begins running.
pub fn init_main_window_on_startup(
    app: &AppHandle,
    state: &Arc<AppState>,
) -> Result<WebviewWindow, String> {
    build_main_window(app, state)
}

fn build_main_window(app: &AppHandle, state: &Arc<AppState>) -> Result<WebviewWindow, String> {
    let init_script = state.runtime_init_script("main");
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("BiuBiu")
        .inner_size(1200.0, 800.0)
        .min_inner_size(1200.0, 800.0)
        .center()
        .resizable(true)
        .shadow(true)
        .initialization_script(&init_script);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let win = builder
        .build()
        .map_err(|e| format!("创建主窗口失败: {e}"))?;

    thumbar::setup_windows_thumbar(&win, state);

    let last_maximized = Arc::new(AtomicBool::new(win.is_maximized().unwrap_or(false)));
    let last_fullscreen = Arc::new(AtomicBool::new(win.is_fullscreen().unwrap_or(false)));
    let win_clone = win.clone();
    let app_clone = app.clone();

    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
            let is_max = win_clone.is_maximized().unwrap_or(false);
            if last_maximized.swap(is_max, Ordering::Relaxed) != is_max {
                let _ = app_clone.emit_to("main", "window://maximize-change", is_max);
            }
            let is_fs = win_clone.is_fullscreen().unwrap_or(false);
            if last_fullscreen.swap(is_fs, Ordering::Relaxed) != is_fs {
                let _ = app_clone.emit_to("main", "window://fullscreen-change", is_fs);
            }
        }
    });

    Ok(win)
}

fn build_mini_window(app: &AppHandle, state: &AppState) -> Result<WebviewWindow, String> {
    let init_script = state.runtime_init_script("mini");
    WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("mini.html".into()))
        .title("BiuBiu Mini Player")
        .inner_size(348.0, 100.0)
        .resizable(false)
        .center()
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .initialization_script(&init_script)
        .build()
        .map_err(|e| format!("创建迷你窗口失败: {e}"))
}

async fn ensure_main_window_locked(
    app: &AppHandle,
    state: &Arc<AppState>,
) -> Result<WebviewWindow, String> {
    if let Some(win) = app.get_webview_window("main") {
        let win_focus = win.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = win_focus.unminimize();
            let _ = win_focus.show();
            let _ = win_focus.set_focus();
        })
        .await;
        return Ok(win);
    }

    wait_main_thread_fence(app).await;
    let app_clone = app.clone();
    let state_clone = state.clone();
    tokio::task::spawn_blocking(move || build_main_window(&app_clone, &state_clone))
        .await
        .map_err(|e| format!("创建主窗口任务失败: {e}"))?
}

pub async fn toggle_mini_player_async(
    app: &AppHandle,
    state: &Arc<AppState>,
) -> Result<(), String> {
    let _guard = state.window_lifecycle.lock_op().await;
    if state.is_quitting.load(Ordering::SeqCst) {
        return Ok(());
    }

    if app.get_webview_window("mini").is_some() {
        destroy_window_and_wait(app, &state.window_lifecycle, "mini").await;
        if state.is_quitting.load(Ordering::SeqCst) {
            return Ok(());
        }
        let _ = ensure_main_window_locked(app, state).await?;
        return Ok(());
    }

    wait_main_thread_fence(app).await;
    let app_clone = app.clone();
    let state_clone = state.clone();
    let _mini = tokio::task::spawn_blocking(move || build_mini_window(&app_clone, &state_clone))
        .await
        .map_err(|e| format!("创建迷你窗口任务失败: {e}"))??;

    destroy_window_and_wait(app, &state.window_lifecycle, "main").await;
    Ok(())
}

pub fn request_toggle_mini_player(app: &AppHandle, state: &Arc<AppState>) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = toggle_mini_player_async(&app, &state).await {
            eprintln!("[biubiu:window] toggle mini player failed: {err}");
        }
    });
}

pub fn request_show_main(app: &AppHandle, state: &Arc<AppState>) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = state.window_lifecycle.lock_op().await;
        if state.is_quitting.load(Ordering::SeqCst) {
            return;
        }
        destroy_window_and_wait(&app, &state.window_lifecycle, "mini").await;
        if state.is_quitting.load(Ordering::SeqCst) {
            return;
        }
        if let Err(err) = ensure_main_window_locked(&app, &state).await {
            eprintln!("[biubiu:window] show main failed: {err}");
        }
    });
}

pub fn request_toggle_main_visibility(app: &AppHandle, state: &Arc<AppState>) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = state.window_lifecycle.lock_op().await;
        if state.is_quitting.load(Ordering::SeqCst) {
            return;
        }
        if let Some(main_win) = app.get_webview_window("main") {
            let visible_and_open = tokio::task::spawn_blocking(move || {
                main_win.is_visible().unwrap_or(false) && !main_win.is_minimized().unwrap_or(false)
            })
            .await
            .unwrap_or(false);
            if visible_and_open {
                destroy_window_and_wait(&app, &state.window_lifecycle, "main").await;
                return;
            }
        }
        destroy_window_and_wait(&app, &state.window_lifecycle, "mini").await;
        if state.is_quitting.load(Ordering::SeqCst) {
            return;
        }
        if let Err(err) = ensure_main_window_locked(&app, &state).await {
            eprintln!("[biubiu:window] toggle main visibility failed: {err}");
        }
    });
}

pub fn request_open_main_and_navigate(app: &AppHandle, state: &Arc<AppState>, route: &str) {
    let app = app.clone();
    let state = state.clone();
    let target = route.to_string();
    tauri::async_runtime::spawn(async move {
        let _guard = state.window_lifecycle.lock_op().await;
        if state.is_quitting.load(Ordering::SeqCst) {
            return;
        }
        destroy_window_and_wait(&app, &state.window_lifecycle, "mini").await;
        if state.is_quitting.load(Ordering::SeqCst) {
            return;
        }
        let existed = app.get_webview_window("main").is_some();
        if ensure_main_window_locked(&app, &state).await.is_err() {
            return;
        }
        if existed {
            let _ = app.emit_to("main", "router://navigate", &target);
        } else {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(450)).await;
                let _ = app_clone.emit_to("main", "router://navigate", &target);
            });
        }
    });
}

pub fn request_destroy_window(app: &AppHandle, state: &Arc<AppState>, label: &str) {
    let app = app.clone();
    let state = state.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let _guard = state.window_lifecycle.lock_op().await;
        destroy_window_and_wait(&app, &state.window_lifecycle, &label).await;
    });
}

pub fn request_toggle_desktop_lyrics(app: &AppHandle, state: &Arc<AppState>) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = state
            .desktop_lyrics
            .toggle_visible_async(&app, &state)
            .await
        {
            eprintln!("[biubiu:lyrics] toggle desktop lyrics failed: {err}");
        }
    });
}

pub fn request_desktop_lyrics_visible(app: &AppHandle, state: &Arc<AppState>, visible: bool) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = state
            .desktop_lyrics
            .set_visible_async(&app, &state, visible)
            .await
        {
            eprintln!("[biubiu:lyrics] set desktop lyrics visible failed: {err}");
        }
    });
}

pub fn handle_close_request(app: &AppHandle, state: &Arc<AppState>, label: &str) {
    if state.is_quitting.load(Ordering::SeqCst) {
        return;
    }
    match label {
        "main" => {
            let close_opt = state.storage.get_close_window_option();
            if close_opt == "exit" {
                request_quit(app, state);
            } else {
                request_destroy_window(app, state, "main");
            }
        }
        "mini" => request_destroy_window(app, state, "mini"),
        "desktop-lyrics" => request_desktop_lyrics_visible(app, state, false),
        other => request_destroy_window(app, state, other),
    }
}

pub fn handle_run_window_event(
    app: &AppHandle,
    state: &Arc<AppState>,
    label: &str,
    event: &WindowEvent,
) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if state.is_quitting.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            handle_close_request(app, state, label);
        }
        WindowEvent::Destroyed => {
            state.window_lifecycle.notify_destroyed(label);
            match label {
                "main" => state.audio.set_fft_enabled(false),
                "mini" => {
                    let _ = app.emit("mini://closed", ());
                }
                "desktop-lyrics" => state.desktop_lyrics.on_window_destroyed(app),
                _ => {}
            }
        }
        _ => {}
    }
}

pub fn request_quit(app: &AppHandle, state: &Arc<AppState>) {
    if state.is_quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = state.window_lifecycle.lock_op().await;
        state.downloads.quit_and_save();
        state.audio.save_progress();
        state.audio.stop();
        state.http.save_cookies();
        destroy_window_and_wait(&app, &state.window_lifecycle, "desktop-lyrics").await;
        destroy_window_and_wait(&app, &state.window_lifecycle, "mini").await;
        destroy_window_and_wait(&app, &state.window_lifecycle, "main").await;
        app.exit(0);
    });
}
