use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::state::AppState;

const GITHUB_RELEASES_URL: &str = "https://api.github.com/repos/Hit-Mickey/biubiu/releases/latest";

#[derive(Debug, Default)]
pub struct UpdaterState {
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
    asset: Option<GithubAsset>,
    downloaded_file: Option<(PathBuf, String)>,
    pub is_downloading: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateReleaseInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckAppUpdateResult {
    pub is_update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_published_releases: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadAppProgressInfo {
    pub total: u64,
    pub delta: u64,
    pub transferred: u64,
    pub percent: f64,
    pub bytes_per_second: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadAppMessage {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_info: Option<DownloadAppProgressInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_info: Option<DownloadInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}

pub async fn check_for_updates(state: &AppState) -> CheckAppUpdateResult {
    match fetch_latest_release(state).await {
        Ok(Some(release)) => {
            let latest_clean = release.tag_name.trim().trim_start_matches('v').to_string();
            let is_newer = Version::parse(&latest_clean).is_ok_and(|v| {
                v.pre.is_empty()
                    && v > Version::parse(env!("CARGO_PKG_VERSION")).expect("Cargo version")
            });
            let asset = is_newer
                .then(|| {
                    select_platform_asset(
                        &release.assets,
                        std::env::consts::OS,
                        std::env::consts::ARCH,
                    )
                })
                .flatten()
                .cloned();
            {
                let mut u = state.updater.lock();
                if u.asset != asset {
                    u.downloaded_file = None;
                }
                u.latest_version = Some(latest_clean.clone());
                u.release_notes = release.body.clone();
                u.asset = asset;
            }

            if is_newer {
                CheckAppUpdateResult {
                    is_update_available: true,
                    latest_version: Some(latest_clean),
                    release_notes: release.body,
                    no_published_releases: None,
                    error: None,
                }
            } else {
                CheckAppUpdateResult {
                    is_update_available: false,
                    latest_version: Some(latest_clean),
                    release_notes: None,
                    no_published_releases: None,
                    error: None,
                }
            }
        }
        Ok(None) => CheckAppUpdateResult {
            is_update_available: false,
            latest_version: None,
            release_notes: None,
            no_published_releases: Some(true),
            error: None,
        },
        Err(err) => CheckAppUpdateResult {
            is_update_available: false,
            latest_version: None,
            release_notes: None,
            no_published_releases: None,
            error: Some(err),
        },
    }
}

async fn fetch_latest_release(state: &AppState) -> Result<Option<GithubRelease>, String> {
    let resp = state
        .http
        .plain_client()
        .get(GITHUB_RELEASES_URL)
        .header(USER_AGENT, format!("BiuBiu/{}", env!("CARGO_PKG_VERSION")))
        .header(ACCEPT, "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("无法获取更新信息: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回 HTTP {}", resp.status().as_u16()));
    }

    let release: GithubRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析发布信息失败: {e}"))?;
    Ok((!release.draft && !release.prerelease).then_some(release))
}

pub fn is_portable() -> bool {
    cfg!(windows)
        && std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|dir| dir.join("portable.flag")))
            .is_some_and(|p| p.is_file())
}

fn select_platform_asset<'a>(
    assets: &'a [GithubAsset],
    os: &str,
    arch: &str,
) -> Option<&'a GithubAsset> {
    let suffixes: &[&str] = match os {
        "windows" if is_portable() => &["-portable.zip"],
        "windows" => &["-setup.exe", ".msi"],
        "macos" => &[".dmg"],
        "linux" if std::env::var_os("APPIMAGE").is_some() => &[".appimage"],
        "linux" if Path::new("/etc/debian_version").exists() => &[".deb", ".appimage"],
        "linux" => &[".rpm", ".appimage"],
        _ => return None,
    };
    let aliases: &[&str] = match arch {
        "x86_64" => &["x64", "x86_64", "amd64"],
        "aarch64" => &["arm64", "aarch64"],
        _ => return None,
    };
    suffixes.iter().find_map(|suffix| {
        assets.iter().find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.ends_with(suffix)
                && aliases.iter().any(|alias| {
                    name.match_indices(alias).any(|(index, token)| {
                        let after = &name[index + token.len()..];
                        !name[..index].ends_with(|c: char| c.is_ascii_alphanumeric())
                            && !after.starts_with(|c: char| c.is_ascii_alphanumeric())
                    })
                })
        })
    })
}

