import { RiDeleteBinLine, RiExternalLinkLine, RiFileMusicLine, RiFileVideoLine, RiStarLine } from "@remixicon/react";

export const getMenus = ({ isLogin, isBilibili }: { isLogin: boolean; isBilibili: boolean }) =>
  [
    {
      key: "favorite",
      label: "收藏",
      icon: <RiStarLine size={18} />,
      hidden: !isBilibili || !isLogin,
    },
    {
      key: "download-audio",
      label: "下载音频",
      icon: <RiFileMusicLine size={18} />,
      hidden: !isBilibili,
    },
    {
      icon: <RiFileVideoLine size={18} />,
      key: "download-video",
      label: "下载视频",
      hidden: !isBilibili,
    },
    {
      key: "bililink",
      label: "在 B 站打开",
      icon: <RiExternalLinkLine size={18} />,
      hidden: !isBilibili,
    },
    {
      key: "del",
      color: "danger" as const,
      label: "从列表删除",
      icon: <RiDeleteBinLine size={18} />,
    },
  ].filter(item => !item.hidden);
