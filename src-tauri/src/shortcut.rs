use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::state::AppState;
use crate::window_mgr;

const SHORTCUT_DEFAULTS_VERSION: u64 = 2;

const DEFAULT_SHORTCUTS: [(&str, &str, &str, &str); 7] = [
    (
        "togglePlay",
        "播放/暂停",
        "CommandOrControl+P",
        "CommandOrControl+Alt+P",
    ),
    (
        "prev",
        "上一首",
        "CommandOrControl+Left",
        "CommandOrControl+Alt+Left",
    ),
    (
        "next",
        "下一首",
        "CommandOrControl+Right",
        "CommandOrControl+Alt+Right",
    ),
    (
        "volumeUp",
        "音量加",
        "CommandOrControl+Up",
        "CommandOrControl+Alt+Up",
    ),
    (
        "volumeDown",
        "音量减",
        "CommandOrControl+Down",
        "CommandOrControl+Alt+Down",
    ),
    (
        "toggleMiniMode",
        "切换mini/完整模式",
        "CommandOrControl+M",
        "CommandOrControl+Alt+M",
    ),
    (
        "toggleLyrics",
        "打开/关闭桌面歌词",
        "CommandOrControl+G",
        "CommandOrControl+Alt+G",
    ),
];

fn migrate_lyrics_shortcut(items: &mut [Value], is_global: bool, next: &str) {
    if items.iter().any(|item| item["shortcut"] == next) {
        return;
    }
    let previous = if is_global {
        "CommandOrControl+Alt+L"
    } else {
        "CommandOrControl+L"
    };
    if let Some(item) = items
        .iter_mut()
        .find(|item| item["id"] == "toggleLyrics" && item["shortcut"] == previous)
        .and_then(Value::as_object_mut)
    {
        item.insert("shortcut".into(), json!(next));
        item.insert("isConflict".into(), Value::Bool(false));
        item.remove("error");
    }
}

