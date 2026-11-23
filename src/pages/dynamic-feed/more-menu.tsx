import React from "react";

import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Button } from "@heroui/react";
import { RiFileMusicLine, RiFileVideoLine, RiMore2Fill, RiPlayListAddLine, RiUserLine } from "@remixicon/react";

interface MoreMenuProps {
  onOpenProfile?: () => void;
  onAddToNext?: () => void;
  onDownloadAudio?: () => void;
  onDownloadVideo?: () => void;
}

const MoreMenu: React.FC<MoreMenuProps> = ({ onOpenProfile, onAddToNext, onDownloadAudio, onDownloadVideo }) => {
  return (
    <Dropdown>
      <DropdownTrigger>
        <Button aria-label="动态操作" variant="light" isIconOnly size="sm" radius="md" className="text-default-500">
          <RiMore2Fill size={16} />
        </Button>
      </DropdownTrigger>
      <DropdownMenu aria-label="动态操作">
        <DropdownItem key="add-next" startContent={<RiPlayListAddLine size={18} />} onPress={onAddToNext}>
          添加到下一首播放
        </DropdownItem>
        <DropdownItem key="download-audio" startContent={<RiFileMusicLine size={18} />} onPress={onDownloadAudio}>
          下载音频
        </DropdownItem>
        <DropdownItem key="download-video" startContent={<RiFileVideoLine size={18} />} onPress={onDownloadVideo}>
          下载视频
        </DropdownItem>
        {onOpenProfile ? (
          <DropdownItem key="open-owner" startContent={<RiUserLine size={18} />} onPress={onOpenProfile}>
            打开 UP 主主页
          </DropdownItem>
        ) : null}
      </DropdownMenu>
    </Dropdown>
  );
};

export default MoreMenu;
