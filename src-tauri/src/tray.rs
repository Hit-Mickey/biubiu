use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::state::AppState;
use crate::window_mgr;

pub fn setup_tray(app: &AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    let toggle = MenuItem::with_id(app, "toggle", "播放/暂停", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let prev =
        MenuItem::with_id(app, "prev", "上一曲", true, None::<&str>).map_err(|e| e.to_string())?;
    let next =
        MenuItem::with_id(app, "next", "下一曲", true, None::<&str>).map_err(|e| e.to_string())?;
    let toggle_vis = MenuItem::with_id(app, "toggle_visible", "显示/隐藏界面", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let exit = MenuItem::with_id(app, "exit", "退出程序", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
        app,
        &[&toggle, &prev, &next, &toggle_vis, &sep, &settings, &exit],
    )
    .map_err(|e| e.to_string())?;

    let icon = load_tray_icon(app, state);

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("BiuBiu")
        .menu(&menu)
        .show_menu_on_left_click(false);

    if let Some(img) = icon {
        builder = builder.icon(img);
    }

    let state_menu = state.clone();
    let state_click = state.clone();

    builder
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "toggle" => state_menu.audio.dispatch_control("toggle"),
            "prev" => state_menu.audio.dispatch_control("prev"),
            "next" => state_menu.audio.dispatch_control("next"),
            "toggle_visible" => window_mgr::request_toggle_main_visibility(app, &state_menu),
            "settings" => window_mgr::request_open_main_and_navigate(app, &state_menu, "/settings"),
            "exit" => window_mgr::request_quit(app, &state_menu),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                window_mgr::request_show_main(app, &state_click);
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn load_tray_icon(app: &AppHandle, state: &AppState) -> Option<Image<'static>> {
    let icon_name = if cfg!(target_os = "windows") {
        "tray.ico"
    } else {
        "logo.png"
    };
    if let Some(path) = state.resolve_icon_path(icon_name) {
        if let Ok(img) = image::open(&path) {
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            return Some(Image::new_owned(rgba.into_raw(), w, h));
        }
    }
    app.default_window_icon().cloned().map(|img| img.to_owned())
}
