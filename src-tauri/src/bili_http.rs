use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cookie_store::CookieStore;
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use parking_lot::RwLock;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION, ORIGIN, REFERER, USER_AGENT};
use reqwest::{Client, Method, Proxy};
use reqwest_cookie_store::{CookieStoreMutex, RawCookie};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use url::Url;

use crate::state::ProxySettings;

pub const USER_AGENT_STR: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
pub const BILI_ORIGIN: &str = "https://www.bilibili.com";
pub const BILI_REFERER: &str = "https://www.bilibili.com/";

const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustHttpRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body_kind: String,
    pub body: Option<String>,
    pub multipart_fields: Option<Vec<(String, String)>>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustHttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

pub struct BiliHttpClient {
    cookie_path: PathBuf,
    cookie_store: Arc<CookieStoreMutex>,
    client: RwLock<Client>,
    plain_client: RwLock<Client>,
    no_redirect_client: RwLock<Client>,
    proxy: RwLock<ProxySettings>,
}

impl BiliHttpClient {
    pub fn new(data_dir: PathBuf, initial_proxy: ProxySettings) -> Result<Self, String> {
        let cookie_path = data_dir.join("cookies.json");
        let loaded = if cookie_path.is_file() {
            File::open(&cookie_path)
                .ok()
                .and_then(|f| cookie_store::serde::json::load(BufReader::new(f)).ok())
                .unwrap_or_default()
        } else {
            CookieStore::default()
        };
        let cookie_store = Arc::new(CookieStoreMutex::new(loaded));
        let client = build_client(Some(cookie_store.clone()), &initial_proxy, true)?;
        let plain_client = build_client(None, &initial_proxy, true)?;

        Ok(Self {
            cookie_path,
            cookie_store,
            client: RwLock::new(client),
            plain_client: RwLock::new(plain_client),
            no_redirect_client: RwLock::new(build_client(None, &initial_proxy, false)?),
            proxy: RwLock::new(initial_proxy),
        })
    }

    pub fn client(&self) -> Client {
        self.client.read().clone()
    }

    pub fn plain_client(&self) -> Client {
        self.plain_client.read().clone()
    }

    pub fn no_redirect_client(&self) -> Client {
        self.no_redirect_client.read().clone()
    }

    pub fn set_proxy(&self, settings: ProxySettings) -> Result<(), String> {
        let next_client = build_client(Some(self.cookie_store.clone()), &settings, true)?;
        let next_plain = build_client(None, &settings, true)?;
        *self.no_redirect_client.write() = build_client(None, &settings, false)?;
        *self.client.write() = next_client;
        *self.plain_client.write() = next_plain;
        *self.proxy.write() = settings;
        Ok(())
    }

    pub fn media_client(&self, loopback: bool) -> Result<reqwest::blocking::Client, String> {
        let mut builder = reqwest::blocking::Client::builder()
            .user_agent(USER_AGENT_STR)
            .connect_timeout(Duration::from_secs(12));
        if loopback {
            builder = builder.no_proxy();
        } else {
            builder = builder.cookie_provider(self.cookie_store.clone());
            if let Some(proxy) = configured_proxy(&self.proxy.read()) {
                builder = builder.proxy(proxy);
            }
        }
        builder.build().map_err(|err| err.to_string())
    }

    pub fn save_cookies(&self) {
        if let Ok(jar) = self.cookie_store.lock() {
            let Some(dir) = self.cookie_path.parent() else {
                return;
            };
            let Ok(mut tmp) = tempfile::NamedTempFile::new_in(dir) else {
                return;
            };
            let mut writer = BufWriter::new(tmp.as_file_mut());
            use std::io::Write;
            if cookie_store::serde::json::save_incl_expired_and_nonpersistent(&jar, &mut writer)
                .is_err()
                || writer.flush().is_err()
            {
                return;
            }
            drop(writer);
            let _ = tmp.persist(&self.cookie_path);
        }
    }

    pub fn get_cookie(&self, key: &str) -> Option<String> {
        let store = self.cookie_store.lock().ok()?;
        let url = Url::parse("https://www.bilibili.com/").ok()?;
        for cookie in store.matches(&url) {
            if cookie.name() == key {
                return Some(cookie.value().to_string());
            }
        }
        None
    }

