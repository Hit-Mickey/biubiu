use std::collections::VecDeque;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::http_audio::HttpAudio;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::{Condvar, Mutex, RwLock};
use reqwest::header::{ORIGIN, REFERER};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use tauri::{AppHandle, Emitter, Manager};

use crate::bili_http::{BiliHttpClient, BILI_ORIGIN, BILI_REFERER, USER_AGENT_STR};
use crate::local_music::file_url_to_path_candidates;
use crate::storage::StorageManager;
use crate::webdav::library::{track_version, WebDavManager};

const PLAY_MODE_SEQUENCE: u8 = 1;
const PLAY_MODE_LOOP: u8 = 2;
const PLAY_MODE_RANDOM: u8 = 3;
const PLAY_MODE_SINGLE: u8 = 4;

type ReadySignal<T> = Arc<(Mutex<Option<Result<T, String>>>, Condvar)>;
type OpenedMedia = (Box<dyn MediaSource>, Hint, Option<String>);

pub struct PlayRequest {
    pub request: u64,
    pub src: String,
    pub start_secs: f64,
    pub volume: f32,
    pub muted: bool,
    pub rate: f32,
    pub looping: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStateSnapshot {
    pub src: String,
    pub is_playing: bool,
    pub current_time: f64,
    pub duration: f64,
    pub volume: f32,
    pub muted: bool,
    pub rate: f32,
    pub looping: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_mode: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_single: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeTrackMetadata {
    pub play_id: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub cover: Option<String>,
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeQueueTrack {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub track_type: String,
    pub source: Option<String>,
    pub bvid: Option<String>,
    pub aid: Option<String>,
    pub cid: Option<String>,
    pub sid: Option<i64>,
    pub audio_url: Option<String>,
    pub cover: Option<String>,
    pub owner_name: Option<String>,
    pub page_title: Option<String>,
    pub page_cover: Option<String>,
    pub page_index: Option<i32>,
    pub total_page: Option<i32>,
    pub duration: Option<f64>,
    pub web_dav_list_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeQueueSnapshot {
    pub list: Vec<NativeQueueTrack>,
    pub play_id: Option<String>,
    pub next_id: Option<String>,
    pub play_mode: u8,
    pub should_keep_pages_order_in_random_play_mode: bool,
}

impl Default for NativeQueueSnapshot {
    fn default() -> Self {
        Self {
            list: Vec::new(),
            play_id: None,
            next_id: None,
            play_mode: PLAY_MODE_LOOP,
            should_keep_pages_order_in_random_play_mode: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniCommandPayload {
    pub current_time: Option<f64>,
    pub volume: Option<f32>,
    pub volume_delta: Option<f32>,
}

struct PcmBuffer {
    /// Interleaved stereo f32 samples (L, R, L, R...)
    samples: VecDeque<f32>,
    src_sample_rate: u32,
    frac_pos: f64,
    eof: bool,
}

impl PcmBuffer {
    fn new() -> Self {
        Self {
            samples: VecDeque::with_capacity(96_000),
            src_sample_rate: 48_000,
            frac_pos: 0.0,
            eof: false,
        }
    }

    fn clear(&mut self) {
        self.samples.clear();
        self.frac_pos = 0.0;
        self.eof = false;
    }
}

struct SharedAudioCore {
    pcm: Mutex<PcmBuffer>,
    pcm_cv: Condvar,
    is_playing: AtomicBool,
    volume_bits: AtomicU32,
    muted: AtomicBool,
    rate_bits: AtomicU32,
    looping: AtomicBool,
    generation: AtomicU64,
    /// Current playback position in milliseconds
    position_ms: AtomicU64,
    /// Total duration in milliseconds (0 if unknown)
    duration_ms: AtomicU64,
    /// Pending seek target in milliseconds (u64::MAX means none)
    seek_target_ms: AtomicU64,
    fft_enabled: AtomicBool,
    fft_ring: Mutex<VecDeque<f32>>,
}

impl SharedAudioCore {
    fn new() -> Self {
        Self {
            pcm: Mutex::new(PcmBuffer::new()),
            pcm_cv: Condvar::new(),
            is_playing: AtomicBool::new(false),
            volume_bits: AtomicU32::new(0.5_f32.to_bits()),
            muted: AtomicBool::new(false),
            rate_bits: AtomicU32::new(1.0_f32.to_bits()),
            looping: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            position_ms: AtomicU64::new(0),
            duration_ms: AtomicU64::new(0),
            seek_target_ms: AtomicU64::new(u64::MAX),
            fft_enabled: AtomicBool::new(false),
            fft_ring: Mutex::new(VecDeque::with_capacity(1024)),
        }
    }

    fn volume(&self) -> f32 {
        f32::from_bits(self.volume_bits.load(Ordering::Relaxed))
    }

    fn rate(&self) -> f32 {
        f32::from_bits(self.rate_bits.load(Ordering::Relaxed)).clamp(0.5, 2.0)
    }

    fn current_secs(&self) -> f64 {
        self.position_ms.load(Ordering::Relaxed) as f64 / 1000.0
    }

    fn duration_secs(&self) -> f64 {
        self.duration_ms.load(Ordering::Relaxed) as f64 / 1000.0
    }
}

pub struct AudioEngineHandle {
    core: Arc<SharedAudioCore>,
    pub lyrics: crate::lyrics::PlaybackLyrics,
    pub sleep_deadline: AtomicU64,
    pub reporter: crate::play_report::PlayReporter,
    http: Arc<BiliHttpClient>,
    webdav: Arc<WebDavManager>,
    storage: Arc<StorageManager>,
    ffmpeg_path: RwLock<PathBuf>,
    current_src: RwLock<String>,
    metadata: RwLock<NativeTrackMetadata>,
    queue: RwLock<NativeQueueSnapshot>,
    app_handle: RwLock<Option<AppHandle>>,
    play_request: Mutex<u64>,
    output_started: AtomicBool,
    smtc_tx: Mutex<Option<std::sync::mpsc::Sender<SmtcUpdate>>>,
}

enum SmtcUpdate {
    Metadata {
        title: String,
        artist: Option<String>,
        cover: Option<String>,
        duration_secs: Option<f64>,
    },
    Playback {
        is_playing: bool,
        position_secs: f64,
    },
    Stopped,
}

impl AudioEngineHandle {
    pub fn new(
        http: Arc<BiliHttpClient>,
        webdav: Arc<WebDavManager>,
        storage: Arc<StorageManager>,
        ffmpeg_path: PathBuf,
    ) -> Arc<Self> {
        let engine = Arc::new(Self {
            core: Arc::new(SharedAudioCore::new()),
            lyrics: Default::default(),
            sleep_deadline: AtomicU64::new(0),
            reporter: crate::play_report::PlayReporter::new(http.clone(), &storage),
            http,
            webdav,
            storage,
            ffmpeg_path: RwLock::new(ffmpeg_path),
            current_src: RwLock::new(String::new()),
            metadata: RwLock::new(NativeTrackMetadata::default()),
            queue: RwLock::new(NativeQueueSnapshot::default()),
            app_handle: RwLock::new(None),
            play_request: Mutex::new(0),
            output_started: AtomicBool::new(false),
            smtc_tx: Mutex::new(None),
        });
        engine.spawn_progress_and_fft_worker();
        engine
    }

    pub fn set_app_handle(self: &Arc<Self>, app: AppHandle) {
        *self.app_handle.write() = Some(app);
        self.start_os_media_controls();
    }

    pub fn set_ffmpeg_path(&self, path: PathBuf) {
        *self.ffmpeg_path.write() = path;
    }

    fn ensure_audio_output(&self) -> Result<(), String> {
        if self.output_started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let core = self.core.clone();
        let started = Arc::new((Mutex::new(None::<Result<(), String>>), Condvar::new()));
        let started_clone = started.clone();

        std::thread::Builder::new()
            .name("biubiu-audio-out".to_string())
            .spawn(move || {
                let res = run_cpal_output(core, started_clone);
                if res.is_err() {
                    // output thread exited
                }
            })
            .map_err(|e| format!("spawn audio output failed: {e}"))?;

        let (lock, cvar) = &*started;
        let mut guard = lock.lock();
        while guard.is_none() {
            cvar.wait(&mut guard);
        }
        match guard.take().unwrap() {
            Ok(()) => Ok(()),
            Err(err) => {
                self.output_started.store(false, Ordering::SeqCst);
                Err(err)
            }
        }
    }

    fn spawn_progress_and_fft_worker(self: &Arc<Self>) {
        let engine = self.clone();
        std::thread::Builder::new()
            .name("biubiu-audio-ticks".to_string())
            .spawn(move || {
                let mut planner = FftPlanner::<f32>::new();
                let fft = planner.plan_fft_forward(512);
                let hann: Vec<f32> = (0..512)
                    .map(|i| 0.5 * (1.0 - ((2.0 * std::f32::consts::PI * i as f32) / 511.0).cos()))
                    .collect();
                let mut fft_buf = vec![Complex::new(0.0_f32, 0.0_f32); 512];
                let mut last_progress = Instant::now();
                let mut last_save = Instant::now();
                let mut last_report = Instant::now();

                loop {
                    let fft_active = engine.core.fft_enabled.load(Ordering::Relaxed)
                        && engine.core.is_playing.load(Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(if fft_active { 33 } else { 200 }));

                    if last_report.elapsed() >= Duration::from_secs(1)
                        && engine.core.is_playing.load(Ordering::Relaxed)
                    {
                        last_report = Instant::now();
                        if let Some(track) = engine.current_track() {
                            engine.reporter.playing(
                                &track,
                                engine.core.current_secs(),
                                engine.core.duration_secs(),
                            );
                        }
                    }
                    let deadline = engine.sleep_deadline.load(Ordering::SeqCst);
                    if deadline > 0
                        && chrono::Utc::now().timestamp_millis() as u64 >= deadline
                        && engine
                            .sleep_deadline
                            .compare_exchange(deadline, 0, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                    {
                        engine.pause();
                        if let Some(app) = engine.app_handle.read().as_ref() {
                            let _ = app.emit("sleep://expired", ());
                        }
                    }
                    if engine.core.is_playing.load(Ordering::Relaxed)
                        && last_save.elapsed() >= Duration::from_secs(5)
                    {
                        engine.save_progress();
                        last_save = Instant::now();
                    }
                    if let Some(app) = engine.app_handle.read().as_ref() {
                        if engine.core.is_playing.load(Ordering::Relaxed)
                            && last_progress.elapsed() >= Duration::from_millis(200)
                        {
                            last_progress = Instant::now();
                            let cur = engine.core.current_secs();
                            let dur = engine.core.duration_secs();
                            let _ = app.emit(
                                "audio://progress",
                                serde_json::json!({ "currentTime": cur, "duration": dur }),
                            );
                        }

                        if fft_active {
                            let samples: Vec<f32> = {
                                let ring = engine.core.fft_ring.lock();
                                if ring.len() < 512 {
                                    Vec::new()
                                } else {
                                    ring.iter().rev().take(512).copied().collect()
                                }
                            };
                            if samples.len() == 512 {
                                for (i, s) in samples.iter().rev().enumerate() {
                                    fft_buf[i] = Complex::new(s * hann[i], 0.0);
                                }
                                fft.process(&mut fft_buf);
                                // Lower 60% of 256 bins = ~154 bins -> 64 bars scaled 0..255
                                let useful = 154usize;
                                let mut bars = Vec::with_capacity(64);
                                for b in 0..64 {
                                    let idx = (b * useful) / 64;
                                    let mag = fft_buf[idx].norm() / 256.0;
                                    let db = 20.0 * (mag.max(1e-6)).log10();
                                    let norm = ((db + 85.0) / 65.0).clamp(0.0, 1.0);
                                    bars.push((norm * 255.0).round() as u8);
                                }
                                let _ = app.emit("audio://fft", bars);
                            }
                        }
                    }
                }
            })
            .ok();
    }

    fn start_os_media_controls(self: &Arc<Self>) {
        let engine = self.clone();
        let (tx, rx) = std::sync::mpsc::channel::<SmtcUpdate>();
        *self.smtc_tx.lock() = Some(tx);

        std::thread::Builder::new()
            .name("biubiu-smtc".to_string())
            .spawn(move || {
                #[cfg(target_os = "windows")]
                let hwnd_ptr = create_hidden_message_hwnd();
                #[cfg(not(target_os = "windows"))]
                let hwnd_ptr: Option<*mut std::ffi::c_void> = None;

                let config = souvlaki::PlatformConfig {
                    dbus_name: "biubiu",
                    display_name: "BiuBiu",
                    hwnd: hwnd_ptr,
                };
                let Ok(mut controls) = souvlaki::MediaControls::new(config) else {
                    return;
                };
                let eng_evt = engine.clone();
                let _ = controls.attach(move |event: souvlaki::MediaControlEvent| match event {
                    souvlaki::MediaControlEvent::Play
                        if !eng_evt.core.is_playing.load(Ordering::Relaxed) =>
                    {
                        eng_evt.dispatch_control("toggle")
                    }
                    souvlaki::MediaControlEvent::Pause => eng_evt.pause(),
                    souvlaki::MediaControlEvent::Toggle => eng_evt.dispatch_control("toggle"),
                    souvlaki::MediaControlEvent::Next => eng_evt.dispatch_control("next"),
                    souvlaki::MediaControlEvent::Previous => eng_evt.dispatch_control("prev"),
                    souvlaki::MediaControlEvent::SetPosition(pos) => {
                        eng_evt.seek(pos.0.as_secs_f64());
                    }
                    _ => {}
                });

                while let Ok(msg) = rx.recv() {
                    match msg {
                        SmtcUpdate::Metadata {
                            title,
                            artist,
                            cover,
                            duration_secs,
                        } => {
                            let _ = controls.set_metadata(souvlaki::MediaMetadata {
                                title: Some(&title),
                                artist: artist.as_deref(),
                                album: None,
                                cover_url: cover.as_deref(),
                                duration: duration_secs
                                    .filter(|d| d.is_finite() && *d > 0.0)
                                    .map(Duration::from_secs_f64),
                            });
                        }
                        SmtcUpdate::Playback {
                            is_playing,
                            position_secs,
                        } => {
                            let progress = Some(souvlaki::MediaPosition(Duration::from_secs_f64(
                                position_secs.max(0.0),
                            )));
                            let pb = if is_playing {
                                souvlaki::MediaPlayback::Playing { progress }
                            } else {
                                souvlaki::MediaPlayback::Paused { progress }
                            };
                            let _ = controls.set_playback(pb);
                        }
                        SmtcUpdate::Stopped => {
                            let _ = controls.set_playback(souvlaki::MediaPlayback::Stopped);
                        }
                    }
                }
            })
            .ok();
    }

    pub fn get_state(&self) -> NativeAudioStateSnapshot {
        let meta = self.metadata.read().clone();
        let q = self.queue.read();
        let cur_item = q
            .play_id
            .as_deref()
            .and_then(|id| q.list.iter().find(|t| t.id == id));
        let title = meta
            .title
            .or_else(|| cur_item.map(|i| i.page_title.clone().unwrap_or_else(|| i.title.clone())));
        let artist = meta
            .artist
            .or_else(|| cur_item.and_then(|i| i.owner_name.clone()));
        let cover = meta
            .cover
            .or_else(|| cur_item.and_then(|i| i.page_cover.clone().or_else(|| i.cover.clone())));
        let dur = {
            let engine_dur = self.core.duration_secs();
            if engine_dur > 0.0 {
                engine_dur
            } else {
                meta.duration
                    .or_else(|| cur_item.and_then(|i| i.duration))
                    .unwrap_or(0.0)
            }
        };

        NativeAudioStateSnapshot {
            src: self.current_src.read().clone(),
            is_playing: self.core.is_playing.load(Ordering::Relaxed),
            current_time: self.core.current_secs(),
            duration: dur,
            volume: self.core.volume(),
            muted: self.core.muted.load(Ordering::Relaxed),
            rate: self.core.rate(),
            looping: self.core.looping.load(Ordering::Relaxed),
            play_id: q.play_id.clone().or(meta.play_id),
            title,
            artist,
            cover,
            play_mode: Some(q.play_mode),
            is_single: Some(q.list.len() == 1),
        }
    }

    pub fn emit_state(&self) {
        let snap = self.get_state();
        if let Some(app) = self.app_handle.read().as_ref() {
            let _ = app.emit("audio://state", &snap);
            #[cfg(target_os = "windows")]
            crate::thumbar::update_thumbar_state(app, snap.is_playing);
        }
        if let Some(tx) = self.smtc_tx.lock().as_ref() {
            let _ = tx.send(SmtcUpdate::Playback {
                is_playing: snap.is_playing,
                position_secs: snap.current_time,
            });
        }
    }

    pub fn set_metadata(&self, meta: NativeTrackMetadata) {
        let title = meta.title.clone().unwrap_or_else(|| "BiuBiu".to_string());
        let artist = meta.artist.clone();
        let cover = meta.cover.clone();
        let dur = meta.duration;
        *self.metadata.write() = meta;
        if let Some(tx) = self.smtc_tx.lock().as_ref() {
            let _ = tx.send(SmtcUpdate::Metadata {
                title,
                artist,
                cover,
                duration_secs: dur,
            });
        }
        self.emit_state();
    }

    pub fn sync_queue(&self, snapshot: NativeQueueSnapshot) {
        let looping = snapshot.play_mode == PLAY_MODE_SINGLE;
        self.core.looping.store(looping, Ordering::Relaxed);
        if snapshot.list.is_empty() {
            let _ = self.storage.clear_json("playback-resume");
        }
        {
            let mut queue = self.queue.write();
            if queue.play_id != snapshot.play_id {
                self.lyrics.retain_track(snapshot.play_id.as_deref());
            }
            *queue = snapshot;
        }
        self.emit_state();
    }

    pub fn set_fft_enabled(&self, enabled: bool) {
        self.core.fft_enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            self.core.fft_ring.lock().clear();
        }
    }

    pub fn set_volume(&self, volume: f32) {
        let clamped = volume.clamp(0.0, 1.0);
        self.core
            .volume_bits
            .store(clamped.to_bits(), Ordering::Relaxed);
        self.emit_state();
    }

    pub fn set_muted(&self, muted: bool) {
        self.core.muted.store(muted, Ordering::Relaxed);
        self.emit_state();
    }

    pub fn set_rate(&self, rate: f32) {
        let clamped = rate.clamp(0.5, 2.0);
        self.core
            .rate_bits
            .store(clamped.to_bits(), Ordering::Relaxed);
        self.emit_state();
    }

    pub fn set_loop(&self, looping: bool) {
        self.core.looping.store(looping, Ordering::Relaxed);
    }

    pub fn current_track(&self) -> Option<NativeQueueTrack> {
        let queue = self.queue.read();
        queue
            .list
            .iter()
            .find(|t| Some(&t.id) == queue.play_id.as_ref())
            .cloned()
    }

    pub fn save_progress(&self) {
        if self.current_src.read().is_empty() {
            return;
        }
        let snap = self.get_state();
        let data = serde_json::json!({ "playId": snap.play_id, "position": snap.current_time,
            "volume": snap.volume, "isMuted": snap.muted, "playMode": snap.play_mode, "rate": snap.rate });
        let _ = self.storage.write_json("playback-resume", &data);
    }

    pub fn reserve_play(&self) -> u64 {
        let mut request = self.play_request.lock();
        *request += 1;
        *request
    }

    pub fn pause(&self) {
        self.reserve_play();
        self.reporter
            .finish(false, self.core.current_secs(), self.core.duration_secs());
        self.save_progress();
        self.core.is_playing.store(false, Ordering::SeqCst);
        self.emit_state();
    }

    pub fn stop(&self) {
        self.reserve_play();
        self.reporter
            .finish(true, self.core.current_secs(), self.core.duration_secs());
        self.core.generation.fetch_add(1, Ordering::SeqCst);
        self.core.is_playing.store(false, Ordering::SeqCst);
        self.core.position_ms.store(0, Ordering::SeqCst);
        self.core.duration_ms.store(0, Ordering::SeqCst);
        *self.current_src.write() = String::new();
        {
            let mut pcm = self.core.pcm.lock();
            pcm.clear();
            self.core.pcm_cv.notify_all();
        }
        if let Some(tx) = self.smtc_tx.lock().as_ref() {
            let _ = tx.send(SmtcUpdate::Stopped);
        }
        self.emit_state();
    }

    pub fn seek(&self, position_secs: f64) {
        let clamped_ms = (position_secs.max(0.0) * 1000.0).round() as u64;
        self.core.position_ms.store(clamped_ms, Ordering::SeqCst);
        self.core.seek_target_ms.store(clamped_ms, Ordering::SeqCst);
        {
            let mut pcm = self.core.pcm.lock();
            pcm.clear();
            self.core.pcm_cv.notify_all();
        }
        self.save_progress();
        self.emit_state();
    }

    pub fn play(self: &Arc<Self>, req: PlayRequest) -> Result<NativeAudioStateSnapshot, String> {
        let PlayRequest {
            request,
            src,
            start_secs,
            volume,
            muted,
            rate,
            looping,
        } = req;
        self.ensure_audio_output()?;
        let active = self.play_request.lock();
        if *active != request {
            return Err("play interrupted".into());
        }
        self.core
            .volume_bits
            .store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        self.core.muted.store(muted, Ordering::Relaxed);
        self.core
            .rate_bits
            .store(rate.clamp(0.5, 2.0).to_bits(), Ordering::Relaxed);
        self.core.looping.store(looping, Ordering::Relaxed);

        let same_src = *self.current_src.read() == src && !src.is_empty();
        let has_active_decoder = {
            let pcm = self.core.pcm.lock();
            !pcm.eof
                && (!pcm.samples.is_empty() || self.core.duration_ms.load(Ordering::Relaxed) > 0)
        };

        if same_src && has_active_decoder && (start_secs - self.core.current_secs()).abs() < 1.2 {
            self.core.is_playing.store(true, Ordering::SeqCst);
            self.core.pcm_cv.notify_all();
            self.emit_state();
            return Ok(self.get_state());
        }

        self.reporter
            .finish(true, self.core.current_secs(), self.core.duration_secs());
        let gen = self.core.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.current_src.write() = src.clone();
        let start_ms = (start_secs.max(0.0) * 1000.0).round() as u64;
        self.core.position_ms.store(start_ms, Ordering::SeqCst);
        self.core.duration_ms.store(0, Ordering::SeqCst);
        self.core.seek_target_ms.store(u64::MAX, Ordering::SeqCst);
        self.core.is_playing.store(true, Ordering::SeqCst);
        {
            let mut pcm = self.core.pcm.lock();
            pcm.clear();
            self.core.pcm_cv.notify_all();
        }

        drop(active);
        let engine = self.clone();
        let ready = Arc::new((Mutex::new(None::<Result<f64, String>>), Condvar::new()));
        let ready_clone = ready.clone();

        std::thread::Builder::new()
            .name(format!("biubiu-decode-{gen}"))
            .spawn(move || {
                run_decoder_thread(engine, gen, src, start_secs, ready_clone);
            })
            .map_err(|e| format!("spawn decoder failed: {e}"))?;

        let (lock, cv) = &*ready;
        let mut guard = lock.lock();
        let wait_res = cv.wait_while_for(
            &mut guard,
            |result| result.is_none(),
            Duration::from_secs(12),
        );
        if self.core.generation.load(Ordering::SeqCst) != gen {
            return Err("play interrupted".to_string());
        }
        if wait_res.timed_out() && guard.is_none() {
            self.stop();
            return Err("音频加载超时".to_string());
        }
        match guard.take() {
            Some(Ok(dur)) => {
                if dur > 0.0 {
                    self.core
                        .duration_ms
                        .store((dur * 1000.0).round() as u64, Ordering::SeqCst);
                }
                self.emit_state();
                Ok(self.get_state())
            }
            Some(Err(err)) => {
                self.core.is_playing.store(false, Ordering::SeqCst);
                self.emit_state();
                Err(err)
            }
            None => Ok(self.get_state()),
        }
    }

    /// Dispatch media control (from tray, shortcut, thumbar, SMTC, or mini player).
    /// Uses Main WebView if alive (preserving Bilibili heartbeats/history/lyrics),
    /// or autonomously controls the Rust audio engine & queue when Main WebView is destroyed!
    pub fn dispatch_control(self: &Arc<Self>, command: &str) {
        let has_main = self
            .app_handle
            .read()
            .as_ref()
            .and_then(|app| app.get_webview_window("main"))
            .is_some();

        if has_main {
            if let Some(app) = self.app_handle.read().as_ref() {
                match command {
                    "toggle" | "togglePlay" => {
                        let _ = app.emit("player://command", "toggle");
                    }
                    "prev" => {
                        let _ = app.emit("player://command", "prev");
                    }
                    "next" => {
                        let _ = app.emit("player://command", "next");
                    }
                    other => {
                        let _ = app.emit("shortcut://command", other);
                    }
                }
                return;
            }
        }

        // Autonomous Rust playback control when main WebView is destroyed
        match command {
            "toggle" | "togglePlay" => {
                if self.core.is_playing.load(Ordering::Relaxed) {
                    self.pause();
                } else {
                    let src = self.current_src.read().clone();
                    if !src.is_empty() {
                        let eng = self.clone();
                        let pos = self.core.current_secs();
                        let vol = self.core.volume();
                        let muted = self.core.muted.load(Ordering::Relaxed);
                        let rate = self.core.rate();
                        let looping = self.core.looping.load(Ordering::Relaxed);
                        let request = self.reserve_play();
                        tauri::async_runtime::spawn_blocking(move || {
                            let _ = eng.play(PlayRequest {
                                request,
                                src,
                                start_secs: pos,
                                volume: vol,
                                muted,
                                rate,
                                looping,
                            });
                        });
                    } else {
                        self.autonomous_play_current();
                    }
                }
            }
            "next" => self.autonomous_next(),
            "prev" => self.autonomous_prev(),
            "volumeUp" => self.set_volume((self.core.volume() + 0.05).min(1.0)),
            "volumeDown" => self.set_volume((self.core.volume() - 0.05).max(0.0)),
            _ => {}
        }
    }

    pub fn handle_mini_command(
        self: &Arc<Self>,
        command: &str,
        payload: Option<MiniCommandPayload>,
    ) {
        match command {
            "init" => self.emit_state(),
            "togglePlay" => self.dispatch_control("toggle"),
            "next" => self.dispatch_control("next"),
            "prev" => self.dispatch_control("prev"),
            "seek" => {
                if let Some(t) = payload.and_then(|p| p.current_time) {
                    self.seek(t);
                }
            }
            "setVolume" => {
                if let Some(v) = payload.and_then(|p| p.volume) {
                    let clamped = v.clamp(0.0, 1.0);
                    if clamped > 0.0 && self.core.muted.load(Ordering::Relaxed) {
                        self.core.muted.store(false, Ordering::Relaxed);
                    }
                    self.set_volume(clamped);
                    self.emit_track_changed();
                }
            }
            "adjustVolume" => {
                if let Some(delta) = payload.and_then(|p| p.volume_delta) {
                    let base = if self.core.muted.load(Ordering::Relaxed) {
                        0.0
                    } else {
                        self.core.volume()
                    };
                    let next = (base + delta).clamp(0.0, 1.0);
                    if next > 0.0 {
                        self.core.muted.store(false, Ordering::Relaxed);
                    }
                    self.set_volume(next);
                    self.emit_track_changed();
                }
            }
            "toggleMute" => {
                let next = !self.core.muted.load(Ordering::Relaxed);
                self.set_muted(next);
                self.emit_track_changed();
            }
            "volumeUp" => {
                self.set_volume((self.core.volume() + 0.05).min(1.0));
                self.emit_track_changed();
            }
            "volumeDown" => {
                self.set_volume((self.core.volume() - 0.05).max(0.0));
                self.emit_track_changed();
            }
            "togglePlayMode" => {
                let next_mode = {
                    let mut q = self.queue.write();
                    q.play_mode = match q.play_mode {
                        PLAY_MODE_SEQUENCE => PLAY_MODE_LOOP,
                        PLAY_MODE_LOOP => PLAY_MODE_RANDOM,
                        PLAY_MODE_RANDOM => PLAY_MODE_SINGLE,
                        _ => PLAY_MODE_SEQUENCE,
                    };
                    q.play_mode
                };
                self.set_loop(next_mode == PLAY_MODE_SINGLE);
                self.emit_state();
                self.emit_track_changed();
            }
            _ => {}
        }
    }

    fn emit_track_changed(&self) {
        if let Some(app) = self.app_handle.read().as_ref() {
            let q = self.queue.read();
            let _ = app.emit(
                "audio://track-changed",
                serde_json::json!({
                    "playId": q.play_id,
                    "playMode": q.play_mode,
                    "volume": self.core.volume(),
                    "muted": self.core.muted.load(Ordering::Relaxed),
                }),
            );
        }
    }

    fn record_completion(&self) {
        self.reporter
            .finish(true, self.core.current_secs(), self.core.duration_secs());
        let enabled = self
            .storage
            .read_json("app-settings")
            .ok()
            .flatten()
            .and_then(|v| v.pointer("/appSettings/recordLocalHistory")?.as_bool())
            .unwrap_or(false);
        if !enabled {
            return;
        }
        let Some(track) = self.current_track() else {
            return;
        };
        let duration = self.core.duration_secs();
        let duration = if duration > 0.0 {
            duration
        } else {
            self.core.current_secs()
        };
        if duration <= 0.0 {
            return;
        }
        let (source, key) = match track.source.as_deref() {
            Some("local") => ("本地", track.id),
            Some("webdav") => ("WebDAV", track.id),
            _ => (
                "B 站",
                match track.bvid {
                    Some(bv) => format!("{bv}:{}", track.cid.unwrap_or_default()),
                    None => format!("au{}", track.sid.unwrap_or_default()),
                },
            ),
        };
        let entry = crate::storage::ListeningEntry {
            at: chrono::Utc::now().timestamp_millis(),
            source: source.into(),
            key: key.chars().take(160).collect(),
            title: track
                .page_title
                .unwrap_or(track.title)
                .chars()
                .take(384)
                .collect(),
            seconds: duration.round(),
        };
        if self.storage.sqlite_history_add(entry, 2000).is_ok() {
            if let Some(app) = self.app_handle.read().as_ref() {
                let _ = app.emit("history://changed", ());
            }
        }
    }

    fn on_track_ended(self: &Arc<Self>) {
        self.record_completion();
        let has_main = self
            .app_handle
            .read()
            .as_ref()
            .and_then(|app| app.get_webview_window("main"))
            .is_some();

        if has_main {
            if let Some(app) = self.app_handle.read().as_ref() {
                let _ = app.emit("audio://ended", serde_json::json!({ "looped": false }));
            }
            return;
        }

        // Main WebView is destroyed: advance queue natively in Rust!
        let should_stop = {
            let q = self.queue.read();
            if q.list.is_empty() {
                true
            } else if q.play_mode == PLAY_MODE_SEQUENCE {
                let idx = q
                    .play_id
                    .as_deref()
                    .and_then(|id| q.list.iter().position(|t| t.id == id))
                    .unwrap_or(0);
                idx + 1 >= q.list.len()
            } else {
                false
            }
        };

        if should_stop {
            self.core.position_ms.store(0, Ordering::SeqCst);
            self.pause();
            return;
        }
        self.autonomous_next();
    }

    fn autonomous_next(self: &Arc<Self>) {
        let target_track = {
            let mut q = self.queue.write();
            if q.list.is_empty() {
                return;
            }
            if let Some(next_id) = q.next_id.take() {
                q.play_id = Some(next_id);
            } else {
                let cur_idx = q
                    .play_id
                    .as_deref()
                    .and_then(|id| q.list.iter().position(|t| t.id == id))
                    .unwrap_or(0);
                let next_idx = if q.play_mode == PLAY_MODE_RANDOM && q.list.len() > 1 {
                    let cur = &q.list[cur_idx];
                    let mut chosen = None;
                    if q.should_keep_pages_order_in_random_play_mode {
                        if let (Some(bvid), Some(p), Some(total)) =
                            (cur.bvid.as_deref(), cur.page_index, cur.total_page)
                        {
                            if p < total {
                                chosen = q.list.iter().position(|t| {
                                    t.bvid.as_deref() == Some(bvid) && t.page_index == Some(p + 1)
                                });
                            }
                        }
                    }
                    chosen.unwrap_or_else(|| {
                        let seed = chrono::Utc::now().timestamp_subsec_nanos() as usize;
                        let offset = 1 + (seed % (q.list.len() - 1));
                        (cur_idx + offset) % q.list.len()
                    })
                } else {
                    (cur_idx + 1) % q.list.len()
                };
                q.play_id = Some(q.list[next_idx].id.clone());
            }
            q.play_id
                .as_deref()
                .and_then(|id| q.list.iter().find(|t| t.id == id))
                .cloned()
        };
        if let Some(track) = target_track {
            self.spawn_autonomous_track_play(track);
        }
    }

    fn autonomous_prev(self: &Arc<Self>) {
        let target_track = {
            let mut q = self.queue.write();
            if q.list.is_empty() {
                return;
            }
            let cur_idx = q
                .play_id
                .as_deref()
                .and_then(|id| q.list.iter().position(|t| t.id == id))
                .unwrap_or(0);
            let prev_idx = (cur_idx + q.list.len() - 1) % q.list.len();
            q.play_id = Some(q.list[prev_idx].id.clone());
            Some(q.list[prev_idx].clone())
        };
        if let Some(track) = target_track {
            self.spawn_autonomous_track_play(track);
        }
    }

    fn autonomous_play_current(self: &Arc<Self>) {
        let track = {
            let q = self.queue.read();
            q.play_id
                .as_deref()
                .and_then(|id| q.list.iter().find(|t| t.id == id))
                .cloned()
        };
        if let Some(t) = track {
            self.spawn_autonomous_track_play(t);
        }
    }

    fn spawn_autonomous_track_play(self: &Arc<Self>, track: NativeQueueTrack) {
        self.lyrics
            .retain_track(self.queue.read().play_id.as_deref());
        self.stop();
        let request = self.reserve_play();
        let eng = self.clone();
        tauri::async_runtime::spawn(async move {
            let url = match eng.resolve_track_audio_url(&track).await {
                Some(u) => u,
                None => return,
            };
            if *eng.play_request.lock() != request
                || eng.queue.read().play_id.as_deref() != Some(&track.id)
            {
                return;
            }
            let title = track
                .page_title
                .clone()
                .unwrap_or_else(|| track.title.clone());
            let cover = track.page_cover.clone().or_else(|| track.cover.clone());
            eng.set_metadata(NativeTrackMetadata {
                play_id: Some(track.id.clone()),
                title: Some(title),
                artist: track.owner_name.clone(),
                cover,
                duration: track.duration,
            });
            let vol = eng.core.volume();
            let muted = eng.core.muted.load(Ordering::Relaxed);
            let rate = eng.core.rate();
            let looping = eng.core.looping.load(Ordering::Relaxed);
            tauri::async_runtime::spawn_blocking(move || {
                if *eng.play_request.lock() != request
                    || eng.queue.read().play_id.as_deref() != Some(&track.id)
                {
                    return;
                }
                if eng
                    .play(PlayRequest {
                        request,
                        src: url,
                        start_secs: 0.0,
                        volume: vol,
                        muted,
                        rate,
                        looping,
                    })
                    .is_ok()
                {
                    eng.emit_track_changed();
                }
            });
        });
    }

    async fn resolve_track_audio_url(&self, track: &NativeQueueTrack) -> Option<String> {
        let src_kind = track.source.as_deref().unwrap_or("online");
        if src_kind == "local" || src_kind == "webdav" {
            return track.audio_url.clone();
        }
        if let Some(ref existing) = track.audio_url {
            if is_bili_url_still_valid(existing) {
                return Some(existing.clone());
            }
        }
        let preferred_host = self
            .storage
            .get_app_setting_string("preferredAudioHost")
            .unwrap_or_default();
        if track.track_type == "mv" {
            let bvid = track.bvid.as_deref()?;
            let cid = match track.cid.as_deref() {
                Some(c) if !c.is_empty() => c.to_string(),
                _ => {
                    let view = self.http.get_web_interface_view(bvid).await.ok()?;
                    let index = track.page_index.unwrap_or(1).max(1) - 1;
                    view.pointer(&format!("/data/pages/{index}/cid"))?
                        .as_i64()?
                        .to_string()
                }
            };
            let json = self.http.get_dash_playurl(bvid, &cid, 4048).await.ok()?;
            let quality = self
                .storage
                .get_app_setting_string("audioQuality")
                .unwrap_or_else(|| "auto".into());
            let candidates = extract_dash_audio_candidates(&json, &quality);
            return pick_preferred_host(&candidates, &preferred_host);
        }
        if track.track_type == "audio" {
            let sid = track.sid?;
            let user = self.storage.read_json("user-login-info").ok().flatten();
            let mid = user
                .as_ref()
                .and_then(|u| u.get("mid"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let vip = user
                .as_ref()
                .and_then(|u| u.get("vipStatus"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let json = self
                .http
                .get_audio_web_stream_url(&sid.to_string(), mid, vip)
                .await
                .ok()?;
            let cdns: Vec<String> = json
                .pointer("/data/cdns")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            return pick_preferred_host(&cdns, &preferred_host);
        }
        None
    }
}

fn is_bili_url_still_valid(url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(url) {
        for (k, v) in parsed.query_pairs() {
            if k == "deadline" {
                if let Ok(dl) = v.parse::<i64>() {
                    return chrono::Utc::now().timestamp() + 10 < dl;
                }
            }
        }
    }
    false
}

fn extract_dash_audio_candidates(json: &serde_json::Value, quality: &str) -> Vec<String> {
    let pick_stream = |stream: &serde_json::Value| -> Vec<String> {
        let mut out = Vec::new();
        for key in ["baseUrl", "base_url"] {
            if let Some(u) = stream.get(key).and_then(|v| v.as_str()) {
                if !u.is_empty() && !out.contains(&u.to_string()) {
                    out.push(u.to_string());
                }
            }
        }
        for key in ["backupUrl", "backup_url"] {
            if let Some(arr) = stream.get(key).and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(u) = item.as_str() {
                        if !u.is_empty() && !out.contains(&u.to_string()) {
                            out.push(u.to_string());
                        }
                    }
                }
            }
        }
        out
    };
    if matches!(quality, "auto" | "lossless") {
        for path in ["/data/dash/flac/audio", "/data/dash/dolby/audio/0"] {
            if let Some(stream) = json.pointer(path) {
                let urls = pick_stream(stream);
                if !urls.is_empty() {
                    return urls;
                }
            }
        }
    }
    if let Some(audios) = json.pointer("/data/dash/audio").and_then(|v| v.as_array()) {
        let mut sorted: Vec<_> = audios.iter().collect();
        sorted.sort_by_key(|a| {
            std::cmp::Reverse((
                a["bandwidth"].as_u64().unwrap_or(0),
                [30257, 30216, 30259, 30260, 30232, 30280, 30250, 30251]
                    .iter()
                    .position(|id| Some(*id) == a["id"].as_u64()),
            ))
        });
        let last = sorted.len().saturating_sub(1);
        let index = match quality {
            "low" => last,
            "medium" => last / 2,
            _ => 0,
        };
        if let Some(stream) = sorted.get(index) {
            return pick_stream(stream);
        }
    }
    Vec::new()
}

fn pick_preferred_host(candidates: &[String], preferred_host: &str) -> Option<String> {
    if !preferred_host.is_empty() {
        if let Some(found) = candidates.iter().find(|u| {
            url::Url::parse(u)
                .ok()
                .and_then(|p| p.host_str().map(|h| h == preferred_host))
                .unwrap_or(false)
        }) {
            return Some(found.clone());
        }
    }
    candidates.first().cloned()
}

fn open_output<T: cpal::SizedSample + cpal::FromSample<f32>>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    core: Arc<SharedAudioCore>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    let dst_channels = config.channels as usize;
    let dst_rate = config.sample_rate.0 as f64;
    let mut fractional_ms = 0.0;
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            if !core.is_playing.load(Ordering::Relaxed) {
                data.fill(T::from_sample(0.0));
                return;
            }
            let gain = if core.muted.load(Ordering::Relaxed) {
                0.0
            } else {
                core.volume()
            };
            let rate = core.rate() as f64;
            let fft_on = core.fft_enabled.load(Ordering::Relaxed);

            let mut pcm = core.pcm.lock();
            let step = (pcm.src_sample_rate as f64 / dst_rate) * rate;
            let mut consumed_src_frames: f64 = 0.0;
            let mut fft_ring = fft_on.then(|| core.fft_ring.lock());
            for frame in data.chunks_mut(dst_channels.max(1)) {
                let avail_frames = pcm.samples.len() / 2;
                if avail_frames < 2 {
                    for s in frame.iter_mut() {
                        *s = T::from_sample(0.0);
                    }
                    continue;
                }
                let idx0 = pcm.frac_pos.floor() as usize;
                if idx0 + 1 >= avail_frames {
                    for s in frame.iter_mut() {
                        *s = T::from_sample(0.0);
                    }
                    continue;
                }
                let frac = (pcm.frac_pos - idx0 as f64) as f32;
                let l0 = pcm.samples[idx0 * 2];
                let r0 = pcm.samples[idx0 * 2 + 1];
                let l1 = pcm.samples[(idx0 + 1) * 2];
                let r1 = pcm.samples[(idx0 + 1) * 2 + 1];
                let l = l0 + (l1 - l0) * frac;
                let r = r0 + (r1 - r0) * frac;

                if dst_channels == 1 {
                    frame[0] = T::from_sample((l + r) * 0.5 * gain);
                } else {
                    frame[0] = T::from_sample(l * gain);
                    frame[1] = T::from_sample(r * gain);
                    for ch in frame.iter_mut().skip(2) {
                        *ch = T::from_sample(0.0);
                    }
                }
                if let Some(ring) = fft_ring.as_mut() {
                    if ring.len() == 1024 {
                        ring.pop_front();
                    }
                    ring.push_back((l + r) * 0.5);
                }
                pcm.frac_pos += step;
                consumed_src_frames += step;
            }

            let drop_frames = pcm.frac_pos.floor() as usize;
            if drop_frames > 0 {
                let to_drain = (drop_frames * 2).min(pcm.samples.len());
                pcm.samples.drain(..to_drain);
                pcm.frac_pos -= drop_frames as f64;
            }
            if pcm.samples.len() < 48_000 {
                core.pcm_cv.notify_one();
            }
            let src_rate = pcm.src_sample_rate.max(1) as f64;
            drop(pcm);

            if consumed_src_frames > 0.0 {
                let exact_ms = consumed_src_frames / src_rate * 1000.0 + fractional_ms;
                let delta_ms = exact_ms as u64;
                fractional_ms = exact_ms - delta_ms as f64;
                if delta_ms > 0 {
                    core.position_ms.fetch_add(delta_ms, Ordering::Relaxed);
                }
            }
        },
        |_error| {},
        None,
    )
}

fn run_cpal_output(core: Arc<SharedAudioCore>, started: ReadySignal<()>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            let (lock, cv) = &*started;
            *lock.lock() = Some(Err("未检测到可用音频输出设备".to_string()));
            cv.notify_all();
            return Err("no output device".to_string());
        }
    };
    let default_cfg = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            let (lock, cv) = &*started;
            *lock.lock() = Some(Err(format!("音频设备初始化失败: {e}")));
            cv.notify_all();
            return Err(e.to_string());
        }
    };

    let config = default_cfg.config();
    use cpal::SampleFormat::*;
    let stream = match default_cfg.sample_format() {
        F32 => open_output::<f32>(&device, &config, core),
        F64 => open_output::<f64>(&device, &config, core),
        I8 => open_output::<i8>(&device, &config, core),
        I16 => open_output::<i16>(&device, &config, core),
        I32 => open_output::<i32>(&device, &config, core),
        I64 => open_output::<i64>(&device, &config, core),
        U8 => open_output::<u8>(&device, &config, core),
        U16 => open_output::<u16>(&device, &config, core),
        U32 => open_output::<u32>(&device, &config, core),
        U64 => open_output::<u64>(&device, &config, core),
        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let (lock, cv) = &*started;
            *lock.lock() = Some(Err(format!("音频流创建失败: {e}")));
            cv.notify_all();
            return Err(e.to_string());
        }
    };
    if let Err(e) = stream.play() {
        let (lock, cv) = &*started;
        *lock.lock() = Some(Err(format!("音频流启动失败: {e}")));
        cv.notify_all();
        return Err(e.to_string());
    }

    {
        let (lock, cv) = &*started;
        *lock.lock() = Some(Ok(()));
        cv.notify_all();
    }

    // Keep the cpal::Stream alive for the lifetime of the app
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

fn is_bili_media(src: &str) -> bool {
    url::Url::parse(src)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| {
            ["bilibili.com", "bilivideo.com", "bilivideo.cn"]
                .iter()
                .any(|domain| &host == domain || host.ends_with(&format!(".{domain}")))
        })
}

fn open_media_source(engine: &AudioEngineHandle, src: &str) -> Result<OpenedMedia, String> {
    let mut hint = Hint::new();

    if src.starts_with("biu-webdav://audio/") {
        let rest = src.trim_start_matches("biu-webdav://audio/");
        let mut parts = rest.splitn(2, '/');
        let list_id = parts.next().ok_or("无效的 WebDAV 链接")?;
        let track_id = parts.next().ok_or("无效的 WebDAV 链接")?;
        let (client, track, cache_audio) = engine.webdav.open_track(list_id, track_id)?;
        if !track.format.is_empty() {
            hint.with_extension(&track.format);
        }
        let ver = track_version(&track);
        if cache_audio {
            if let Some(cached) = engine.webdav.cached_audio_path(&ver) {
                let file = File::open(&cached).map_err(|e| e.to_string())?;
                return Ok((
                    Box::new(file),
                    hint,
                    Some(cached.to_string_lossy().to_string()),
                ));
            }
        }
        let app = engine.app_handle.read().clone().ok_or("应用尚未就绪")?;
        let state = app.state::<Arc<crate::state::AppState>>();
        let url = format!(
            "{}/webdav/audio/{}/{}?token={}",
            state.media_base_url(),
            urlencoding::encode(list_id),
            urlencoding::encode(track_id),
            state.media_token
        );
        if cache_audio {
            engine.webdav.cache_audio(client, track, ver);
        }
        let reader = HttpAudio::open(
            engine.http.media_client(true)?,
            url.clone(),
            Default::default(),
        )
        .map_err(|err| format!("无法读取 WebDAV 音频: {err}"))?;
        return Ok((Box::new(reader), hint, Some(url)));
    }

    if src.starts_with("file://") {
        for p in file_url_to_path_candidates(src) {
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    hint.with_extension(ext);
                }
                let file = File::open(&p).map_err(|e| format!("无法打开本地音频文件: {e}"))?;
                return Ok((Box::new(file), hint, Some(p.to_string_lossy().to_string())));
            }
        }
        return Err("找不到本地音频文件".to_string());
    }

    if src.starts_with("http://") || src.starts_with("https://") {
        if let Ok(parsed) = url::Url::parse(src) {
            if let Some(ext) = parsed
                .path()
                .rsplit('/')
                .next()
                .and_then(|f| f.rsplit_once('.'))
                .map(|(_, e)| e)
            {
                if ext.len() <= 5 {
                    hint.with_extension(ext);
                }
            }
        }
        let mut headers = reqwest::header::HeaderMap::new();
        if is_bili_media(src) {
            headers.insert(
                REFERER,
                reqwest::header::HeaderValue::from_static(BILI_REFERER),
            );
            headers.insert(
                ORIGIN,
                reqwest::header::HeaderValue::from_static(BILI_ORIGIN),
            );
        }
        let reader = HttpAudio::open(engine.http.media_client(false)?, src.to_owned(), headers)
            .map_err(|err| format!("无法读取音频: {err}"))?;
        return Ok((Box::new(reader), hint, Some(src.to_string())));
    }

    // Plain filesystem path fallback
    let p = PathBuf::from(src);
    if p.is_file() {
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let file = File::open(&p).map_err(|e| e.to_string())?;
        return Ok((Box::new(file), hint, Some(src.to_string())));
    }

    Err("不支持的音频源".to_string())
}