fn verified_digest(asset: &GithubAsset) -> Result<&str, String> {
    if Path::new(&asset.name).file_name().and_then(|n| n.to_str()) != Some(asset.name.as_str())
        || !asset
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !asset
            .browser_download_url
            .starts_with("https://github.com/Hit-Mickey/biubiu/releases/download/")
    {
        return Err("安装包地址无效".into());
    }
    asset
        .digest
        .as_deref()
        .and_then(|s| s.strip_prefix("sha256:"))
        .filter(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| "发布资源缺少 SHA-256 校验值".into())
}

pub async fn download_update(app: AppHandle, state: Arc<AppState>) -> Result<(), String> {
    let asset = {
        let mut u = state.updater.lock();
        if u.is_downloading {
            return Ok(());
        }
        let asset = u.asset.clone().ok_or("该正式版没有本系统和架构的安装包")?;
        verified_digest(&asset)?;
        u.is_downloading = true;
        u.downloaded_file = None;
        asset
    };

    let mut result = stream_installer(&app, &state, &asset).await;
    {
        let mut u = state.updater.lock();
        u.is_downloading = false;
        if u.asset.as_ref() != Some(&asset) {
            result = Err("发布版本已变更，请重新下载".into());
        }
        if let Ok(file) = &result {
            u.downloaded_file = Some((file.clone(), verified_digest(&asset)?.to_string()));
        }
    }
    match result {
        Ok(file_path) => {
            let _ = app.emit(
                "updater://progress",
                DownloadAppMessage {
                    status: "downloaded",
                    process_info: None,
                    download_info: Some(DownloadInfo {
                        file_path: file_path.to_string_lossy().to_string(),
                    }),
                    error: None,
                },
            );
            Ok(())
        }
        Err(err) => {
            let _ = app.emit(
                "updater://progress",
                DownloadAppMessage {
                    status: "error",
                    process_info: None,
                    download_info: None,
                    error: Some(err.clone()),
                },
            );
            Err(err)
        }
    }
}

