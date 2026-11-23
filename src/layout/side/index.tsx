import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { Button, useDisclosure } from "@heroui/react";
import { RiArrowLeftDoubleLine, RiArrowRightDoubleLine, RiMenuFoldLine, RiMenuUnfoldLine } from "@remixicon/react";
import clx from "classnames";

import { detectPlatform } from "@/bridge/env";
import LoadOnOpen from "@/components/load-on-open";
import ScrollContainer from "@/components/scroll-container";
import { useSettings } from "@/store/settings";
import { useUser } from "@/store/user";

import DefaultMenus from "./default-menu";
import Logo from "./logo";

const Collection = lazy(() => import("./collection"));
const FavoritesEditModal = lazy(() => import("@/components/favorites-edit-modal"));

const COLLAPSED_WIDTH = 72;
const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

const SideNav = () => {
  const android = (window.electron?.getPlatform?.() ?? detectPlatform()) === "android";
  const isLoggedIn = useUser(state => Boolean(state.user?.isLogin));
  const sideMenuCollapsed = useSettings(state => state.sideMenuCollapsed);
  const sideMenuWidth = useSettings(state => state.sideMenuWidth);
  const updateSettings = useSettings(state => state.update);

  const {
    isOpen: isFavoritesEditModalOpen,
    onOpen: onOpenFavoritesEditModal,
    onOpenChange: onOpenChangeFavoritesEditModal,
  } = useDisclosure();
  const [editingFavoriteId, setEditingFavoriteId] = useState<number>();

  const handleOpenAddFavorite = () => {
    setEditingFavoriteId(undefined);
    onOpenFavoritesEditModal();
  };

  const handleOpenEditFavorite = (id: number) => {
    setEditingFavoriteId(id);
    onOpenFavoritesEditModal();
  };

  const handleFavoritesEditModalChange = (isOpen: boolean) => {
    if (!isOpen) {
      setEditingFavoriteId(undefined);
    }

    onOpenChangeFavoritesEditModal();
  };

  const sidebarWidth = (() => {
    if (sideMenuCollapsed) return COLLAPSED_WIDTH;
    const width = sideMenuWidth ?? 200;
    if (width < MIN_WIDTH) return MIN_WIDTH;
    if (width > MAX_WIDTH) return MAX_WIDTH;
    return width;
  })();

  const [renderWidth, setRenderWidth] = useState(sidebarWidth);
  const [isDragging, setIsDragging] = useState(false);
  const isCollapsedVisual = isDragging ? renderWidth < MIN_WIDTH : sideMenuCollapsed;

  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);
  const prevUserSelectRef = useRef<string | null>(null);

  useEffect(() => {
    startWidthRef.current = sidebarWidth;
    if (!isDragging) {
      setRenderWidth(sidebarWidth);
    }
  }, [isDragging, sidebarWidth]);

  const onToggleCollapsed = () => {
    updateSettings({ sideMenuCollapsed: !sideMenuCollapsed });
  };

  const onStartResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    startXRef.current = event.clientX;
    startWidthRef.current = sidebarWidth;
    prevUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
  };

  const computeWidth = (delta: number) => {
    const rawWidth = Math.max(COLLAPSED_WIDTH, startWidthRef.current + delta);
    const cappedWidth = Math.min(rawWidth, MAX_WIDTH);
    const willCollapse = cappedWidth < MIN_WIDTH;
    const widthForView = willCollapse ? COLLAPSED_WIDTH : Math.max(MIN_WIDTH, cappedWidth);
    const widthToPersist = Math.max(MIN_WIDTH, cappedWidth);

    return { willCollapse, widthForView, widthToPersist };
  };

  useEffect(() => {
    // re-clamp render width if max width shrinks while not dragging
    if (!isDragging) {
      setRenderWidth(prev => Math.min(Math.max(prev, COLLAPSED_WIDTH), MAX_WIDTH));
    }
  }, [isDragging]);

  useEffect(() => {
    if (android) return;
    const onMouseMove = (event: MouseEvent) => {
      if (!isDraggingRef.current) return;

      const delta = event.clientX - startXRef.current;
      const { widthForView } = computeWidth(delta);

      setRenderWidth(widthForView);
    };

    const onMouseUp = (event: MouseEvent) => {
      if (!isDraggingRef.current) return;

      isDraggingRef.current = false;
      setIsDragging(false);
      if (prevUserSelectRef.current !== null) {
        document.body.style.userSelect = prevUserSelectRef.current;
      }

      const delta = event.clientX - startXRef.current;
      const { willCollapse, widthForView, widthToPersist } = computeWidth(delta);

      setRenderWidth(widthForView);
      updateSettings({ sideMenuCollapsed: willCollapse, sideMenuWidth: widthToPersist });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (isDraggingRef.current && prevUserSelectRef.current !== null) {
        document.body.style.userSelect = prevUserSelectRef.current;
      }
    };
  }, [android, updateSettings]);

  const ToggleIcon = android
    ? isCollapsedVisual
      ? RiMenuUnfoldLine
      : RiMenuFoldLine
    : isCollapsedVisual
      ? RiArrowRightDoubleLine
      : RiArrowLeftDoubleLine;
  const toggleButton = (
    <Button
      size="sm"
      isIconOnly
      fullWidth={!android}
      variant={android ? "light" : "solid"}
      radius={android ? "md" : "none"}
      aria-label={isCollapsedVisual ? "展开侧栏文字" : "收起侧栏文字"}
      aria-expanded={!isCollapsedVisual}
      aria-controls="sidebar-navigation"
      onPress={onToggleCollapsed}
      className={
        android
          ? "sidebar-toggle h-11 w-11 flex-none self-start"
          : "bg-background border-divider/30 h-auto w-full flex-none border-y py-1"
      }
    >
      <ToggleIcon size={android ? 22 : 16} />
    </Button>
  );

  return (
    <>
      <div
        className={clx("border-divider/30 relative flex h-full flex-none flex-col border-r-1", {
          "transition-[width] duration-200": !isDragging,
          "transition-none": isDragging,
        })}
        id="main-sidebar"
        data-collapsed={isCollapsedVisual}
        style={android ? undefined : { width: renderWidth }}
      >
        {android && toggleButton}
        <Logo isCollapsed={isCollapsedVisual} />
        <ScrollContainer
          id="sidebar-navigation"
          className={clx("min-h-0 flex-1 pb-2", {
            "px-4": !isCollapsedVisual,
            "overflow-hidden": isDragging,
          })}
        >
          <DefaultMenus isCollapsed={isCollapsedVisual} onOpenAddFavorite={handleOpenAddFavorite} />
          {isLoggedIn && (
            <Suspense fallback={null}>
              <Collection
                isCollapsed={isCollapsedVisual}
                onOpenAddFavorite={handleOpenAddFavorite}
                onOpenEditFavorite={handleOpenEditFavorite}
              />
            </Suspense>
          )}
        </ScrollContainer>
        {!android && toggleButton}
        {!android && (
          <div
            className="hover:bg-foreground/10 absolute top-0 right-0 h-full w-2 cursor-col-resize bg-transparent"
            onMouseDown={onStartResize}
          />
        )}
      </div>
      <LoadOnOpen isOpen={isFavoritesEditModalOpen}>
        <FavoritesEditModal
          mid={editingFavoriteId}
          isOpen={isFavoritesEditModalOpen}
          onOpenChange={handleFavoritesEditModalChange}
        />
      </LoadOnOpen>
    </>
  );
};

export default SideNav;
