import type { KeyboardEvent, MouseEvent } from "react";

import { detectPlatform } from "@/bridge/env";

const tapInterval = 420;
const tapRadius = 26;
let firstTap: { row: Element; at: number; x: number; y: number } | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;

function forgetTap() {
  clearTimeout(expiry);
  expiry = undefined;
  firstTap = undefined;
}

function isRowContent(row: Element, target: EventTarget) {
  if (!(target instanceof Element) || !row.contains(target)) return false;
  const control = target.closest(
    'button, a, input, select, textarea, [role="button"], [role="checkbox"], [role="menuitem"]',
  );
  return !control || control === row || !row.contains(control);
}

/** Android WebView delivers a click for each completed tap, even across different children of a row. */
export function trackPressProps(
  play?: () => void,
  desktop: "click" | "doubleClick" | "press" | "none" = "doubleClick",
) {
  if (!play) return {};
  if (detectPlatform() !== "android") {
    if (desktop === "click") return { onClick: play };
    if (desktop === "press") return { onPress: play };
    return desktop === "doubleClick" ? { onDoubleClick: play } : {};
  }
  return {
    "data-track-tap": true,
    tabIndex: 0,
    role: "button" as const,
    onPointerCancel: forgetTap,
    onContextMenu: forgetTap,
    onClick(event: MouseEvent<Element>) {
      const { currentTarget: row, target, clientX: x, clientY: y, timeStamp: at } = event;
      const previous = firstTap;
      forgetTap();
      if (event.button !== 0 || event.detail === 0 || !isRowContent(row, target)) return;
      if (
        previous?.row === row &&
        at - previous.at <= tapInterval &&
        Math.hypot(x - previous.x, y - previous.y) <= tapRadius
      ) {
        play();
        return;
      }
      firstTap = { row, at, x, y };
      expiry = setTimeout(forgetTap, tapInterval);
    },
    onKeyDownCapture(event: KeyboardEvent<Element>) {
      if (event.target !== event.currentTarget || event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      forgetTap();
      play();
    },
  };
}
