use std::collections::BTreeSet;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub name: String,
    pub family_name: String,
    pub post_script_name: String,
    pub weight: String,
    pub style: String,
    pub width: String,
    pub monospace: bool,
}

pub fn get_system_fonts() -> Vec<FontInfo> {
    let families = collect_font_families();
    families
        .into_iter()
        .map(|family| {
            let lower = family.to_lowercase();
            let monospace = lower.contains("mono")
                || lower.contains("consolas")
                || lower.contains("courier")
                || lower.contains("menlo")
                || lower.contains("code");
            FontInfo {
                name: family.clone(),
                family_name: family.clone(),
                post_script_name: family.replace(' ', "-"),
                weight: "400".to_string(),
                style: "normal".to_string(),
                width: "normal".to_string(),
                monospace,
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn collect_font_families() -> Vec<String> {
    use windows::core::w;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ,
    };

    let mut set = BTreeSet::new();
    let roots = [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER];

    for root in roots {
        let mut hkey = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                root,
                w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"),
                0,
                KEY_READ,
                &mut hkey,
            )
        };
        if status != ERROR_SUCCESS {
            continue;
        }

        let mut index = 0u32;
        let mut name_buf = vec![0u16; 512];
        loop {
            let mut name_len = name_buf.len() as u32;
            let res = unsafe {
                RegEnumValueW(
                    hkey,
                    index,
                    windows::core::PWSTR(name_buf.as_mut_ptr()),
                    &mut name_len,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if res != ERROR_SUCCESS {
                break;
            }
            index += 1;
            let raw = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            for family in parse_registry_font_name(&raw) {
                if !family.is_empty() {
                    set.insert(family);
                }
            }
        }
        unsafe {
            let _ = RegCloseKey(hkey);
        }
    }

    set.into_iter().collect()
}

#[cfg(target_os = "windows")]
fn parse_registry_font_name(raw: &str) -> Vec<String> {
    let trimmed = raw
        .trim()
        .trim_end_matches("(TrueType)")
        .trim_end_matches("(OpenType)")
        .trim_end_matches("(All res)")
        .trim();
    trimmed
        .split(" & ")
        .map(|part| {
            let mut s = part.trim().to_string();
            for suffix in [
                " Bold Italic",
                " Bold Oblique",
                " Semibold Italic",
                " Light Italic",
                " Medium Italic",
                " Regular",
                " Bold",
                " Italic",
                " Light",
                " Medium",
                " Semibold",
                " Thin",
                " Black",
                " ExtraLight",
                " ExtraBold",
            ] {
                if s.ends_with(suffix) && s.len() > suffix.len() {
                    s.truncate(s.len() - suffix.len());
                    break;
                }
            }
            s.trim().to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(target_os = "macos")]
fn collect_font_families() -> Vec<String> {
    let script = r#"ObjC.import('AppKit'); $.NSFontManager.sharedFontManager.availableFontFamilies.js.map(x => ObjC.unwrap(x)).join('\n')"#;
    std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn collect_font_families() -> Vec<String> {
    let mut set = BTreeSet::new();
    if let Ok(output) = std::process::Command::new("fc-list")
        .args([":", "family"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                for fam in line.split(',') {
                    let f = fam.trim();
                    if !f.is_empty() {
                        set.insert(f.to_string());
                    }
                }
            }
        }
    }

    if set.is_empty() {
        for fallback in [
            "PingFang SC",
            "Hiragino Sans GB",
            "Microsoft YaHei",
            "Noto Sans CJK SC",
            "Helvetica Neue",
            "Arial",
            "Sans",
            "Monospace",
        ] {
            set.insert(fallback.to_string());
        }
    }
    set.into_iter().collect()
}
