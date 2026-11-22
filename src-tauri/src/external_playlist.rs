use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, REFERER, USER_AGENT};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::bili_http::USER_AGENT_STR;

const BATCH_SIZE: usize = 50;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const UNAVAILABLE: &str = "歌单不存在、未公开或平台暂不提供匿名访问";
const INVALID: &str = "平台返回的歌单格式无法识别";

#[derive(Debug, Clone, Deserialize)]
pub struct ExternalPlaylistRef {
    pub source: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalTrack {
    pub title: String,
    pub artists: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalPlaylist {
    pub title: String,
    pub total: usize,
    pub tracks: Vec<Option<ExternalTrack>>,
}

fn is_playlist_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 16
        && !id.starts_with('0')
        && id.chars().all(|c| c.is_ascii_digit())
}

fn text_trimmed(val: Option<&Value>) -> String {
    val.and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(200).collect())
        .unwrap_or_default()
}

fn positive_usize(val: Option<&Value>) -> usize {
    match val {
        Some(Value::Number(n)) => n.as_u64().map(|x| x as usize).unwrap_or(0),
        Some(Value::String(s)) => s.parse::<usize>().unwrap_or(0),
        _ => 0,
    }
}

fn track_id_str(val: Option<&Value>) -> Option<String> {
    let s = match val {
        Some(Value::Number(n)) => n.as_u64()?.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => return None,
    };
    if is_playlist_id(&s) {
        Some(s)
    } else {
        None
    }
}

fn read_track(raw: &Value, netease: bool) -> Option<ExternalTrack> {
    let title = {
        let n = text_trimmed(raw.get("name"));
        if !n.is_empty() {
            n
        } else if !netease {
            let t = text_trimmed(raw.get("title"));
            if !t.is_empty() {
                t
            } else {
                text_trimmed(raw.get("songname"))
            }
        } else {
            String::new()
        }
    };
    if title.is_empty() {
        return None;
    }
    let artists_val = if netease {
        raw.get("ar").or_else(|| raw.get("artists"))
    } else {
        raw.get("singer")
    };
    let artists = artists_val
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .take(8)
                .map(|a| text_trimmed(a.get("name")))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let dur = if netease {
        positive_usize(raw.get("dt").or_else(|| raw.get("duration"))) as f64 / 1000.0
    } else {
        positive_usize(raw.get("interval")) as f64
    };
    Some(ExternalTrack {
        title,
        artists,
        duration: if dur > 0.0 { Some(dur) } else { None },
    })
}

