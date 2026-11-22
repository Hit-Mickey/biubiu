use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio_util::sync::CancellationToken;

use crate::state::AppState;
use crate::storage::StorageManager;

const ALLOWED_FONT_SIZES: [u32; 7] = [16, 20, 23, 26, 30, 36, 42];
const DEFAULT_COLOR: &str = "#ffffff";
const DEFAULT_FONT_SIZE: u32 = 26;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLyricsAppearance {
    pub color: String,
    pub font_size: u32,
    pub split_bilingual: bool,
}

impl Default for DesktopLyricsAppearance {
    fn default() -> Self {
        Self {
            color: DEFAULT_COLOR.to_string(),
            font_size: DEFAULT_FONT_SIZE,
            split_bilingual: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLyricsAppearancePatch {
    pub color: Option<String>,
    pub font_size: Option<u32>,
    pub split_bilingual: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLyricsWindowState {
    pub open: bool,
    pub locked: bool,
    pub inline_unlock: bool,
    pub appearance: DesktopLyricsAppearance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLyricLine {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub romanization: Option<String>,
}

struct InnerState {
    open: bool,
    locked: bool,
    appearance: DesktopLyricsAppearance,
    last_line: Option<DesktopLyricLine>,
    hover_cancel: Option<CancellationToken>,
}

pub struct DesktopLyricsManager {
    storage: Arc<StorageManager>,
    inner: Mutex<InnerState>,
}

impl DesktopLyricsManager {
    pub fn new(storage: Arc<StorageManager>) -> Arc<Self> {
        let appearance = load_saved_appearance(&storage);
        Arc::new(Self {
            storage,
            inner: Mutex::new(InnerState {
                open: false,
                locked: false,
                appearance,
                last_line: None,
                hover_cancel: None,
            }),
        })
    }

    fn inline_unlock() -> bool {
        cfg!(any(target_os = "windows", target_os = "macos"))
    }

    pub fn get_state(&self) -> DesktopLyricsWindowState {
        let g = self.inner.lock();
        DesktopLyricsWindowState {
            open: g.open,
            locked: g.locked,
            inline_unlock: Self::inline_unlock(),
            appearance: g.appearance.clone(),
        }
    }

    fn emit_state(&self, app: &AppHandle) {
        let snapshot = self.get_state();
        let _ = app.emit("desktop-lyrics://state", &snapshot);
    }

    pub fn on_window_destroyed(&self, app: &AppHandle) {
        let changed = {
            let mut g = self.inner.lock();
            if let Some(cancel) = g.hover_cancel.take() {
                cancel.cancel();
            }
            let was_active = g.open || g.locked;
            g.open = false;
            g.locked = false;
            was_active
        };
        if changed {
            self.emit_state(app);
        }
    }

    pub async fn set_visible_async(
        self: &Arc<Self>,
        app: &AppHandle,
        state: &Arc<AppState>,
        visible: bool,
    ) -> Result<(), String> {
        let _guard = state.window_lifecycle.lock_op().await;
        if state.is_quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        self.set_visible_locked(app, state, visible).await
    }

    pub async fn toggle_visible_async(
        self: &Arc<Self>,
        app: &AppHandle,
        state: &Arc<AppState>,
    ) -> Result<(), String> {
        let _guard = state.window_lifecycle.lock_op().await;
        if state.is_quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        let open = self.inner.lock().open;
        self.set_visible_locked(app, state, !open).await
    }

    async fn set_visible_locked(
        self: &Arc<Self>,
        app: &AppHandle,
        state: &AppState,
        visible: bool,
    ) -> Result<(), String> {
        if !visible {
            {
                let mut g = self.inner.lock();
                if let Some(cancel) = g.hover_cancel.take() {
                    cancel.cancel();
                }
                g.open = false;
                g.locked = false;
            }
            crate::window_mgr::destroy_window_and_wait(
                app,
                &state.window_lifecycle,
                "desktop-lyrics",
            )
            .await;
            self.emit_state(app);
            return Ok(());
        }

        if app.get_webview_window("desktop-lyrics").is_some() {
            self.inner.lock().open = true;
            self.emit_state(app);
            return Ok(());
        }

        crate::window_mgr::wait_main_thread_fence(app).await;

        let app_build = app.clone();
        let init_script = state.runtime_init_script("desktop-lyrics");
        let height = overlay_height(self.inner.lock().appearance.font_size);
        tokio::task::spawn_blocking(move || {
            let (x, y, width) = compute_overlay_geometry(&app_build, height);
            WebviewWindowBuilder::new(
                &app_build,
                "desktop-lyrics",
                WebviewUrl::App("desktop-lyrics.html".into()),
            )
            .title("桌面歌词")
            .inner_size(width, height)
            .position(x, y)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .initialization_script(&init_script)
            .build()
            .map_err(|e| format!("创建桌面歌词窗口失败: {e}"))?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("创建桌面歌词窗口任务失败: {e}"))??;

        let cancel = CancellationToken::new();
        let (cached_line, height_changed) = {
            let mut g = self.inner.lock();
            if let Some(old) = g.hover_cancel.replace(cancel.clone()) {
                old.cancel();
            }
            g.open = true;
            g.locked = false;
            (
                g.last_line.clone(),
                height != overlay_height(g.appearance.font_size),
            )
        };

        if height_changed {
            self.sync_overlay_height(app);
        }
        self.emit_state(app);
        self.spawn_hover_watcher(app.clone(), cancel);

        if let Some(line) = cached_line {
            let app_emit = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let _ = app_emit.emit_to("desktop-lyrics", "desktop-lyrics://line", &line);
            });
        }

        Ok(())
    }

    pub fn set_locked(&self, app: &AppHandle, next: bool) -> Result<(), String> {
        let should_apply = {
            let mut g = self.inner.lock();
            if !g.open || g.locked == next {
                false
            } else {
                g.locked = next;
                true
            }
        };
        if !should_apply {
            return Ok(());
        }
        if let Some(win) = app.get_webview_window("desktop-lyrics") {
            let _ = win.set_ignore_cursor_events(next);
        }
        self.emit_state(app);
        Ok(())
    }

    pub fn set_unlock_hovered(&self, app: &AppHandle, hovered: bool) {
        let active_locked = {
            let g = self.inner.lock();
            Self::inline_unlock() && g.open && g.locked
        };
        if !active_locked {
            return;
        }
        if let Some(win) = app.get_webview_window("desktop-lyrics") {
            let _ = win.set_ignore_cursor_events(!hovered);
        }
    }

    pub fn set_appearance(
        self: &Arc<Self>,
        app: &AppHandle,
        patch: DesktopLyricsAppearancePatch,
    ) -> Result<(), String> {
        let height_changed = {
            let mut g = self.inner.lock();
            let next = normalize_appearance(patch, &g.appearance);
            if next == g.appearance {
                return Ok(());
            }
            let val = serde_json::to_value(&next).map_err(|e| e.to_string())?;
            self.storage.write_json("desktop-lyrics", &val)?;
            let changed = overlay_height(g.appearance.font_size) != overlay_height(next.font_size);
            g.appearance = next;
            changed
        };
        if height_changed {
            self.sync_overlay_height(app);
        }
        self.emit_state(app);
        Ok(())
    }

    fn sync_overlay_height(self: &Arc<Self>, app: &AppHandle) {
        let Some(win) = app.get_webview_window("desktop-lyrics") else {
            return;
        };
        let manager = self.clone();
        let _ = app.run_on_main_thread(move || {
            let height = overlay_height(manager.inner.lock().appearance.font_size);
            let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) else {
                return;
            };
            let pixels = (height * scale).round() as u32;
            if size.height == pixels {
                return;
            }
            let position = win.outer_position().ok();
            if win
                .set_size(tauri::PhysicalSize::new(size.width, pixels))
                .is_err()
            {
                return;
            }
            if let Some(mut pos) = position {
                pos.y += size.height as i32 - pixels as i32;
                if let Ok(Some(monitor)) = win.current_monitor() {
                    pos.y = pos.y.max(monitor.work_area().position.y);
                }
                let _ = win.set_position(pos);
            }
        });
    }

    pub fn show_line(&self, app: &AppHandle, line: DesktopLyricLine) {
        let open = {
            let mut g = self.inner.lock();
            g.last_line = Some(line.clone());
            g.open
        };
        if open {
            let _ = app.emit_to("desktop-lyrics", "desktop-lyrics://line", &line);
        }
    }

    fn spawn_hover_watcher(self: &Arc<Self>, app: AppHandle, cancel: CancellationToken) {
        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut prev_hovered: Option<bool> = None;
            let mut prev_ignore: Option<bool> = None;
            let mut ticker = tokio::time::interval(Duration::from_millis(70));

            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = ticker.tick() => {}
                }

                let Some(win) = app.get_webview_window("desktop-lyrics") else {
                    break;
                };
                let visible = win.is_visible().unwrap_or(false);
                let Ok(cursor) = app.cursor_position() else {
                    continue;
                };
                let Ok(pos) = win.outer_position() else {
                    continue;
                };
                let Ok(size) = win.outer_size() else {
                    continue;
                };
                let scale = win.scale_factor().unwrap_or(1.0);

                let px = pos.x as f64;
                let py = pos.y as f64;
                let pw = size.width as f64;
                let ph = size.height as f64;
                let hovered = visible
                    && cursor.x >= px
                    && cursor.x < px + pw
                    && cursor.y >= py
                    && cursor.y < py + ph;

                if Some(hovered) != prev_hovered {
                    prev_hovered = Some(hovered);
                    let _ = app.emit_to("desktop-lyrics", "desktop-lyrics://hover", hovered);
                }

                let (open, locked) = {
                    let g = mgr.inner.lock();
                    (g.open, g.locked)
                };
                if open && locked && Self::inline_unlock() {
                    let logical_x = (cursor.x - px) / scale;
                    let logical_y = (cursor.y - py) / scale;
                    let logical_w = pw / scale;
                    let center_x = logical_w / 2.0;
                    let in_unlock_zone = hovered
                        && (logical_x - center_x).abs() <= 54.0
                        && (0.0..=38.0).contains(&logical_y);
                    let should_ignore = !in_unlock_zone;
                    if Some(should_ignore) != prev_ignore {
                        prev_ignore = Some(should_ignore);
                        let _ = win.set_ignore_cursor_events(should_ignore);
                    }
                } else {
                    prev_ignore = None;
                }
            }
        });
    }
}

