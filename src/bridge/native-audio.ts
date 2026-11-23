import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isTauriRuntime } from "./env";

export interface NativeAudioStateSnapshot {
  src: string;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  rate: number;
  looping: boolean;
  playId?: string;
  title?: string;
  artist?: string;
  cover?: string;
  playMode?: number;
  isSingle?: boolean;
}

export interface NativeTrackMetadata {
  playId?: string;
  title?: string;
  artist?: string;
  cover?: string;
  duration?: number;
}

export interface NativeQueueTrack {
  id: string;
  title: string;
  type: "mv" | "audio";
  source?: "local" | "online" | "webdav";
  bvid?: string;
  aid?: string;
  cid?: string;
  sid?: number;
  audioUrl?: string;
  cover?: string;
  ownerName?: string;
  pageTitle?: string;
  pageCover?: string;
  pageIndex?: number;
  totalPage?: number;
  duration?: number;
  webDavListId?: string;
}

export interface NativeQueueSnapshot {
  list: NativeQueueTrack[];
  playId?: string;
  nextId?: string;
  playMode: number;
  shouldKeepPagesOrderInRandomPlayMode: boolean;
}

type AudioEventName =
  | "durationchange"
  | "timeupdate"
  | "seeked"
  | "ratechange"
  | "onerror"
  | "error"
  | "play"
  | "playing"
  | "pause"
  | "ended";

/**
 * HTMLAudioElement-compatible proxy backed by the Rust native audio engine (symphonia + cpal + rustfft).
 * Keeps smooth 60fps interpolated `currentTime` locally between 200ms Rust progress ticks.
 */
export class NativeAudioAdapter {
  preload = "metadata";
  controls = false;
  crossOrigin: string | null = "anonymous";

  ondurationchange: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onseeked: (() => void) | null = null;
  onratechange: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;

  private _src = "";
  private _backendSrc = "";
  private _paused = true;
  private _seeking = false;
  private _volume = 0.5;
  private _muted = false;
  private _rate = 1;
  private _defaultRate = 1;
  private _loop = false;
  private _duration = Number.NaN;
  private _baseTime = 0;
  private _basePerfMs = 0;
  private _error: { code: number; message: string } | null = null;
  private _listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private _unlisteners: UnlistenFn[] = [];
  private _hydrated = false;
  private _pendingSeek: number | null = null;
  private _loadSeq = 0;
  private _playSeq = 0;

  constructor() {
    if (isTauriRuntime()) {
      void this.attachEvents();
    }
  }

  private async attachEvents() {
    const unState = await listen<NativeAudioStateSnapshot>("audio://state", event => {
      const snap = event.payload;
      if (!snap) return;
      this._backendSrc = snap.src;
      if (!snap.src || snap.src !== this._src) return;

      const prevPaused = this._paused;
      const prevDuration = this._duration;

      if (snap.src !== undefined) {
        this._src = snap.src;
      }
      this._baseTime = Number.isFinite(snap.currentTime) ? snap.currentTime : 0;
      this._basePerfMs = performance.now();
      this._seeking = false;

      if (Number.isFinite(snap.duration) && snap.duration > 0) {
        this._duration = snap.duration;
        if (this._duration !== prevDuration) {
          this.emit("durationchange");
        }
      }

      this._volume = snap.volume;
      this._muted = snap.muted;
      this._rate = snap.rate;
      this._loop = snap.looping;

      const nextPaused = !snap.isPlaying;
      this._paused = nextPaused;
      if (prevPaused !== nextPaused) {
        if (nextPaused) {
          this.emit("pause");
        } else {
          this.emit("play");
          this.emit("playing");
        }
      }

      this.emit("timeupdate");
    });

    const unProgress = await listen<{ currentTime: number; duration: number }>("audio://progress", event => {
      if (!this._src || this._backendSrc !== this._src) return;
      const { currentTime, duration } = event.payload;
      if (!this._seeking && Number.isFinite(currentTime)) {
        this._baseTime = currentTime;
        this._basePerfMs = performance.now();
      }
      if (Number.isFinite(duration) && duration > 0 && duration !== this._duration) {
        this._duration = duration;
        this.emit("durationchange");
      }
      this.emit("timeupdate");
    });

    const unEnded = await listen<{ looped?: boolean }>("audio://ended", event => {
      if (event.payload?.looped) {
        this._baseTime = 0;
        this._basePerfMs = performance.now();
        this.emit("timeupdate");
        return;
      }
      this._paused = true;
      this.emit("ended");
    });

    const unError = await listen<{ code?: number; message?: string }>("audio://error", event => {
      this._error = {
        code: event.payload?.code ?? 2,
        message: event.payload?.message ?? "Audio playback failed",
      };
      this._paused = true;
      this.emit("error");
    });

    this._unlisteners.push(unState, unProgress, unEnded, unError);
  }