async fn fetch_json(
    client: &Client,
    url: &str,
    params: &[(&str, String)],
    referer: &str,
    cancel: &CancellationToken,
) -> Result<Value, String> {
    if cancel.is_cancelled() {
        return Err("已取消读取歌单".to_string());
    }
    let fut = client
        .get(url)
        .query(params)
        .header(ACCEPT, "application/json")
        .header(REFERER, referer)
        .header(USER_AGENT, USER_AGENT_STR)
        .timeout(Duration::from_secs(15))
        .send();

    let resp = tokio::select! {
        _ = cancel.cancelled() => return Err("已取消读取歌单".to_string()),
        res = fut => res.map_err(|e| {
            if e.is_timeout() {
                "读取公开歌单超时，请稍后再试".to_string()
            } else {
                "无法连接平台的公开歌单接口".to_string()
            }
        })?,
    };

    if !resp.status().is_success() {
        return Err(format!(
            "无法读取公开歌单（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    if let Some(cl) = resp.content_length() {
        if cl as usize > MAX_BYTES {
            return Err("平台单次返回的数据超过 4 MiB，已停止读取".to_string());
        }
    }

    let mut stream = resp.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = tokio::select! {
        _ = cancel.cancelled() => return Err("已取消读取歌单".to_string()),
        c = stream.next() => c,
    } {
        let chunk = chunk.map_err(|_| "无法连接平台的公开歌单接口".to_string())?;
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("平台单次返回的数据超过 4 MiB，已停止读取".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&bytes).map_err(|_| INVALID.to_string())
}

pub async fn fetch_public_playlist(
    client: &Client,
    playlist_ref: ExternalPlaylistRef,
    cancel: CancellationToken,
) -> Result<ExternalPlaylist, String> {
    if !matches!(playlist_ref.source.as_str(), "netease" | "qq")
        || !is_playlist_id(&playlist_ref.id)
    {
        return Err("无效的歌单 ID".to_string());
    }

    if playlist_ref.source == "netease" {
        read_netease(client, &playlist_ref.id, &cancel).await
    } else {
        read_qq(client, &playlist_ref.id, &cancel).await
    }
}

async fn read_netease(
    client: &Client,
    id: &str,
    cancel: &CancellationToken,
) -> Result<ExternalPlaylist, String> {
    let data = fetch_json(
        client,
        "https://music.163.com/api/v6/playlist/detail",
        &[
            ("id", id.to_string()),
            ("n", "10".to_string()),
            ("s", "0".to_string()),
        ],
        "https://music.163.com/",
        cancel,
    )
    .await?;

    let list = data
        .get("playlist")
        .or_else(|| data.get("result"))
        .and_then(|v| v.as_object());
    let Some(list) = list else {
        return Err(UNAVAILABLE.to_string());
    };
    if data.get("code").and_then(|v| v.as_i64()) != Some(200)
        || list.get("privacy").and_then(|v| v.as_i64()).unwrap_or(0) != 0
    {
        return Err(UNAVAILABLE.to_string());
    }
    let tracks_arr = list.get("tracks").and_then(|v| v.as_array());
    let track_ids_arr = list.get("trackIds").and_then(|v| v.as_array());
    if tracks_arr.is_none() && track_ids_arr.is_none() {
        return Err(INVALID.to_string());
    }

    let songs = tracks_arr.cloned().unwrap_or_default();
    let order: Vec<Option<String>> = track_ids_arr
        .map(|arr| {
            arr.iter()
                .map(|entry| track_id_str(entry.get("id").or(Some(entry))))
                .collect()
        })
        .unwrap_or_default();

    let title = {
        let t = text_trimmed(list.get("name"));
        if t.is_empty() {
            format!("网易云歌单 {id}")
        } else {
            t
        }
    };
    let total = positive_usize(list.get("trackCount")).max(if !order.is_empty() {
        order.len()
    } else {
        songs.len()
    });

    if order.is_empty() {
        return Ok(ExternalPlaylist {
            title,
            total,
            tracks: songs.iter().map(|s| read_track(s, true)).collect(),
        });
    }

    let mut by_id: HashMap<String, Option<ExternalTrack>> = HashMap::new();
    let mut unique_order = Vec::new();
    for key in order.iter().flatten() {
        if !by_id.contains_key(key) {
            by_id.insert(key.clone(), None);
            unique_order.push(key.clone());
        }
    }
    for song in &songs {
        if let Some(sid) = track_id_str(song.get("id")) {
            if let std::collections::hash_map::Entry::Occupied(mut entry) = by_id.entry(sid) {
                if let Some(t) = read_track(song, true) {
                    entry.insert(Some(t));
                }
            }
        }
    }

    let missing: Vec<String> = unique_order
        .into_iter()
        .filter(|k| by_id.get(k).and_then(|v| v.as_ref()).is_none())
        .collect();

    for chunk in missing.chunks(BATCH_SIZE) {
        let batch_set: HashSet<&str> = chunk.iter().map(|s| s.as_str()).collect();
        let ids_param = format!("[{}]", chunk.join(","));
        let resp = fetch_json(
            client,
            "https://music.163.com/api/song/detail",
            &[("ids", ids_param)],
            "https://music.163.com/",
            cancel,
        )
        .await?;
        if resp.get("code").and_then(|v| v.as_i64()) != Some(200) {
            return Err("网易云未提供本批曲目的匿名详情，已停止读取".to_string());
        }
        let Some(resp_songs) = resp.get("songs").and_then(|v| v.as_array()) else {
            return Err(INVALID.to_string());
        };
        for song in resp_songs {
            if let Some(sid) = track_id_str(song.get("id")) {
                if batch_set.contains(sid.as_str()) {
                    if let Some(t) = read_track(song, true) {
                        by_id.insert(sid, Some(t));
                    }
                }
            }
        }
    }

    let tracks = order
        .into_iter()
        .map(|k| k.and_then(|id| by_id.get(&id).cloned().flatten()))
        .collect();

    Ok(ExternalPlaylist {
        title,
        total,
        tracks,
    })
}

async fn read_qq(
    client: &Client,
    id: &str,
    cancel: &CancellationToken,
) -> Result<ExternalPlaylist, String> {
    let fetch_page = |offset: usize| async move {
        let query = [
            ("id", id.to_string()),
            ("format", "json".to_string()),
            ("newsong", "1".to_string()),
            ("platform", "jqspaframe.json".to_string()),
            ("song_begin", offset.to_string()),
            ("song_num", BATCH_SIZE.to_string()),
        ];
        fetch_json(
            client,
            "https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg",
            &query,
            "https://y.qq.com/",
            cancel,
        )
        .await
    };

    let first_data = fetch_page(0).await?;
    let (title_raw, public_total, declared, paged, mut tracks) = parse_qq_page(&first_data, 0)?;

    if paged {
        while tracks.len() < public_total {
            if tracks.is_empty() {
                return Err("QQ音乐未返回预期的曲目分页，已停止读取".to_string());
            }
            let next_data = fetch_page(tracks.len()).await?;
            let (_, next_total, _, _, next_tracks) = parse_qq_page(&next_data, tracks.len())?;
            if next_tracks.is_empty()
                || next_total != public_total
                || tracks.len() + next_tracks.len() > public_total
            {
                return Err("QQ音乐曲目分页缺失或歌单已变更，请重新读取".to_string());
            }
            tracks.extend(next_tracks);
        }
    }

    Ok(ExternalPlaylist {
        title: if title_raw.is_empty() {
            format!("QQ音乐歌单 {id}")
        } else {
            title_raw
        },
        total: public_total.max(declared).max(tracks.len()),
        tracks,
    })
}

type QQPage = (String, usize, usize, bool, Vec<Option<ExternalTrack>>);
fn parse_qq_page(data: &Value, offset: usize) -> Result<QQPage, String> {
    let lists = data
        .pointer("/data/cdlist")
        .or_else(|| data.get("cdlist"))
        .and_then(|v| v.as_array());
    let list = lists
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_object());
    let Some(list) = list else {
        return Err(UNAVAILABLE.to_string());
    };
    if data.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err(UNAVAILABLE.to_string());
    }
    let Some(songlist) = list.get("songlist").and_then(|v| v.as_array()) else {
        return Err(INVALID.to_string());
    };
    let paged = list.contains_key("song_begin");
    let matches_n = |v: Option<&Value>, n: usize| -> bool {
        match v {
            Some(Value::Number(num)) => num.as_u64() == Some(n as u64),
            Some(Value::String(s)) => s == &n.to_string(),
            _ => false,
        }
    };
    let reported = list.get("total_song_num").or_else(|| list.get("songnum"));
    let public_total = positive_usize(reported);
    if ((paged || offset > 0) && !matches_n(list.get("song_begin"), offset))
        || (paged && !matches_n(reported, public_total))
        || (list.contains_key("cur_song_num")
            && !matches_n(list.get("cur_song_num"), songlist.len()))
    {
        return Err("QQ音乐返回的分页位置或曲目数不一致，已停止读取".to_string());
    }
    Ok((
        text_trimmed(list.get("dissname")),
        public_total,
        positive_usize(list.get("songnum")),
        paged,
        songlist.iter().map(|s| read_track(s, false)).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qq_pages_validate_offsets_totals_and_unavailable_tracks() {
        let page = serde_json::json!({"code":0,"cdlist":[{"song_begin":50,"total_song_num":52,"cur_song_num":2,
            "songlist":[{"songname":"Test","interval":30,"singer":[{"name":"Singer"}]},{}]}]});
        let (_, total, _, paged, rows) = parse_qq_page(&page, 50).unwrap();
        assert!(paged);
        assert_eq!(total, 52);
        assert_eq!(rows[0].as_ref().unwrap().artists, ["Singer"]);
        assert!(rows[1].is_none());
        assert!(parse_qq_page(&page, 0).is_err());
    }
}