async fn stream_installer(
    app: &AppHandle,
    state: &AppState,
    asset: &GithubAsset,
) -> Result<PathBuf, String> {
    let expected = verified_digest(asset)?;
    let update_dir = state.data_dir.join("updates");
    tokio::fs::create_dir_all(&update_dir)
        .await
        .map_err(|e| e.to_string())?;
    let dest = update_dir.join(&asset.name);

    let resp = state
        .http
        .plain_client()
        .get(&asset.browser_download_url)
        .header(USER_AGENT, format!("BiuBiu/{}", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|e| format!("下载更新失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("下载更新返回 HTTP {}", resp.status().as_u16()));
    }

    let total = asset.size;
    let tmp = tempfile::NamedTempFile::new_in(&update_dir).map_err(|e| e.to_string())?;
    let (file, temp_path) = tmp.into_parts();
    let mut file = tokio::fs::File::from_std(file);
    let mut hash = Sha256::new();
    let mut stream = resp.bytes_stream();

    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut transferred = 0u64;
    let mut delta_acc = 0u64;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("读取更新流失败: {e}"))?;
        hash.update(&bytes);
        file.write_all(&bytes)
            .await
            .map_err(|e| format!("写入更新文件失败: {e}"))?;
        let n = bytes.len() as u64;
        transferred += n;
        delta_acc += n;

        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = Instant::now();
            let elapsed_secs = started.elapsed().as_secs_f64().max(0.001);
            let bps = (transferred as f64 / elapsed_secs) as u64;
            let percent = if total > 0 {
                ((transferred as f64 / total as f64) * 100.0).min(100.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "updater://progress",
                DownloadAppMessage {
                    status: "downloading",
                    process_info: Some(DownloadAppProgressInfo {
                        total,
                        delta: delta_acc,
                        transferred,
                        percent,
                        bytes_per_second: bps,
                    }),
                    download_info: None,
                    error: None,
                },
            );
            delta_acc = 0;
        }
    }

    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if transferred != total || !expected.eq_ignore_ascii_case(&hex::encode(hash.finalize())) {
        return Err("安装包大小或 SHA-256 校验失败，请重新下载".into());
    }
    temp_path.persist(&dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

pub fn install_update(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let (file, expected) = state
        .updater
        .lock()
        .downloaded_file
        .clone()
        .ok_or_else(|| "尚未下载安装包".to_string())?;

    if !file.is_file() {
        return Err("更新安装包文件不存在".to_string());
    }

    let mut source = std::fs::File::open(&file).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    std::io::copy(&mut source, &mut hash).map_err(|e| e.to_string())?;
    if !expected.eq_ignore_ascii_case(&hex::encode(hash.finalize())) {
        return Err("安装包校验失败".into());
    }
    drop(source);

    #[cfg(target_os = "windows")]
    {
        let mut cmd = if file.extension().is_some_and(|e| e == "msi") {
            let mut cmd = std::process::Command::new("msiexec.exe");
            cmd.arg("/i").arg(&file);
            cmd
        } else {
            std::process::Command::new(&file)
        };
        cmd.spawn().map_err(|e| format!("启动安装程序失败: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file)
            .spawn()
            .map_err(|e| format!("打开安装包失败: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        if file
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("AppImage"))
        {
            use std::os::unix::fs::PermissionsExt;
            let installed = std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .ok_or("请手动替换 AppImage")?;
            let parent = installed.parent().ok_or("原 AppImage 路径无效")?;
            let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            std::io::copy(
                &mut std::fs::File::open(&file).map_err(|e| e.to_string())?,
                &mut tmp,
            )
            .map_err(|e| e.to_string())?;
            tmp.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
            tmp.persist(&installed).map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("xdg-open")
                .arg(&file)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    state
        .is_quitting
        .store(true, std::sync::atomic::Ordering::SeqCst);
    state.downloads.quit_and_save();
    app.exit(0);
    Ok(())
}

pub fn start_background_update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let state = app.state::<Arc<AppState>>();
            let res = check_for_updates(state.inner()).await;
            if res.is_update_available {
                let _ = app.emit(
                    "updater://available",
                    AppUpdateReleaseInfo {
                        latest_version: res.latest_version,
                        release_notes: res.release_notes,
                    },
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installers_match_architecture_and_require_a_digest() {
        let asset = |name: &str| GithubAsset {
            name: name.into(),
            browser_download_url: format!(
                "https://github.com/Hit-Mickey/biubiu/releases/download/v2.0.0/{name}"
            ),
            size: 4,
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        };
        let assets = [
            asset("BiuBiu_arm64-setup.exe"),
            asset("BiuBiu_x64-setup.exe"),
            asset("BiuBiu_arm64.dmg"),
        ];
        assert_eq!(
            select_platform_asset(&assets, "windows", "x86_64"),
            Some(&assets[1])
        );
        assert_eq!(
            select_platform_asset(&assets, "macos", "aarch64"),
            Some(&assets[2])
        );
        assert!(select_platform_asset(&assets, "macos", "x86_64").is_none());
        assert!(verified_digest(&assets[1]).is_ok());
        let mut invalid = assets[1].clone();
        invalid.digest = None;
        assert!(verified_digest(&invalid).is_err());
    }
}