fn run_decoder_thread(
    engine: Arc<AudioEngineHandle>,
    gen: u64,
    src: String,
    start_secs: f64,
    ready: ReadySignal<f64>,
) {
    let signal_ready = |res: Result<f64, String>| {
        let (lock, cv) = &*ready;
        let mut guard = lock.lock();
        if guard.is_none() {
            *guard = Some(res);
            cv.notify_all();
        }
    };

    let (media_src, hint, ffmpeg_fallback_input) = match open_media_source(&engine, &src) {
        Ok(v) => v,
        Err(err) => {
            signal_ready(Err(err));
            return;
        }
    };

    let mss = MediaSourceStream::new(media_src, Default::default());
    let probed = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions {
            enable_gapless: true,
            ..Default::default()
        },
        &MetadataOptions::default(),
    );

    let mut format = match probed {
        Ok(p) => p.format,
        Err(_) => {
            // Fallback to bundled FFmpeg PCM pipe for WMA/Opus/exotic containers
            if let Some(input) = ffmpeg_fallback_input {
                run_ffmpeg_fallback_decoder(engine, gen, input, start_secs, ready);
            } else {
                signal_ready(Err("不支持的音频格式".to_string()));
            }
            return;
        }
    };

    let Some(track) = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .cloned()
    else {
        signal_ready(Err("音频流中未找到音轨".to_string()));
        return;
    };
    let track_id = track.id;
    let time_base = track.codec_params.time_base;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(48_000);
    let duration_secs = track
        .codec_params
        .n_frames
        .map(|frames| frames as f64 / sample_rate.max(1) as f64)
        .unwrap_or(0.0);

    let mut decoder = match symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
    {
        Ok(d) => d,
        Err(_) => {
            if let Some(input) = ffmpeg_fallback_input {
                run_ffmpeg_fallback_decoder(engine, gen, input, start_secs, ready);
            } else {
                signal_ready(Err("音频解码器不支持该编码".to_string()));
            }
            return;
        }
    };

    {
        let mut pcm = engine.core.pcm.lock();
        pcm.src_sample_rate = sample_rate;
    }

    if start_secs > 0.2 {
        let whole = start_secs.floor() as u64;
        let frac = start_secs - whole as f64;
        let _ = format.seek(
            SeekMode::Coarse,
            SeekTo::Time {
                time: Time::new(whole, frac),
                track_id: Some(track_id),
            },
        );
        decoder.reset();
    }

    signal_ready(Ok(duration_secs));

    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        if engine.core.generation.load(Ordering::SeqCst) != gen {
            return;
        }

        let seek_ms = engine.core.seek_target_ms.swap(u64::MAX, Ordering::SeqCst);
        if seek_ms != u64::MAX {
            let secs = seek_ms as f64 / 1000.0;
            let whole = secs.floor() as u64;
            let frac = secs - whole as f64;
            if format
                .seek(
                    SeekMode::Coarse,
                    SeekTo::Time {
                        time: Time::new(whole, frac),
                        track_id: Some(track_id),
                    },
                )
                .is_ok()
            {
                decoder.reset();
            }
        }

        // Backpressure: keep buffer under ~1.0s (~96k interleaved stereo floats = 384 KiB)
        {
            let mut pcm = engine.core.pcm.lock();
            while pcm.samples.len() >= 96_000
                && engine.core.generation.load(Ordering::SeqCst) == gen
                && engine.core.seek_target_ms.load(Ordering::Relaxed) == u64::MAX
            {
                engine
                    .core
                    .pcm_cv
                    .wait_for(&mut pcm, Duration::from_millis(50));
            }
        }

        if engine.core.generation.load(Ordering::SeqCst) != gen {
            return;
        }

        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                wait_for_drain(&engine, gen);
                if engine.core.generation.load(Ordering::SeqCst) != gen {
                    return;
                }
                if engine.core.seek_target_ms.load(Ordering::SeqCst) != u64::MAX {
                    continue;
                }
                if engine.core.looping.load(Ordering::Relaxed) {
                    engine.record_completion();
                    let _ = format.seek(
                        SeekMode::Coarse,
                        SeekTo::Time {
                            time: Time::new(0, 0.0),
                            track_id: Some(track_id),
                        },
                    );
                    decoder.reset();
                    engine.core.position_ms.store(0, Ordering::SeqCst);
                    engine.core.pcm.lock().eof = false;
                    if let Some(app) = engine.app_handle.read().as_ref() {
                        let _ = app.emit("audio://ended", serde_json::json!({ "looped": true }));
                    }
                    continue;
                }

                engine.core.is_playing.store(false, Ordering::SeqCst);
                engine.emit_state();
                engine.on_track_ended();
                return;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => {
                // Recoverable packet error or truncated stream -> finish track cleanly
                engine.core.is_playing.store(false, Ordering::SeqCst);
                engine.emit_state();
                engine.on_track_ended();
                return;
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        if let Some(tb) = time_base {
            let ts = tb.calc_time(packet.ts());
            let pkt_ms = ((ts.seconds as f64 + ts.frac) * 1000.0) as u64;
            // Gently correct drift when ring buffer is nearly empty
            let buffered_ms = {
                let pcm = engine.core.pcm.lock();
                (pcm.samples.len() as f64 / 2.0 / pcm.src_sample_rate.max(1) as f64 * 1000.0) as u64
            };
            let exact_ms = pkt_ms.saturating_sub(buffered_ms);
            let cur_ms = engine.core.position_ms.load(Ordering::Relaxed);
            if cur_ms.abs_diff(exact_ms) > 400 {
                engine.core.position_ms.store(exact_ms, Ordering::Relaxed);
            }
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => continue,
        };

        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        let frames = decoded.capacity();
        if sample_buf.is_none() || sample_buf.as_ref().unwrap().capacity() < frames * ch {
            sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let sbuf = sample_buf.as_mut().unwrap();
        sbuf.copy_interleaved_ref(decoded);
        let slice = sbuf.samples();

        let mut pcm = engine.core.pcm.lock();
        if engine.core.generation.load(Ordering::SeqCst) != gen {
            return;
        }
        pcm.src_sample_rate = spec.rate;
        if ch == 1 {
            for &s in slice {
                pcm.samples.push_back(s);
                pcm.samples.push_back(s);
            }
        } else if ch == 2 {
            pcm.samples.extend(slice.iter().copied());
        } else {
            for frame in slice.chunks_exact(ch) {
                pcm.samples.push_back(frame[0]);
                pcm.samples.push_back(frame[1]);
            }
        }
    }
}

