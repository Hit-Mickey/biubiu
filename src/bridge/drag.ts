import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauriRuntime } from "./env";

const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "[role='button']",
  "[role='slider']",
  "[role='textbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[data-slot='thumb']",
  "[contenteditable='true']",
  ".window-no-drag",
].join(",");

let installed = false;

export function installWindowDragHandler(options?: { allowMaximizeDoubleClick?: boolean; dragSelector?: string }) {
  if (installed || !isTauriRuntime() || typeof document === "undefined") return;
  installed = true;

  const dragSelector = options?.dragSelector ?? ".window-drag";
  const allowDoubleClick = options?.allowMaximizeDoubleClick ?? true;

  document.addEventListener(
    "mousedown",
    event => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest(dragSelector)) return;
      if (target.closest(INTERACTIVE_SELECTOR)) return;
      if (target.closest("#root[data-locked]")) return;

      if (event.detail === 2 && allowDoubleClick) {
        event.preventDefault();
        window.electron?.toggleMaximizeWindow?.();
        return;
      }

      if (event.detail === 1) {
        void getCurrentWindow()
          .startDragging()
          .catch(() => undefined);
      }
    },
    { passive: false },
  );
}
