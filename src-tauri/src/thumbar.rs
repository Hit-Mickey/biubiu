use std::sync::Arc;
use tauri::{AppHandle, WebviewWindow};

use crate::state::AppState;

#[cfg(target_os = "windows")]
mod imp {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, OnceLock};

    use parking_lot::Mutex;
    use tauri::{AppHandle, Manager, WebviewWindow};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, GetDC, ReleaseDC, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        ITaskbarList3, TaskbarList, THBF_ENABLED, THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP,
        THUMBBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, CreateIconIndirect, DestroyIcon, IsWindow, RegisterWindowMessageW,
        SetWindowLongPtrW, GWLP_WNDPROC, HICON, ICONINFO, WM_COMMAND, WM_INITMENU, WM_NCDESTROY,
        WNDPROC,
    };

    use crate::audio_engine::AudioEngineHandle;
    use crate::state::AppState;

    const BTN_PREV: u32 = 40001;
    const BTN_TOGGLE: u32 = 40002;
    const BTN_NEXT: u32 = 40003;

    struct HookEntry {
        orig_proc: isize,
        audio: Arc<AudioEngineHandle>,
        prev_icon: isize,
        play_icon: isize,
        pause_icon: isize,
        next_icon: isize,
        attached: bool,
    }

    static HOOKS: OnceLock<Mutex<HashMap<isize, HookEntry>>> = OnceLock::new();
    static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);
    static LAST_PLAYING: AtomicBool = AtomicBool::new(false);

    fn hooks() -> &'static Mutex<HashMap<isize, HookEntry>> {
        HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn encode_tooltip(text: &str) -> [u16; 260] {
        let mut buf = [0u16; 260];
        for (i, unit) in text.encode_utf16().take(259).enumerate() {
            buf[i] = unit;
        }
        buf
    }

    fn load_hicon(path: &Path) -> Option<HICON> {
        let img =
            image::open(path)
                .ok()?
                .resize_exact(24, 24, image::imageops::FilterType::Lanczos3);
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut bgra = Vec::with_capacity((w * h * 4) as usize);
        for px in rgba.pixels() {
            bgra.push(px[2]);
            bgra.push(px[1]);
            bgra.push(px[0]);
            bgra.push(px[3]);
        }

        unsafe {
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let hdc = GetDC(HWND::default());
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let color_bmp: HBITMAP =
                CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            let _ = ReleaseDC(HWND::default(), hdc);
            if bits.is_null() {
                let _ = DeleteObject(color_bmp);
                return None;
            }
            std::ptr::copy_nonoverlapping(bgra.as_ptr(), bits as *mut u8, bgra.len());
            let mask_bmp = CreateBitmap(w as i32, h as i32, 1, 1, None);
            let icon_info = ICONINFO {
                fIcon: true.into(),
                xHotspot: 0,
                yHotspot: 0,
                hbmMask: mask_bmp,
                hbmColor: color_bmp,
            };
            let hicon = CreateIconIndirect(&icon_info).ok();
            let _ = DeleteObject(color_bmp);
            let _ = DeleteObject(mask_bmp);
            hicon
        }
    }

    fn build_buttons(
        is_playing: bool,
        prev_icon: isize,
        play_icon: isize,
        pause_icon: isize,
        next_icon: isize,
    ) -> [THUMBBUTTON; 3] {
        let toggle_icon = if is_playing { pause_icon } else { play_icon };
        let toggle_tip = if is_playing { "暂停" } else { "播放" };
        [
            THUMBBUTTON {
                dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                iId: BTN_PREV,
                iBitmap: 0,
                hIcon: HICON(prev_icon as *mut std::ffi::c_void),
                szTip: encode_tooltip("上一首"),
                dwFlags: THBF_ENABLED,
            },
            THUMBBUTTON {
                dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                iId: BTN_TOGGLE,
                iBitmap: 0,
                hIcon: HICON(toggle_icon as *mut std::ffi::c_void),
                szTip: encode_tooltip(toggle_tip),
                dwFlags: THBF_ENABLED,
            },
            THUMBBUTTON {
                dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                iId: BTN_NEXT,
                iBitmap: 0,
                hIcon: HICON(next_icon as *mut std::ffi::c_void),
                szTip: encode_tooltip("下一首"),
                dwFlags: THBF_ENABLED,
            },
        ]
    }

    fn apply_thumbar(hwnd: HWND, is_playing: bool, add_first: bool) {
        let icons = {
            let map = hooks().lock();
            let Some(e) = map.get(&(hwnd.0 as isize)) else {
                return;
            };
            (e.prev_icon, e.play_icon, e.pause_icon, e.next_icon)
        };
        if icons.0 == 0 || icons.1 == 0 || icons.2 == 0 || icons.3 == 0 {
            return;
        }
        let buttons = build_buttons(is_playing, icons.0, icons.1, icons.2, icons.3);
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if let Ok(taskbar) =
                CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER)
            {
                if taskbar.HrInit().is_ok() {
                    if add_first {
                        let _ = taskbar.ThumbBarAddButtons(hwnd, &buttons);
                    } else {
                        let _ = taskbar.ThumbBarUpdateButtons(hwnd, &buttons);
                    }
                }
            }
        }
    }

    unsafe extern "system" fn thumbar_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_INITMENU {
            return LRESULT(0);
        }

        let created_msg = TASKBAR_CREATED_MSG.load(Ordering::Relaxed);
        if created_msg != 0 && msg == created_msg {
            let playing = LAST_PLAYING.load(Ordering::Relaxed);
            apply_thumbar(hwnd, playing, true);
            if let Some(entry) = hooks().lock().get_mut(&(hwnd.0 as isize)) {
                entry.attached = true;
            }
        } else if msg == WM_COMMAND {
            let hi = ((wparam.0 >> 16) & 0xffff) as u32;
            if hi == THBN_CLICKED {
                let id = (wparam.0 & 0xffff) as u32;
                let audio = hooks()
                    .lock()
                    .get(&(hwnd.0 as isize))
                    .map(|e| e.audio.clone());
                if let Some(audio) = audio {
                    match id {
                        BTN_PREV => audio.dispatch_control("prev"),
                        BTN_TOGGLE => audio.dispatch_control("toggle"),
                        BTN_NEXT => audio.dispatch_control("next"),
                        _ => {}
                    }
                    return LRESULT(0);
                }
            }
        }

        let orig_proc = if msg == WM_NCDESTROY {
            hooks()
                .lock()
                .remove(&(hwnd.0 as isize))
                .map(|e| {
                    for icon in [e.prev_icon, e.play_icon, e.pause_icon, e.next_icon] {
                        if icon != 0 {
                            let _ = DestroyIcon(HICON(icon as _));
                        }
                    }
                    e.orig_proc
                })
                .unwrap_or(0)
        } else {
            hooks()
                .lock()
                .get(&(hwnd.0 as isize))
                .map(|e| e.orig_proc)
                .unwrap_or(0)
        };

        if orig_proc != 0 {
            let proc_fn: WNDPROC = std::mem::transmute(orig_proc);
            CallWindowProcW(proc_fn, hwnd, msg, wparam, lparam)
        } else {
            LRESULT(0)
        }
    }

    pub fn setup(win: &WebviewWindow, state: &Arc<AppState>) {
        let Ok(hwnd_raw) = win.hwnd() else {
            return;
        };
        let key = hwnd_raw.0 as isize;

        if TASKBAR_CREATED_MSG.load(Ordering::Relaxed) == 0 {
            let reg = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
            TASKBAR_CREATED_MSG.store(reg, Ordering::Relaxed);
        }

        let prev_icon = state
            .resolve_icon_path("prev.png")
            .and_then(|p| load_hicon(&p))
            .map(|h| h.0 as isize)
            .unwrap_or(0);
        let play_icon = state
            .resolve_icon_path("play.png")
            .and_then(|p| load_hicon(&p))
            .map(|h| h.0 as isize)
            .unwrap_or(0);
        let pause_icon = state
            .resolve_icon_path("pause.png")
            .and_then(|p| load_hicon(&p))
            .map(|h| h.0 as isize)
            .unwrap_or(0);
        let next_icon = state
            .resolve_icon_path("next.png")
            .and_then(|p| load_hicon(&p))
            .map(|h| h.0 as isize)
            .unwrap_or(0);
        let audio = state.audio.clone();

        let attach = move || {
            let hwnd = HWND(key as *mut std::ffi::c_void);
            let destroy_icons = || unsafe {
                for icon in [prev_icon, play_icon, pause_icon, next_icon] {
                    if icon != 0 {
                        let _ = DestroyIcon(HICON(icon as _));
                    }
                }
            };

            if unsafe { !IsWindow(hwnd).as_bool() } {
                destroy_icons();
                return;
            }

            {
                let mut map = hooks().lock();
                if map.contains_key(&key) {
                    destroy_icons();
                    return;
                }
                let orig_proc = unsafe {
                    SetWindowLongPtrW(
                        hwnd,
                        GWLP_WNDPROC,
                        thumbar_wndproc as *const () as usize as isize,
                    )
                };
                map.insert(
                    key,
                    HookEntry {
                        orig_proc,
                        audio: audio.clone(),
                        prev_icon,
                        play_icon,
                        pause_icon,
                        next_icon,
                        attached: false,
                    },
                );
            }

            let is_playing = audio.get_state().is_playing;
            LAST_PLAYING.store(is_playing, Ordering::Relaxed);
            apply_thumbar(hwnd, is_playing, true);
            if let Some(entry) = hooks().lock().get_mut(&key) {
                entry.attached = true;
            }
        };

        if win.run_on_main_thread(attach).is_err() {
            unsafe {
                for icon in [prev_icon, play_icon, pause_icon, next_icon] {
                    if icon != 0 {
                        let _ = DestroyIcon(HICON(icon as _));
                    }
                }
            }
        }
    }

    pub fn update_playback_state(app: &AppHandle, is_playing: bool) {
        if LAST_PLAYING.swap(is_playing, Ordering::Relaxed) == is_playing {
            return;
        }
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let Ok(hwnd_raw) = win.hwnd() else {
            return;
        };
        let hwnd_ptr = hwnd_raw.0 as isize;
        let _ = win.run_on_main_thread(move || {
            apply_thumbar(HWND(hwnd_ptr as *mut std::ffi::c_void), is_playing, false);
        });
    }
}

pub fn setup_windows_thumbar(win: &WebviewWindow, state: &Arc<AppState>) {
    #[cfg(target_os = "windows")]
    imp::setup(win, state);
    #[cfg(not(target_os = "windows"))]
    let _ = (win, state);
}

pub fn update_thumbar_state(app: &AppHandle, is_playing: bool) {
    #[cfg(target_os = "windows")]
    imp::update_playback_state(app, is_playing);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, is_playing);
}