    pub fn set_cookie(
        &self,
        name: &str,
        value: &str,
        expiration_date: Option<i64>,
    ) -> Result<(), String> {
        let url = Url::parse("https://bilibili.com/").map_err(|e| e.to_string())?;
        let cookie_line = if let Some(exp_secs) = expiration_date {
            let max_age = (exp_secs - chrono::Utc::now().timestamp()).max(0);
            format!("{name}={value}; Domain=.bilibili.com; Path=/; Secure; Max-Age={max_age}")
        } else {
            format!("{name}={value}; Domain=.bilibili.com; Path=/; Secure")
        };
        let raw = RawCookie::parse(cookie_line).map_err(|e| e.to_string())?;
        if let Ok(mut store) = self.cookie_store.lock() {
            let _ = store.insert_raw(&raw, &url);
        }
        self.save_cookies();
        Ok(())
    }

    pub async fn ensure_auth_cookies(&self) {
        let has_ticket = self.get_cookie("bili_ticket").is_some()
            && self
                .get_cookie("bili_ticket_expires")
                .and_then(|s| s.parse::<i64>().ok())
                .map(|exp| exp > chrono::Utc::now().timestamp())
                .unwrap_or(false);
        let has_buvid = self.get_cookie("buvid4").is_some();

        if !has_ticket {
            let _ = self.refresh_bili_ticket().await;
        }
        if !has_buvid {
            let _ = self.refresh_buvid().await;
        }
    }

    pub async fn load_homepage_cookies(&self) -> Result<(), String> {
        self.ensure_auth_cookies().await;
        let resp = self
            .client()
            .get("https://www.bilibili.com/")
            .header(USER_AGENT, USER_AGENT_STR)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        drop(resp);
        self.save_cookies();
        Ok(())
    }

