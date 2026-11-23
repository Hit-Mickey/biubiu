import { useEffect, useState } from "react";

import { twMerge } from "tailwind-merge";

import logoIcon from "@/assets/icons/logo.png";
import { appName } from "@shared/app";

const isMac = window.electron?.getPlatform() === "macos";

interface LogoProps {
  isCollapsed: boolean;
}

const Logo = ({ isCollapsed }: LogoProps) => {
  const [isFullScreen, setIsFullScreen] = useState(false);

  useEffect(() => {
    if (!isMac) return;

    window.electron?.isFullScreen().then(setIsFullScreen);
    const unlisten = window.electron?.onWindowFullScreenChange(setIsFullScreen);

    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <>
      <div
        className={twMerge(
          "sidebar-logo window-drag text-primary relative flex flex-none items-center py-3 pr-3 pl-4",
          isMac && !isFullScreen && "pt-8",
        )}
      >
        <div className="window-no-drag flex flex-1 items-center space-x-2">
          <img
            src={logoIcon}
            alt={isCollapsed ? appName : ""}
            width={40}
            height={40}
            draggable={false}
            className="h-10 w-10 shrink-0 object-contain select-none"
          />
          {!isCollapsed && <span className="text-2xl leading-none font-bold">{appName}</span>}
        </div>
      </div>
    </>
  );
};

export default Logo;