fn run_ffmpeg_fallback_decoder(
    engine: Arc<AudioEngineHandle>,
    gen: u64,
    input: String,
    start_secs: f64,
    ready: ReadySignal<f64>,
) {
    let mut position = start_secs;
    let mut started = false;
    let mut decode = || -> Result<(), String> {
        loop {
            let mut cmd = Command::new(engine.ffmpeg_path.read().as_os_str());
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            if input.starts_with("https://") || input.starts_with("http://") {
                cmd.args(["-rw_timeout", "12000000"]);
            }
            if is_bili_media(&input) {
                cmd.args(["-referer", BILI_REFERER, "-user_agent", USER_AGENT_STR]);
            }
            if position > 0.0 {
                cmd.args(["-ss", &format!("{position:.3}")]);
            }
            let mut child = cmd
                .args([
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-i",
                    &input,
                    "-vn",
                    "-f",
                    "f32le",
                    "-acodec",
                    "pcm_f32le",
                    "-ac",
                    "2",
                    "-ar",
                    "48000",
                    "pipe:1",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("FFmpeg 启动失败: {e}"))?;
            let mut stdout = child.stdout.take().unwrap();
            let mut raw = [0u8; 16384];
            let mut tail = 0;
            let mut eof = false;
            while engine.core.generation.load(Ordering::SeqCst) == gen {
                let mut pcm = engine.core.pcm.lock();
                if engine.core.seek_target_ms.load(Ordering::SeqCst) != u64::MAX {
                    break;
                }
                if pcm.samples.len() >= 96_000 {
                    engine
                        .core
                        .pcm_cv
                        .wait_for(&mut pcm, Duration::from_millis(50));
                    continue;
                }
                drop(pcm);
                match stdout.read(&mut raw[tail..]) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(n) => {
                        let used = tail + n;
                        let end = used - used % 8;
                        let mut pcm = engine.core.pcm.lock();
                        if engine.core.generation.load(Ordering::SeqCst) != gen {
                            break;
                        }
                        pcm.src_sample_rate = 48_000;
                        pcm.samples.extend(
                            raw[..end]
                                .as_chunks::<4>()
                                .0
                                .iter()
                                .copied()
                                .map(f32::from_le_bytes),
                        );
                        tail = used - end;
                        raw.copy_within(end..used, 0);
                        if !started && end > 0 {
                            started = true;
                            *ready.0.lock() = Some(Ok(0.0));
                            ready.1.notify_all();
                        }
                    }
                    Err(_) => break,
                }
            }
            drop(stdout);
            if !eof {
                let _ = child.kill();
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            if engine.core.generation.load(Ordering::SeqCst) != gen {
                return Ok(());
            }
            if eof && status.success() && started {
                wait_for_drain(&engine, gen);
            }
            if engine.core.generation.load(Ordering::SeqCst) != gen {
                return Ok(());
            }
            let seek = engine.core.seek_target_ms.swap(u64::MAX, Ordering::SeqCst);
            if seek != u64::MAX {
                position = seek as f64 / 1000.0;
                continue;
            }
            if !eof || !status.success() || !started {
                return Err("FFmpeg 无法解码音频".into());
            }
            if !engine.core.looping.load(Ordering::Relaxed) {
                engine.core.is_playing.store(false, Ordering::SeqCst);
                engine.emit_state();
                engine.on_track_ended();
                return Ok(());
            }
            engine.record_completion();
            position = 0.0;
            engine.core.pcm.lock().clear();
            engine.core.position_ms.store(0, Ordering::SeqCst);
        }
    };
    if let Err(message) = decode() {
        if !started {
            *ready.0.lock() = Some(Err(message));
            ready.1.notify_all();
        } else if engine.core.generation.load(Ordering::SeqCst) == gen {
            engine.core.is_playing.store(false, Ordering::SeqCst);
            engine.emit_state();
            if let Some(app) = engine.app_handle.read().as_ref() {
                let _ = app.emit(
                    "audio://error",
                    serde_json::json!({ "code": 3, "message": message }),
                );
            }
        }
    }
}

fn wait_for_drain(engine: &AudioEngineHandle, generation: u64) {
    let mut pcm = engine.core.pcm.lock();
    pcm.eof = true;
    while pcm.samples.len() >= 4
        && engine.core.generation.load(Ordering::SeqCst) == generation
        && engine.core.seek_target_ms.load(Ordering::SeqCst) == u64::MAX
    {
        engine
            .core
            .pcm_cv
            .wait_for(&mut pcm, Duration::from_millis(50));
    }
}

#[cfg(target_os = "windows")]
fn create_hidden_message_hwnd() -> Option<*mut std::ffi::c_void> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    let class_name: Vec<u16> = "BiuBiuSmtcHiddenWindow\0".encode_utf16().collect();
    unsafe {
        let hinstance = GetModuleHandleW(None).ok()?;
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        let _ = RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            hinstance,
            None,
        )
        .ok()?;
        Some(hwnd.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_playback_honors_frontend_quality_and_mirrors() {
        let data = serde_json::json!({"data":{"dash":{"dolby":{"audio":[{"baseUrl":"dolby"}]},
            "audio":[{"bandwidth":20,"base_url":"medium"},{"bandwidth":30,"baseUrl":"high","backupUrl":["https://backup.example/a"]},{"bandwidth":10,"baseUrl":"low"}]}}});
        for (quality, want) in [
            ("auto", "dolby"),
            ("lossless", "dolby"),
            ("high", "high"),
            ("medium", "medium"),
            ("low", "low"),
        ] {
            assert_eq!(extract_dash_audio_candidates(&data, quality)[0], want);
        }
        assert_eq!(
            pick_preferred_host(
                &extract_dash_audio_candidates(&data, "high"),
                "backup.example"
            )
            .as_deref(),
            Some("https://backup.example/a")
        );
    }
}
