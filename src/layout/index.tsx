import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Outlet, useLocation } from "react-router";

import log from "electron-log/renderer";
import { useShallow } from "zustand/shallow";

import ConfirmModal from "@/components/confirm-modal";
import Fallback from "@/components/error-fallback";
import FullScreenPlayer from "@/components/full-screen-player";
import LoadOnOpen from "@/components/load-on-open";
import PlayBar from "@/layout/playbar";
import { useModalStore } from "@/store/modal";
import { useUser } from "@/store/user";

import Navbar from "./navbar";
import SideNav from "./side";

const FavoritesSelectModal = lazy(() => import("@/components/favorites-select-modal"));
const PlayListDrawer = lazy(() => import("@/components/music-playlist-drawer"));
const ReleaseNoteModal = lazy(() => import("@/components/release-note-modal"));
const VideoPagesDownloadSelectModal = lazy(() => import("@/components/video-pages-download-select-modal"));

function PlayerOverlays() {
  const [favorites, downloads, release, playlist, fullScreen] = useModalStore(
    useShallow(state => [
      state.isFavSelectModalOpen,
      state.isVideoPageDownloadModalOpen,
      state.isReleaseNoteModalOpen,
      state.isPlayListDrawerOpen,
      state.isFullScreenPlayerOpen,
    ]),
  );
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
        <FullScreenPlayer />
      </LoadOnOpen>
    </>
  );
}

const Layout = () => {
  const updateUser = useUser(state => state.updateUser);
  const location = useLocation();

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
        <div className="flex min-h-0 w-full flex-1">
          <SideNav />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="h-16 flex-none">
              <Navbar />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <Outlet />
              </Suspense>
            </div>
          </div>
        </div>
        <div className="relative z-50 h-[88px] w-full flex-none shadow-2xl">
          <PlayBar />
        </div>
      </div>
      <PlayerOverlays />
    </ErrorBoundary>
  );
};

export default Layout;