    async fn refresh_bili_ticket(&self) -> Result<(), String> {
        let ts = chrono::Utc::now().timestamp();
        let mut mac = Hmac::<Sha256>::new_from_slice(b"XgwSnGZ1p").map_err(|e| e.to_string())?;
        mac.update(format!("ts{ts}").as_bytes());
        let hexsign = hex::encode(mac.finalize().into_bytes());

        let url = format!(
            "https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign={hexsign}&context%5Bts%5D={ts}&csrf="
        );
        let resp = self
            .client()
            .post(url)
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("GenWebTicket HTTP {}", resp.status()));
        }
        let json: Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(ticket) = json.pointer("/data/ticket").and_then(|v| v.as_str()) {
            let exp = chrono::Utc::now().timestamp() + 259_260;
            self.set_cookie("bili_ticket", ticket, Some(exp))?;
            self.set_cookie("bili_ticket_expires", &exp.to_string(), Some(exp))?;
        }
        Ok(())
    }

    async fn refresh_buvid(&self) -> Result<(), String> {
        let resp = self
            .client()
            .get("https://api.bilibili.com/x/frontend/finger/spi_v2")
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let json: Value = resp.json().await.map_err(|e| e.to_string())?;
        let exp = chrono::Utc::now().timestamp() + 30 * 24 * 3600;
        if let Some(b3) = json.pointer("/data/b_3").and_then(|v| v.as_str()) {
            if !b3.is_empty() {
                let _ = self.set_cookie("buvid3", b3, Some(exp));
            }
        }
        if let Some(b4) = json.pointer("/data/b_4").and_then(|v| v.as_str()) {
            if !b4.is_empty() {
                self.set_cookie("buvid4", b4, Some(exp))?;
            }
        }
        Ok(())
    }

    pub async fn execute_request(&self, req: RustHttpRequest) -> Result<RustHttpResponse, String> {
        let method = Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut headers = HeaderMap::new();
        for (k, v) in &req.headers {
            let lower = k.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "host" | "content-length" | "origin" | "referer" | "user-agent"
            ) {
                continue;
            }
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }
        headers.insert(REFERER, HeaderValue::from_static(BILI_REFERER));
        headers.insert(ORIGIN, HeaderValue::from_static(BILI_ORIGIN));
        headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_STR));

        let mut builder = self
            .client()
            .request(method, &req.url)
            .headers(headers)
            .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(10_000)));

        match req.body_kind.as_str() {
            "multipart" => {
                let mut form = reqwest::multipart::Form::new();
                if let Some(fields) = req.multipart_fields {
                    for (k, v) in fields {
                        form = form.text(k, v);
                    }
                }
                builder = builder.multipart(form);
            }
            "raw" => {
                if let Some(body) = req.body {
                    builder = builder.body(body);
                }
            }
            _ => {}
        }

        let resp = builder.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let mut resp_headers = HashMap::new();
        let mut has_set_cookie = false;
        for (k, v) in resp.headers() {
            let key_str = k.as_str().to_ascii_lowercase();
            if key_str == "set-cookie" {
                has_set_cookie = true;
            }
            if let Ok(val) = v.to_str() {
                resp_headers.insert(key_str, val.to_string());
            }
        }
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if has_set_cookie {
            self.save_cookies();
        }

        Ok(RustHttpResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers: resp_headers,
            body,
        })
    }

    pub async fn resolve_short_link(&self, code: &str) -> Result<String, String> {
        if code.is_empty() || code.len() > 64 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("无效的 B 站短链接".into());
        }
        let response = self
            .no_redirect_client()
            .get(format!("https://b23.tv/{code}"))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "无法连接 B 站短链接服务")?;
        if !response.status().is_redirection() {
            return Err(format!(
                "B 站短链接未能解析（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|h| h.to_str().ok())
            .ok_or("B 站短链接缺少目标地址")?;
        bili_share_destination(response.url(), location)
    }

    pub async fn sample_audio_mirror(&self, url: &str) -> Result<u64, String> {
        let size: usize = 128 * 1024;
        let start = Instant::now();
        let resp = self
            .plain_client()
            .get(url)
            .header("Range", format!("bytes=0-{}", size - 1))
            .header(REFERER, BILI_REFERER)
            .header(ORIGIN, BILI_ORIGIN)
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(6))
            .send()
            .await
            .map_err(|_| "节点不可用".to_string())?;

        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !resp.status().is_success() || ct.contains("text") || ct.contains("json") {
            return Err("节点不可用".to_string());
        }

        let mut stream = resp.bytes_stream();
        let mut bytes: usize = 0;
        while bytes < size {
            match stream.next().await {
                Some(Ok(chunk)) => bytes += chunk.len(),
                Some(Err(_)) => break,
                None => break,
            }
        }
        if bytes == 0 {
            return Err("节点未返回音频".to_string());
        }
        let elapsed = start.elapsed().as_secs_f64().max(0.001);
        let kib_per_sec = ((bytes.min(size) as f64) / 1024.0 / elapsed).round() as u64;
        Ok(kib_per_sec)
    }

    pub async fn encode_params_wbi(
        &self,
        mut params: Vec<(String, String)>,
    ) -> Vec<(String, String)> {
        let nav_resp = self
            .client()
            .get("https://api.bilibili.com/x/web-interface/nav")
            .header(REFERER, BILI_REFERER)
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        let Ok(resp) = nav_resp else {
            return params;
        };
        let Ok(json) = resp.json::<Value>().await else {
            return params;
        };
        let img_url = json
            .pointer("/data/wbi_img/img_url")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let sub_url = json
            .pointer("/data/wbi_img/sub_url")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let extract_key = |u: &str| -> String {
            let start = u.rfind('/').map(|i| i + 1).unwrap_or(0);
            let end = u.rfind('.').unwrap_or(u.len());
            if end > start {
                u[start..end].to_string()
            } else {
                String::new()
            }
        };
        let img_key = extract_key(img_url);
        let sub_key = extract_key(sub_url);
        if img_key.is_empty() || sub_key.is_empty() {
            return params;
        }
        let combined: Vec<char> = format!("{img_key}{sub_key}").chars().collect();
        let mixin_key: String = MIXIN_KEY_ENC_TAB
            .iter()
            .filter_map(|&idx| combined.get(idx))
            .take(32)
            .collect();

        let wts = chrono::Utc::now().timestamp().to_string();
        params.push(("wts".to_string(), wts));
        params.sort_by(|a, b| a.0.cmp(&b.0));

        let query = params
            .iter()
            .map(|(k, v)| {
                let filtered: String = v
                    .chars()
                    .filter(|c| !matches!(c, '!' | '\'' | '(' | ')' | '*'))
                    .collect();
                format!(
                    "{}={}",
                    urlencoding::encode(k),
                    urlencoding::encode(&filtered)
                )
            })
            .collect::<Vec<_>>()
            .join("&");

        let mut hasher = Md5::new();
        hasher.update(format!("{query}{mixin_key}").as_bytes());
        let w_rid = hex::encode(hasher.finalize());
        params.push(("w_rid".to_string(), w_rid));
        params
    }

    pub async fn get_dash_playurl(
        &self,
        bvid: &str,
        cid: &str,
        fnval: u32,
    ) -> Result<Value, String> {
        let signed = self
            .encode_params_wbi(vec![
                ("bvid".to_string(), bvid.to_string()),
                ("cid".to_string(), cid.to_string()),
                ("fnval".to_string(), fnval.to_string()),
            ])
            .await;
        let resp = self
            .client()
            .get("https://api.bilibili.com/x/player/wbi/playurl")
            .query(&signed)
            .header(REFERER, BILI_REFERER)
            .header(ORIGIN, BILI_ORIGIN)
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json::<Value>().await.map_err(|e| e.to_string())
    }

    pub async fn get_audio_web_stream_url(
        &self,
        songid: &str,
        mid: i64,
        vip_status: i64,
    ) -> Result<Value, String> {
        let quality = if vip_status > 0 { 3 } else { 2 };
        let resp = self
            .client()
            .get("https://api.bilibili.com/audio/music-service-c/url")
            .query(&[
                ("mid", mid.to_string()),
                ("songid", songid.to_string()),
                ("quality", quality.to_string()),
                ("privilege", "2".to_string()),
                ("platform", "web".to_string()),
            ])
            .header(REFERER, BILI_REFERER)
            .header(ORIGIN, BILI_ORIGIN)
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json::<Value>().await.map_err(|e| e.to_string())
    }

    pub async fn get_web_interface_view(&self, bvid: &str) -> Result<Value, String> {
        let resp = self
            .client()
            .get("https://api.bilibili.com/x/web-interface/view")
            .query(&[("bvid", bvid)])
            .header(REFERER, BILI_REFERER)
            .header(USER_AGENT, USER_AGENT_STR)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json::<Value>().await.map_err(|e| e.to_string())
    }
}