  async hydrateFromBackend(): Promise<NativeAudioStateSnapshot | null> {
    if (!isTauriRuntime()) return null;
    try {
      const snap = await invoke<NativeAudioStateSnapshot>("audio_get_state");
      this._hydrated = true;
      this._backendSrc = snap.src;
      if (snap.src) this._src = snap.src;
      this._paused = !snap.isPlaying;
      this._baseTime = snap.currentTime || 0;
      this._basePerfMs = performance.now();
      this._duration = snap.duration > 0 ? snap.duration : Number.NaN;
      this._volume = snap.volume;
      this._muted = snap.muted;
      this._rate = snap.rate || 1;
      this._loop = snap.looping;
      return snap;
    } catch {
      return null;
    }
  }

  get isHydrated() {
    return this._hydrated;
  }

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    const next = value || "";
    if (next === this._src && next !== "") return;
    this._src = next;
    this._duration = Number.NaN;
    this._error = null;
    this._loadSeq += 1;
    this._playSeq += 1;
    if (!next) {
      this._paused = true;
      this._baseTime = 0;
      void invoke("audio_stop").catch(() => undefined);
    }
  }

  get paused(): boolean {
    return this._paused;
  }

  get seeking(): boolean {
    return this._seeking;
  }

  get error(): MediaError | null {
    return this._error as unknown as MediaError | null;
  }

  get duration(): number {
    return this._duration;
  }

  get currentTime(): number {
    if (this._paused || this._seeking || !this._src) {
      return this._baseTime;
    }
    const elapsedSec = Math.max(0, (performance.now() - this._basePerfMs) / 1000) * this._rate;
    const estimated = this._baseTime + elapsedSec;
    if (Number.isFinite(this._duration) && this._duration > 0) {
      return Math.min(this._duration, estimated);
    }
    return estimated;
  }

  set currentTime(value: number) {
    const sec = Number.isFinite(value) ? Math.max(0, value) : 0;
    this._baseTime = sec;
    this._basePerfMs = performance.now();
    this._pendingSeek = sec;
    if (!this._src || this._src !== this._backendSrc) return;
    const loadSeq = this._loadSeq;
    this._seeking = true;
    void invoke("audio_seek", { positionSecs: sec })
      .then(() => {
        if (loadSeq !== this._loadSeq) return;
        this._seeking = false;
        this._pendingSeek = null;
        this.emit("seeked");
        this.emit("timeupdate");
      })
      .catch(() => {
        if (loadSeq === this._loadSeq) {
          this._seeking = false;
        }
      });
  }

  get volume(): number {
    return this._volume;
  }

  set volume(value: number) {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
    this._volume = clamped;
    void invoke("audio_set_volume", { volume: clamped }).catch(() => undefined);
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(value: boolean) {
    this._muted = Boolean(value);
    void invoke("audio_set_muted", { muted: this._muted }).catch(() => undefined);
  }

  get defaultPlaybackRate(): number {
    return this._defaultRate;
  }

  set defaultPlaybackRate(value: number) {
    this._defaultRate = value;
  }

  get playbackRate(): number {
    return this._rate;
  }

  set playbackRate(value: number) {
    const clamped = Math.max(0.5, Math.min(2.0, Number.isFinite(value) ? value : 1));
    this._baseTime = this.currentTime;
    this._basePerfMs = performance.now();
    this._rate = clamped;
    void invoke("audio_set_rate", { rate: clamped })
      .then(() => this.emit("ratechange"))
      .catch(() => undefined);
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(value: boolean) {
    this._loop = Boolean(value);
    void invoke("audio_set_loop", { looping: this._loop }).catch(() => undefined);
  }

  removeAttribute(name: string) {
    if (name === "src") {
      this._src = "";
      this._paused = true;
      this._baseTime = 0;
      this._duration = Number.NaN;
      this._error = null;
      this._loadSeq += 1;
      this._playSeq += 1;
      void invoke("audio_stop").catch(() => undefined);
    }
  }

  load() {
    this._error = null;
    if (!this._src) {
      this._baseTime = 0;
      this._duration = Number.NaN;
      this._paused = true;
    }
  }

  async play(): Promise<void> {
    if (!this._src) {
      throw new DOMException("No audio source", "NotSupportedError");
    }
    const loadSeq = this._loadSeq;
    const playSeq = ++this._playSeq;
    const seekSec = this._pendingSeek ?? (this._baseTime > 0 ? this._baseTime : 0);
    this._pendingSeek = null;
    try {
      const snap = await invoke<NativeAudioStateSnapshot>("audio_play", {
        src: this._src,
        startSecs: seekSec,
        volume: this._volume,
        muted: this._muted,
        rate: this._rate,
        looping: this._loop,
      });
      if (loadSeq !== this._loadSeq || playSeq !== this._playSeq) return;
      this._error = null;
      this._backendSrc = snap.src;
      const started = this._paused && snap.isPlaying;
      this._paused = !snap.isPlaying;
      this._baseTime = snap.currentTime;
      this._basePerfMs = performance.now();
      if (Number.isFinite(snap.duration) && snap.duration > 0) {
        this._duration = snap.duration;
        this.emit("durationchange");
      }
      if (started) {
        this.emit("play");
        this.emit("playing");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (loadSeq !== this._loadSeq || playSeq !== this._playSeq || msg.includes("play interrupted")) {
        throw new DOMException(msg, "AbortError");
      }
      this._error = { code: 4, message: msg };
      this._paused = true;
      this.emit("error");
      throw new DOMException(msg, "NotSupportedError");
    }
  }

  pause() {
    this._playSeq += 1;
    this._baseTime = this.currentTime;
    this._basePerfMs = performance.now();
    this._paused = true;
    void invoke("audio_pause").catch(() => undefined);
    this.emit("pause");
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    this._listeners.get(type)?.delete(listener);
  }

  private emit(name: AudioEventName) {
    switch (name) {
      case "durationchange":
        this.ondurationchange?.();
        break;
      case "timeupdate":
        this.ontimeupdate?.();
        break;
      case "seeked":
        this.onseeked?.();
        break;
      case "ratechange":
        this.onratechange?.();
        break;
      case "error":
      case "onerror":
        this.onerror?.(this._error);
        break;
      case "play":
        this.onplay?.();
        break;
      case "pause":
        this.onpause?.();
        break;
      case "ended":
        this.onended?.();
        break;
      default:
        break;
    }

    const listeners = this._listeners.get(name);
    if (!listeners?.size) return;
    const ev = new Event(name);
    for (const listener of listeners) {
      if (typeof listener === "function") listener(ev);
      else listener.handleEvent(ev);
    }
  }
}

export function syncNativeMetadata(meta: NativeTrackMetadata) {
  if (!isTauriRuntime()) return;
  void invoke("audio_set_metadata", { meta }).catch(() => undefined);
}

export function syncNativeQueue(snapshot: NativeQueueSnapshot) {
  if (!isTauriRuntime()) return;
  void invoke("audio_sync_queue", { snapshot }).catch(() => undefined);
}

export function setNativeFftEnabled(enabled: boolean) {
  if (!isTauriRuntime()) return;
  void invoke("audio_set_fft_enabled", { enabled }).catch(() => undefined);
}

export async function subscribeNativeFft(cb: (bars: number[]) => void): Promise<UnlistenFn> {
  return listen<number[]>("audio://fft", event => {
    if (Array.isArray(event.payload)) cb(event.payload);
  });
}