pub fn merge_default_shortcut_settings(raw: Option<Value>) -> (Value, bool) {
    let mut changed = false;
    let mut root = match raw {
        Some(Value::Object(map)) => map,
        _ => {
            changed = true;
            serde_json::Map::new()
        }
    };

    if !matches!(root.get("enableGlobalShortcuts"), Some(Value::Bool(_))) {
        root.insert("enableGlobalShortcuts".to_string(), Value::Bool(true));
        changed = true;
    }

    let stored_version = root
        .get("defaultsVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let migrate_legacy_lyrics = stored_version < SHORTCUT_DEFAULTS_VERSION;
    if migrate_legacy_lyrics {
        root.insert(
            "defaultsVersion".to_string(),
            json!(SHORTCUT_DEFAULTS_VERSION),
        );
        changed = true;
    }

    let merge_list =
        |map: &mut serde_json::Map<String, Value>, key: &str, is_global: bool| -> bool {
            let mut list_changed = false;
            if !matches!(map.get(key), Some(Value::Array(_))) {
                map.insert(key.to_string(), Value::Array(Vec::new()));
                list_changed = true;
            }
            let Some(Value::Array(arr)) = map.get_mut(key) else {
                return list_changed;
            };

            let mut existing_ids: HashSet<String> = arr
                .iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect();

            for &(id, name, local_accel, global_accel) in &DEFAULT_SHORTCUTS {
                let accel = if is_global { global_accel } else { local_accel };
                if existing_ids.contains(id) {
                    if migrate_legacy_lyrics && id == "toggleLyrics" {
                        migrate_lyrics_shortcut(arr, is_global, accel);
                    }
                    continue;
                }
                let mut item = json!({
                    "id": id,
                    "name": name,
                    "shortcut": accel,
                });
                if is_global {
                    item["isConflict"] = Value::Bool(false);
                } else if !accel.is_empty() {
                    if let Some(conflict_name) = arr.iter().find_map(|other| {
                        (other.get("shortcut").and_then(|v| v.as_str()) == Some(accel))
                            .then(|| other.get("name").and_then(|v| v.as_str()).unwrap_or(""))
                    }) {
                        item["isConflict"] = Value::Bool(true);
                        item["error"] = Value::String(format!("与“{conflict_name}”冲突"));
                    }
                }
                arr.push(item);
                existing_ids.insert(id.to_string());
                list_changed = true;
            }

            list_changed
        };

    if merge_list(&mut root, "shortcuts", false) {
        changed = true;
    }
    if merge_list(&mut root, "globalShortcuts", true) {
        changed = true;
    }

    (Value::Object(root), changed)
}

pub fn normalize_accelerator(raw: &str) -> String {
    raw.split('+')
        .map(|part| {
            let trimmed = part.trim();
            match trimmed.to_lowercase().as_str() {
                "commandorcontrol" | "cmdorctrl" => {
                    if cfg!(target_os = "macos") {
                        "Super".to_string()
                    } else {
                        "Control".to_string()
                    }
                }
                "ctrl" | "control" => "Control".to_string(),
                "cmd" | "command" | "meta" | "super" => "Super".to_string(),
                "alt" | "option" => "Alt".to_string(),
                "shift" => "Shift".to_string(),
                "left" => "ArrowLeft".to_string(),
                "right" => "ArrowRight".to_string(),
                "up" => "ArrowUp".to_string(),
                "down" => "ArrowDown".to_string(),
                "return" | "enter" => "Enter".to_string(),
                "esc" | "escape" => "Escape".to_string(),
                "space" | " " => "Space".to_string(),
                "plus" => "Equal".to_string(),
                "minus" => "Minus".to_string(),
                "backspace" => "Backspace".to_string(),
                "delete" => "Delete".to_string(),
                "tab" => "Tab".to_string(),
                "mediaplaypause" => "MediaPlayPause".to_string(),
                "medianexttrack" => "MediaTrackNext".to_string(),
                "mediaprevioustrack" => "MediaTrackPrevious".to_string(),
                "mediastop" => "MediaStop".to_string(),
                "volumeup" => "AudioVolumeUp".to_string(),
                "volumedown" => "AudioVolumeDown".to_string(),
                "volumemute" => "AudioVolumeMute".to_string(),
                other if other.len() == 1 => {
                    let ch = other.chars().next().unwrap();
                    if ch.is_ascii_alphabetic() {
                        format!("Key{}", ch.to_ascii_uppercase())
                    } else if ch.is_ascii_digit() {
                        format!("Digit{ch}")
                    } else {
                        trimmed.to_string()
                    }
                }
                _ => trimmed.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn dispatch_shortcut(app: &AppHandle, state: &Arc<AppState>, id: &str) {
    if id == "toggleLyrics" {
        window_mgr::request_toggle_desktop_lyrics(app, state);
        return;
    }

    if app.get_webview_window("main").is_some() {
        let _ = app.emit_to("main", "shortcut://command", id);
        return;
    }

    match id {
        "toggleMiniMode" => {
            window_mgr::request_toggle_mini_player(app, state);
        }
        "togglePlay" | "prev" | "next" | "volumeUp" | "volumeDown" => {
            state.audio.dispatch_control(id);
        }
        _ => {}
    }
}

pub fn register_shortcut(
    app: &AppHandle,
    state: &Arc<AppState>,
    id: &str,
    accelerator: &str,
) -> bool {
    unregister_shortcut(app, state, id);

    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        return true;
    }

    let normalized = normalize_accelerator(trimmed);
    let Ok(parsed) = Shortcut::from_str(&normalized) else {
        return false;
    };

    let id_owned = id.to_string();
    let state_clone = state.clone();
    let res = app
        .global_shortcut()
        .on_shortcut(parsed, move |app, _sc, event| {
            if event.state == ShortcutState::Pressed {
                dispatch_shortcut(app, &state_clone, &id_owned);
            }
        });

    if res.is_ok() {
        state
            .registered_shortcuts
            .lock()
            .insert(id.to_string(), normalized);
        true
    } else {
        false
    }
}

pub fn unregister_shortcut(app: &AppHandle, state: &Arc<AppState>, id: &str) {
    let prev = state.registered_shortcuts.lock().remove(id);
    if let Some(accel) = prev {
        if let Ok(parsed) = Shortcut::from_str(&accel) {
            let _ = app.global_shortcut().unregister(parsed);
        }
    }
}

pub fn unregister_all_shortcuts(app: &AppHandle, state: &Arc<AppState>) {
    let _ = app.global_shortcut().unregister_all();
    state.registered_shortcuts.lock().clear();

    if let Ok(Some(mut val)) = state.storage.read_json("shortcut-settings") {
        if let Some(arr) = val
            .get_mut("globalShortcuts")
            .and_then(|v| v.as_array_mut())
        {
            for item in arr.iter_mut() {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("isConflict".to_string(), Value::Bool(false));
                }
            }
            let _ = state.storage.write_json("shortcut-settings", &val);
        }
    }
}

pub fn register_all_shortcuts(app: &AppHandle, state: &Arc<AppState>) {
    let _ = app.global_shortcut().unregister_all();
    state.registered_shortcuts.lock().clear();

    let raw = state.storage.read_json("shortcut-settings").ok().flatten();
    let (mut val, mut changed) = merge_default_shortcut_settings(raw);
    let enabled = val
        .get("enableGlobalShortcuts")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !enabled {
        if changed {
            let _ = state.storage.write_json("shortcut-settings", &val);
        }
        return;
    }

    if let Some(arr) = val
        .get_mut("globalShortcuts")
        .and_then(|v| v.as_array_mut())
    {
        for item in arr.iter_mut() {
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let accel = item
                .get("shortcut")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let is_conflict = if !id.is_empty() && !accel.is_empty() {
                !register_shortcut(app, state, &id, &accel)
            } else {
                false
            };
            if let Some(obj) = item.as_object_mut() {
                let prev = obj.get("isConflict").and_then(|v| v.as_bool());
                if prev != Some(is_conflict) {
                    obj.insert("isConflict".to_string(), Value::Bool(is_conflict));
                    changed = true;
                }
            }
        }
    }
    if changed {
        let _ = state.storage.write_json("shortcut-settings", &val);
    }
}
