import React from "react";

import { Avatar } from "@heroui/react";
import { RiAppsLine, RiSendInsLine } from "@remixicon/react";
import clsx from "classnames";

export interface AuthorItem {
  mid: number;
  face: string;
  name: string;
}

interface UserItemProps {
  author: AuthorItem | null;
  isSelected: boolean;
  onSelect: (mid: number | null) => void;
  horizontal?: boolean;
}

const UserItem: React.FC<UserItemProps> = ({ author, isSelected, onSelect, horizontal = false }) => {
  const displayName = author?.name || "全部";
  const displayFace = author?.face || "";
  const isAll = author === null;
  return (
    <div
      title={displayName}
      className={clsx(
        "group flex cursor-pointer transition-colors",
        horizontal
          ? "w-16 shrink-0 flex-col items-center justify-start gap-1 rounded-xl px-1.5 py-1.5"
          : "w-full flex-row items-center gap-3 px-2 py-2",
        isSelected ? (horizontal ? "bg-primary/10 text-primary font-medium" : "text-primary") : "text-default-500",
      )}
      onClick={() => onSelect(author?.mid ?? null)}
      role="button"
      aria-pressed={isSelected}
      data-selected={isSelected ? "true" : undefined}
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(author?.mid ?? null);
        }
      }}
    >
      <Avatar
        src={displayFace}
        name={displayName}
        isBordered={isSelected}
        radius="full"
        color={isSelected && (horizontal || !isAll) ? "primary" : "default"}
        className={clsx(
          "h-9 w-9 shrink-0 rounded-full transition-transform",
          horizontal ? "active:scale-95" : "hover:scale-105",
        )}
        classNames={{
          img: "rounded-full",
        }}
        fallback={
          isAll ? (
            <RiAppsLine
              size={18}
              className={clsx({
                "text-primary": isSelected,
              })}
            />
          ) : (
            <RiSendInsLine size={18} />
          )
        }
      />
      <span
        className={clsx(
          "group-hover:text-primary w-full truncate",
          horizontal ? "text-center text-xs leading-tight" : "text-sm",
        )}
      >
        {displayName}
      </span>
    </div>
  );
};

export default UserItem;
