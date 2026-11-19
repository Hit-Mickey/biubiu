import { useState } from "react";

import { addToast, Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch } from "@heroui/react";

import type { WebDavPreferences } from "@shared/webdav";

import { webDavErrorMessage } from "./utils";

const WebDavPreferencesModal = ({
  preferences,
  onClose,
}: {
  preferences: WebDavPreferences;
  onClose: VoidFunction;
}) => {
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const change = async (patch: Partial<WebDavPreferences>) => {
    setSaving(true);
    try {
      await window.electron.setWebDavPreferences({ ...preferences, ...patch });
    } catch (error) {
      addToast({ title: webDavErrorMessage(error), color: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const clearCache = async () => {
    setClearing(true);
    try {
      await window.electron.clearWebDavCache();
      addToast({ title: "歌曲缓存已清空", color: "success" });
    } catch (error) {
      addToast({ title: webDavErrorMessage(error), color: "danger" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose}>
      <ModalContent>
        <ModalHeader>WebDAV 设置</ModalHeader>
        <ModalBody className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm">缓存已播放的歌曲</p>
            <Switch
              aria-label="缓存已播放的歌曲"
              isDisabled={saving}
              isSelected={preferences.cacheAudio}
              onValueChange={cacheAudio => void change({ cacheAudio })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm">记录调试日志</p>
            <Switch
              aria-label="记录调试日志"
              isDisabled={saving}
              isSelected={preferences.debugLog}
              onValueChange={debugLog => void change({ debugLog })}
            />
          </div>
        </ModalBody>
        <ModalFooter className="justify-between">
          <Button variant="flat" isLoading={clearing} onPress={clearCache}>
            清空歌曲缓存
          </Button>
          <Button color="primary" onPress={onClose}>
            完成
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default WebDavPreferencesModal;