fn bili_share_destination(base: &Url, location: &str) -> Result<String, String> {
    let url = base.join(location).map_err(|_| "B 站短链接目标地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url
            .domain()
            .is_some_and(|domain| domain == "bilibili.com" || domain.ends_with(".bilibili.com"))
    {
        return Err("该短链接没有指向 B 站视频或音频".into());
    }
    Ok(url.into())
}

fn build_client(
    cookie_store: Option<Arc<CookieStoreMutex>>,
    proxy_settings: &ProxySettings,
    follow_redirects: bool,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(USER_AGENT_STR)
        .pool_max_idle_per_host(6);

    if !follow_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    if let Some(store) = cookie_store {
        builder = builder.cookie_provider(store);
    }

    if let Some(proxy) = configured_proxy(proxy_settings) {
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| format!("build http client failed: {e}"))
}

fn configured_proxy(proxy_settings: &ProxySettings) -> Option<Proxy> {
    if proxy_settings.proxy_type != "none" {
        if let Some(host) = proxy_settings
            .host
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            let scheme = match proxy_settings.proxy_type.as_str() {
                "http" => "http",
                "socks4" => "socks4",
                "socks5" => "socks5h",
                _ => "http",
            };
            let port_part = proxy_settings
                .port
                .map(|p| format!(":{p}"))
                .unwrap_or_default();
            let url = format!("{scheme}://{}{}", host.trim(), port_part);
            if let Ok(mut proxy) = Proxy::all(&url) {
                if let Some(user) = proxy_settings.username.as_deref().filter(|s| !s.is_empty()) {
                    proxy =
                        proxy.basic_auth(user, proxy_settings.password.as_deref().unwrap_or(""));
                }
                return Some(proxy);
            }
        }
    }

    None
}

#[cfg(test)]
mod short_link_tests {
    use super::*;

    #[test]
    fn validates_the_redirect_without_fetching_its_destination() {
        let base = Url::parse("https://b23.tv/Test").unwrap();
        let path = "//www.bilibili.com/video/BV17x411w7KC?p=2";
        assert_eq!(
            bili_share_destination(&base, path).unwrap(),
            format!("https:{path}")
        );
        for location in [
            "/other",
            "https://bilibili.com.example/video/1",
            "https://www.bilibili.com@other.example/video/1",
            "file:///tmp/video",
        ] {
            assert!(bili_share_destination(&base, location).is_err());
        }
    }
}
