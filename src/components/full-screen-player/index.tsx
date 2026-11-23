import { lazy, startTransition, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import { Drawer, DrawerBody, DrawerContent, Image, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { RiArrowDownSLine, RiArrowLeftSLine, RiSettings3Line } from "@remixicon/react";
import { useClickAway } from "ahooks";
import clsx from "classnames";
import { readableColor } from "color2k";
import { useReducedMotion } from "framer-motion";
import { useShallow } from "zustand/shallow";

import type { TrackLyrics } from "@/components/lyrics/use-track-lyrics";

import { resolveMediaUrl } from "@/bridge/media-url";
import { resolvePrimaryColor, Themes } from "@/common/constants/theme";
import { hexToHsl, isHex } from "@/common/utils/color";
import AudioWaveform from "@/components/audio-waveform";
import DesktopLyricsButton from "@/components/desktop-lyrics-button";
import Lyrics from "@/components/lyrics";
import PlaybackLinesButton from "@/components/playback-lines-button";
import { useTheme } from "@/components/theme/use-theme";
import { useFullScreenPlayerSettings } from "@/store/full-screen-player-settings";
import { useModalStore } from "@/store/modal";
import { usePlayList } from "@/store/play-list";
import { useSettings } from "@/store/settings";

import Empty from "../empty";
import IconButton from "../icon-button";
import LoadOnOpen from "../load-on-open";
import MusicPlayControl from "../music-play-control";
import MusicPlayMode from "../music-play-mode";
import MusicPlayProgress from "../music-play-progress";
import MusicVolume from "../music-volume";
import OpenPlaylistDrawerButton from "../open-playlist-drawer-button";
import WindowAction from "../window-action";
import GlassBackground from "./background";
import { useGlassmorphism } from "./glassmorphism";
import FullScreenPlayerSettingsPanel from "./settings-panel";

const PageList = lazy(() => import("./page-list"));
const platform = window.electron.getPlatform();

// A single transform can run in the compositor without updating y in JavaScript each frame.
const drawerVariants: NonNullable<ComponentProps<typeof Drawer>["motionProps"]>["variants"] = {
  enter: {
    transform: "translateY(0%)",
    transition: { duration: 0.2, ease: [0, 0, 0.2, 1] },
  },
  exit: {
    transform: "translateY(100%)",
    transition: { duration: 0.1, ease: [0.4, 0, 1, 1] },
  },
};

const FullScreenPlayer = ({ lyrics }: { lyrics: TrackLyrics }) => {
  const isOpen = useModalStore(s => s.isFullScreenPlayerOpen);
  const close = useModalStore(s => s.closeFullScreenPlayer);
  const playItem = usePlayList(state => state.getPlayItem());
  const primaryPreference = useSettings(s => s.primaryColor);
  const { theme: appTheme } = useTheme();
  const { showLyrics, showSpectrum, showCover, showBlurredBackground, backgroundColor, spectrumColor, lyricsColor } =
    useFullScreenPlayerSettings(
      useShallow(s => ({
        showLyrics: s.showLyrics,
        showSpectrum: s.showSpectrum,
        showCover: s.showCover,
        showBlurredBackground: s.showBlurredBackground,
        backgroundColor: s.backgroundColor,
        spectrumColor: s.spectrumColor,
        lyricsColor: s.lyricsColor,
      })),
    );
  const isLocal = playItem?.source === "local";

  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1000);
  const [windowHeight, setWindowHeight] = useState(typeof window !== "undefined" ? window.innerHeight : 800);
  const [isPageListOpen, setIsPageListOpen] = useState(false);
  const [isUiVisible, setIsUiVisible] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDesktopLyricsMenuOpen, setIsDesktopLyricsMenuOpen] = useState(false);
  const [firstOpenFinished, setFirstOpenFinished] = useState(false);
  const [playerContent, setPlayerContent] = useState<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(80);

  const pageListRef = useRef<HTMLDivElement>(null);
  const hideUiTimeoutRef = useRef<number | null>(null);

  useClickAway(() => {
    if (isPageListOpen) {
      setIsPageListOpen(false);
    }
  }, pageListRef);

  useEffect(() => {
    if (!isOpen) return;

    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    // Initial check
    handleResize();

    return () => window.removeEventListener("resize", handleResize);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setIsUiVisible(true);
    setIsDesktopLyricsMenuOpen(false);
    return () => {
      if (hideUiTimeoutRef.current !== null) {
        window.clearTimeout(hideUiTimeoutRef.current);
        hideUiTimeoutRef.current = null;
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isUiVisible && isSettingsOpen) {
      setIsSettingsOpen(false);
    }
  }, [isUiVisible, isSettingsOpen]);

  const handleMouseEnter = () => {
    if (hideUiTimeoutRef.current) {
      window.clearTimeout(hideUiTimeoutRef.current);
      hideUiTimeoutRef.current = null;
    }
    if (!isUiVisible) {
      setIsUiVisible(true);
    }
  };

  const scheduleHideUi = (delay: number) => {
    if (platform === "android" || isSettingsOpen || isDesktopLyricsMenuOpen) return;
    if (hideUiTimeoutRef.current) {
      window.clearTimeout(hideUiTimeoutRef.current);
    }
    hideUiTimeoutRef.current = window.setTimeout(() => {
      setIsUiVisible(false);
    }, delay);
  };

  const handleMouseLeave = () => {
    scheduleHideUi(3000);
  };

  const reduceMotion = !!useReducedMotion();
  const showMedia = firstOpenFinished || reduceMotion;
  const coverSrc = resolveMediaUrl(playItem?.pageCover || playItem?.cover);
  const primaryColor = resolvePrimaryColor(showBlurredBackground ? "dark" : appTheme, primaryPreference);
  const { covers, fallback, transitionMs, glow } = useGlassmorphism(
    coverSrc,
    primaryColor,
    isOpen && showMedia && showBlurredBackground,
  );

  useEffect(() => {
    const controls = controlsRef.current;
    if (!isOpen || !showMedia || !showSpectrum || !controls) return;
    const observer = new ResizeObserver(() => setControlsHeight(controls.offsetHeight || 80));
    observer.observe(controls);
    return () => observer.disconnect();
  }, [isOpen, showMedia, showSpectrum]);

  const computedForegroundHex = useMemo(() => {
    if (showBlurredBackground) return undefined;
    const baseBg = backgroundColor && isHex(backgroundColor) ? backgroundColor : Themes[appTheme].colors.background;
    try {
      return readableColor(baseBg as string);
    } catch {
      return undefined;
    }
  }, [backgroundColor, appTheme, showBlurredBackground]);

  const themeVars = useMemo(() => {
    const vars: React.CSSProperties = {
      ["--glow-rgb" as any]: `${glow.r} ${glow.g} ${glow.b}`,
      ["--heroui-primary" as any]: hexToHsl(primaryColor),
      ["--heroui-primary-foreground" as any]: hexToHsl(readableColor(primaryColor)),
      ["--heroui-focus" as any]: hexToHsl(primaryColor),
    };
    if (computedForegroundHex) {
      vars["--heroui-foreground" as any] = hexToHsl(computedForegroundHex);
    }
    return vars;
  }, [glow, primaryColor, computedForegroundHex]);

  if (!playItem) return null;

  const coverWidth = Math.max(260, Math.min(windowWidth * 0.7, windowHeight * 0.48, 520));
  const coverHeight = coverWidth * 0.75;
  const waveformWidth = Math.min(640, Math.max(400, Math.round(windowWidth * 0.5)));
  const waveformBarCount = Math.max(48, Math.min(128, Math.round(waveformWidth / 7.5)));
  const toolClass = "bg-foreground/20 text-foreground hover:bg-foreground/30 pointer-events-auto min-w-0 rounded-full";
  const lyricTools = (
    <>
      <PlaybackLinesButton className={toolClass} />
      {platform !== "android" && (
        <DesktopLyricsButton
          className={toolClass}
          onOpenChange={open => {
            setIsDesktopLyricsMenuOpen(open);
            if (open) handleMouseEnter();
          }}
        />
      )}
    </>
  );

  return (
    <Drawer
      isOpen={isOpen}
      onClose={close}
      placement="bottom"
      size="full"
      radius="none"
      isDismissable={false}
      hideCloseButton
      disableAnimation={reduceMotion}
      motionProps={{
        variants: drawerVariants,
        onAnimationComplete: animation => {
          // The first slide only moves the shell. Keep media drawing out of that animation.
          if (!showMedia && animation === "enter" && useModalStore.getState().isFullScreenPlayerOpen) {
            startTransition(() => setFirstOpenFinished(true));
          }
        },
      }}
    >
      <DrawerContent
        className={clsx("full-player bg-background text-foreground relative h-full overflow-hidden", {
          dark: showBlurredBackground || appTheme === "dark",
          light: !showBlurredBackground && appTheme === "light",
        })}
        style={{
          ...themeVars,
          cursor: isUiVisible ? "auto" : "none",
        }}
      >
        {onClose =>
          !isOpen ? (
            <Empty />
          ) : (
            <DrawerBody
              className="group/player relative flex flex-row gap-0 overflow-hidden bg-transparent p-0"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onMouseMove={() => {
                if (!isUiVisible) {
                  setIsUiVisible(true);
                }
                scheduleHideUi(3000);
              }}
            >
              {!showBlurredBackground && (
                <div aria-hidden className="absolute inset-0 -z-10" style={{ backgroundColor: backgroundColor }} />
              )}
              {showBlurredBackground && <GlassBackground {...covers} fallback={fallback} transitionMs={transitionMs} />}
              <div
                className={`absolute top-0 right-0 z-20 flex w-full justify-between px-6 py-4 transition-opacity duration-200 ${isUiVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
              >
                <div className="window-no-drag top-0 right-0 left-0 flex w-full max-w-2/5 items-center space-x-2">
                  <IconButton title="关闭弹窗" onPress={onClose} className="">
                    <RiArrowDownSLine size={28} />
                  </IconButton>
                  <h2 className="truncate text-xl select-none">{playItem.pageTitle || playItem.title}</h2>
                  <Popover
                    data-full-player-settings-overlay
                    isOpen={isSettingsOpen && isUiVisible}
                    onOpenChange={open => {
                      setIsSettingsOpen(open);
                      if (open) {
                        if (hideUiTimeoutRef.current) {
                          window.clearTimeout(hideUiTimeoutRef.current);
                          hideUiTimeoutRef.current = null;
                        }
                        setIsUiVisible(true);
                      }
                    }}
                    placement="bottom-start"
                  >
                    <PopoverTrigger>
                      <IconButton title="设置" tooltip="设置">
                        <RiSettings3Line size={22} />
                      </IconButton>
                    </PopoverTrigger>
                    <PopoverContent className="full-player-settings-popover p-4">
                      <FullScreenPlayerSettingsPanel isUiVisible={isUiVisible} />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="window-no-drag top-0 right-0">
                  {platform === "linux" || platform === "windows" ? <WindowAction /> : null}
                </div>
              </div>

              <div ref={setPlayerContent} className="player-content flex h-full w-full items-center justify-center">
                {showMedia && !isLocal && showCover && (
                  <div
                    className={clsx(
                      "player-cover flex h-full w-full items-center px-12",
                      showLyrics ? "justify-end" : "justify-center",
                    )}
                  >
                    <Image
                      src={coverSrc}
                      referrerPolicy="no-referrer"
                      radius="lg"
                      className="transition-shadow ease-out"
                      classNames={{
                        wrapper: "pointer-events-none",
                        img: "w-full h-full object-cover select-none pointer-events-none",
                      }}
                      style={{
                        width: coverWidth,
                        height: coverHeight,
                        boxShadow: `0 28px 90px -35px rgb(var(--glow-rgb) / 0.55), 0 10px 32px -18px rgb(0 0 0 / 0.55)`,
                        transition: `box-shadow ${transitionMs}ms ease`,
                        aspectRatio: "4 / 3",
                      }}
                    />
                  </div>
                )}

                {showLyrics && (
                  <div
                    className={clsx(
                      "player-lyrics h-full w-full overflow-hidden px-12 py-24",
                      !showCover || isLocal ? "flex items-center justify-center" : "",
                    )}
                  >
                    <Lyrics
                      key={playItem.id}
                      item={playItem}
                      lyrics={lyrics}
                      color={lyricsColor}
                      centered={!showCover || isLocal}
                      showControls={isUiVisible}
                      deferRendering={!showMedia}
                      extraControls={lyricTools}
                    />
                  </div>
                )}
                {!showLyrics && showMedia && isUiVisible && (
                  <div className="absolute right-18 bottom-30 flex flex-col items-center gap-3">{lyricTools}</div>
                )}
              </div>

              {showMedia && showSpectrum && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-30 flex w-full justify-center"
                  style={{
                    bottom: isUiVisible ? controlsHeight + 12 : 24,
                    transition: "bottom 300ms ease",
                  }}
                >
                  <div className="mx-auto flex w-full max-w-6xl justify-center px-12">
                    <AudioWaveform
                      width={waveformWidth}
                      height={40}
                      barCount={waveformBarCount}
                      barColor={spectrumColor || "currentColor"}
                    />
                  </div>
                </div>
              )}

              <div
                ref={controlsRef}
                className={clsx(
                  "absolute inset-x-0 bottom-0 z-40 transform transition-transform duration-300 ease-out",
                  isUiVisible
                    ? "pointer-events-auto translate-y-0 opacity-100"
                    : "pointer-events-none translate-y-full opacity-0",
                )}
              >
                <div className="mx-auto mb-4 flex w-full max-w-6xl flex-col items-center gap-2 px-12">
                  <MusicPlayProgress className="w-full" trackClassName="h-[6px]" />
                  <div className="flex w-full items-center justify-center space-x-4">
                    <MusicPlayMode />
                    <MusicPlayControl />
                    <div className="relative flex">
                      <OpenPlaylistDrawerButton />
                      {isUiVisible && playerContent && (
                        <div className="absolute inset-y-0 left-full ml-4 flex items-center">
                          <MusicVolume portalContainer={playerContent} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {isUiVisible && playItem.hasMultiPart && !isPageListOpen && (
                <div className="absolute top-1/2 right-0 z-20 -translate-y-1/2">
                  <IconButton
                    className="h-24 w-6 min-w-0 rounded-l-xl rounded-r-none bg-white/10 px-0 backdrop-blur-md transition-colors hover:bg-white/20"
                    onPress={() => setIsPageListOpen(!isPageListOpen)}
                    tooltip="显示分集列表"
                    tooltipProps={{
                      placement: "left",
                    }}
                  >
                    <RiArrowLeftSLine size={24} className="text-white/80" />
                  </IconButton>
                </div>
              )}

              {playItem.hasMultiPart && (
                <LoadOnOpen isOpen={isPageListOpen}>
                  <PageList
                    ref={pageListRef}
                    isOpen={isPageListOpen}
                    className={`absolute top-1/2 right-0 z-30 -translate-y-1/2 rounded-r-none transition-all duration-300 ease-out ${
                      isPageListOpen
                        ? "translate-x-0 opacity-100 starting:translate-x-full starting:opacity-0"
                        : "pointer-events-none translate-x-full opacity-0"
                    }`}
                    style={{
                      width: 280,
                      height: "min(60vh, 420px)",
                    }}
                    onClose={() => setIsPageListOpen(false)}
                  />
                </LoadOnOpen>
              )}
            </DrawerBody>
          )
        }
      </DrawerContent>
    </Drawer>
  );
};

export default FullScreenPlayer;