fn normalize_appearance(
    patch: DesktopLyricsAppearancePatch,
    fallback: &DesktopLyricsAppearance,
) -> DesktopLyricsAppearance {
    let color = patch
        .color
        .filter(|c| is_valid_hex_color(c))
        .map(|c| c.to_lowercase())
        .unwrap_or_else(|| fallback.color.clone());
    let font_size = patch
        .font_size
        .filter(|s| ALLOWED_FONT_SIZES.contains(s))
        .unwrap_or(fallback.font_size);
    DesktopLyricsAppearance {
        color,
        font_size,
        split_bilingual: patch.split_bilingual.unwrap_or(fallback.split_bilingual),
    }
}

fn is_valid_hex_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

fn load_saved_appearance(storage: &StorageManager) -> DesktopLyricsAppearance {
    let raw = storage.read_json("desktop-lyrics").ok().flatten();
    let patch = raw
        .and_then(|v| serde_json::from_value::<DesktopLyricsAppearancePatch>(v).ok())
        .unwrap_or_default();
    normalize_appearance(patch, &DesktopLyricsAppearance::default())
}

fn overlay_height(font_size: u32) -> f64 {
    // Reserve the toolbar and three 1.25em rows so a romanization can appear without moving the lyrics.
    (40.0 + 3.0 * 1.25 * f64::from(font_size)).ceil().max(144.0)
}

