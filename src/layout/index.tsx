import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Outlet, useLocation } from "react-router";

import { onBackButtonPress } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/shallow";

import log from "@/common/utils/logger";
import ConfirmModal from "@/components/confirm-modal";
import Fallback from "@/components/error-fallback";
import LoadOnOpen from "@/components/load-on-open";
import { migrateMobileLyricsPreference } from "@/components/lyrics/bilingual-preference";
import { useTrackLyrics } from "@/components/lyrics/use-track-lyrics";
import PlayBar from "@/layout/playbar";
import { useDesktopLyrics } from "@/store/desktop-lyrics";
import { useFullScreenPlayerSettings } from "@/store/full-screen-player-settings";
import { useModalStore } from "@/store/modal";
import { usePlayList } from "@/store/play-list";
import { useUser } from "@/store/user";

import Navbar from "./navbar";
import SideNav from "./side";

import "./android.css";

const FavoritesSelectModal = lazy(() => import("@/components/favorites-select-modal"));
const FullScreenPlayer = lazy(() => import("@/components/full-screen-player"));
const PlayListDrawer = lazy(() => import("@/components/music-playlist-drawer"));
const PlaybackLinesPanel = lazy(() => import("@/components/playback-lines-button/panel"));
const ReleaseNoteModal = lazy(() => import("@/components/release-note-modal"));
const VideoPagesDownloadSelectModal = lazy(() => import("@/components/video-pages-download-select-modal"));

const android = window.electron.getPlatform() === "android";
function PlayerOverlays() {
  const [favorites, downloads, release, playlist, fullScreen, playbackLines] = useModalStore(
    useShallow(state => [
      state.isFavSelectModalOpen,
      state.isVideoPageDownloadModalOpen,
      state.isReleaseNoteModalOpen,
      state.isPlayListDrawerOpen,
      state.isFullScreenPlayerOpen,
      state.isPlaybackLinesOpen,
    ]),
  );
  const showFullScreenLyrics = useFullScreenPlayerSettings(s => s.showLyrics);
  const track = usePlayList(s => s.getPlayItem());
  const lyrics = useTrackLyrics(track, fullScreen && showFullScreenLyrics);
  useEffect(() => {
    if (!android) return window.electron.onDesktopLyricsState(useDesktopLyrics.setState);
    void migrateMobileLyricsPreference().catch(error => log.warn("[lyrics] 读取双语歌词设置失败", error));
  }, []);

  return (
    <>
      <LoadOnOpen isOpen={favorites}>
        <FavoritesSelectModal />
      </LoadOnOpen>
      <ConfirmModal />
      <LoadOnOpen isOpen={downloads}>
        <VideoPagesDownloadSelectModal />
      </LoadOnOpen>
      <LoadOnOpen isOpen={release}>
        <ReleaseNoteModal />
      </LoadOnOpen>
      <LoadOnOpen isOpen={playlist}>
        <PlayListDrawer />
      </LoadOnOpen>
      <LoadOnOpen isOpen={fullScreen}>
        <FullScreenPlayer lyrics={lyrics} />
      </LoadOnOpen>
      {playbackLines && (
        <Suspense fallback={null}>
          <PlaybackLinesPanel />
        </Suspense>
      )}
    </>
  );
}

const Layout = () => {
  const updateUser = useUser(state => state.updateUser);
  const location = useLocation();
  useEffect(() => {
    if (!android) return;
    const sub = onBackButtonPress(() => {
      const top = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"]'))
        .filter(el => el.getClientRects().length)
        .at(-1);
      if (top && !top.classList.contains("full-player")) {
        (document.activeElement ?? top).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
        );
      } else if (useModalStore.getState().isFullScreenPlayerOpen) useModalStore.getState().closeFullScreenPlayer();
      else if (window.history.state?.idx > 0) window.history.back();
      else void invoke("android_background");
    });
    return () => {
      void sub.then(listener => listener.unregister());
    };
  }, []);

  useEffect(() => {
    void updateUser().catch(error => {
      log.warn("[user] 刷新登录状态失败", error instanceof Error ? error.message : String(error));
    });
  }, [updateUser]);

  return (
    <ErrorBoundary
      FallbackComponent={Fallback}
      resetKeys={[location.pathname]}
      onError={(error, info) => {
        log.error("[ErrorBoundary]", error, info);
      }}
    >
      <div className="flex h-full flex-col">
        <div className="main-workspace flex min-h-0 w-full flex-1">
          <SideNav />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="h-16 flex-none">
              <Navbar />
            </div>
            <div className="page-content min-h-0 flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <Outlet />
              </Suspense>
            </div>
          </div>
        </div>
        <div className="main-playbar relative z-50 h-[88px] w-full flex-none shadow-2xl">
          <PlayBar />
        </div>
      </div>
      <PlayerOverlays />
    </ErrorBoundary>
  );
};

export default Layout;
