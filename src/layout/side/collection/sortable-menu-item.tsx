import { useMemo, useRef, type CSSProperties, type MouseEvent } from "react";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { detectPlatform } from "@/bridge/env";
import ContextMenu, { type ContextMenuItem } from "@/components/context-menu";
import MenuItem, { type MenuItemProps } from "@/components/menu/menu-item";

interface Props extends MenuItemProps {
  id: number | string;
  disabled?: boolean;
  contextMenuItems?: ContextMenuItem[];
  onContextMenuAction?: (key: string) => void;
}

const SortableMenuItem = ({ id, disabled, contextMenuItems, onContextMenuAction, ...itemProps }: Props) => {
  const android = (window.electron?.getPlatform?.() ?? detectPlatform()) === "android";
  const draggedByTouch = useRef(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  const dragProps = useMemo(() => {
    if (disabled) {
      return {};
    }

    return {
      ...attributes,
      ...listeners,
      ...(android && isDragging ? { "data-no-contextmenu": "true" } : {}),
    };
  }, [attributes, listeners, disabled, isDragging, android]);

  const style = useMemo(() => {
    return {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.7 : 1,
      cursor: disabled ? undefined : "grab",
      touchAction: disabled ? undefined : android ? "pan-y" : "none",
      display: "flex",
      alignItems: "center",
    } as CSSProperties;
  }, [transform, transition, isDragging, disabled, android]);

  const itemContent = <MenuItem {...itemProps} dndProps={dragProps} />;

  const resetDragClick = () => {
    draggedByTouch.current = false;
  };
  const rememberTouchDrag = () => {
    draggedByTouch.current = isDragging;
  };
  const preventDragNavigation = (event: MouseEvent<HTMLDivElement>) => {
    // HeroUI can synthesize a click after the drag has ended and the link has moved.
    if (draggedByTouch.current) {
      resetDragClick();
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onPointerDownCapture={android ? resetDragClick : undefined}
      onKeyDownCapture={android ? resetDragClick : undefined}
      onTouchEndCapture={android ? rememberTouchDrag : undefined}
      onClickCapture={android ? preventDragNavigation : undefined}
    >
      {contextMenuItems?.length ? (
        <ContextMenu
          className="flex h-full w-full items-center"
          items={contextMenuItems}
          onAction={onContextMenuAction}
        >
          {itemContent}
        </ContextMenu>
      ) : (
        itemContent
      )}
    </div>
  );
};

export default SortableMenuItem;
