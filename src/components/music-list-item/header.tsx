import clx from "classnames";

import { useSettings } from "@/store/settings";

import { getMusicListItemGrid } from "./styles";

interface Props {
  className?: string;
  hidePubTime?: boolean;
  timeTitle?: string;
}

const MusicListHeader = ({ className, hidePubTime, timeTitle }: Props) => {
  const displayMode = useSettings(state => state.displayMode);
  const isCompact = displayMode === "compact";

  const gridCols = getMusicListItemGrid(isCompact, hidePubTime);

  return (
    <div
      className={clx(
        "text-default-500 border-divider mb-2 grid w-full items-center gap-4 border-b text-sm",
        isCompact ? "h-8" : "h-10 px-2",
        "bili-track",
        gridCols,
        className,
      )}
    >
      <div className="track-index min-w-8 text-center">#</div>
      <div className="track-info text-left">标题</div>
      {isCompact && <div className="track-author text-left">UP</div>}
      <div className="track-views text-right">播放量</div>
      {!hidePubTime && <div className="track-date text-right">{timeTitle || "投稿时间"}</div>}
      <div className="track-duration text-right">时长</div>
      <div className="track-menu w-8" />
    </div>
  );
};

export default MusicListHeader;