fn compute_overlay_geometry(app: &AppHandle, height: f64) -> (f64, f64, f64) {
    let monitor = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("mini"))
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let area = m.work_area();
        let area_x = area.position.x as f64 / scale;
        let area_y = area.position.y as f64 / scale;
        let area_w = area.size.width as f64 / scale;
        let area_h = area.size.height as f64 / scale;
        let width = (area_w - 24.0).clamp(360.0, 800.0);
        let x = area_x + ((area_w - width) / 2.0).round();
        let y = area_y + area_h - height - 20.0;
        return (x, y, width);
    }

    (200.0, 844.0 - height, 800.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_fits_three_equal_sized_rows_at_every_supported_font_size() {
        assert_eq!(overlay_height(DEFAULT_FONT_SIZE), 144.0);
        for size in ALLOWED_FONT_SIZES {
            let lyrics = 3.0 * f64::from(size) * 1.25;
            assert!(overlay_height(size) >= 38.0 + lyrics);
        }
    }

    #[test]
    fn the_bilingual_layout_defaults_on_and_survives_appearance_edits_and_reload() {
        let legacy: DesktopLyricsAppearancePatch =
            serde_json::from_str(r##"{"color":"#aabbcc","fontSize":30}"##).unwrap();
        let initial = normalize_appearance(legacy, &DesktopLyricsAppearance::default());
        assert!(initial.split_bilingual);
        let single = normalize_appearance(
            DesktopLyricsAppearancePatch {
                split_bilingual: Some(false),
                ..Default::default()
            },
            &initial,
        );
        let saved: DesktopLyricsAppearancePatch =
            serde_json::from_value(serde_json::to_value(&single).unwrap()).unwrap();
        assert_eq!(
            normalize_appearance(saved, &DesktopLyricsAppearance::default()),
            single
        );
        assert!(
            !normalize_appearance(
                DesktopLyricsAppearancePatch {
                    font_size: Some(42),
                    ..Default::default()
                },
                &single
            )
            .split_bilingual
        );
    }
}
