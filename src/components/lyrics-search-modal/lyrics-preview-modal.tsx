import { useState } from "react";

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Tab, Tabs } from "@heroui/react";

import ScrollContainer from "../scroll-container";

interface Props {
  title?: string;
  text?: LyricText;
  onClose: () => void;
  onAdopt: (text: LyricText) => Promise<boolean>;
}

export default function LyricsPreviewModal({ title, text, onClose, onAdopt }: Props) {
  const [field, setField] = useState<keyof LyricText>("lyrics");
  const [saving, setSaving] = useState(false);
  return (
    <Modal disableAnimation isOpen radius="md" onClose={onClose} placement="center" size="xl">
      <ModalContent>
        <ModalHeader>{title || "歌词预览"}</ModalHeader>
        <ModalBody className="px-0">
          <Tabs
            aria-label="歌词预览"
            selectedKey={field}
            onSelectionChange={key => setField(key as keyof LyricText)}
            className="px-4"
          >
            <Tab key="lyrics" title="歌词原文" />
            {text?.tLyrics && <Tab key="tLyrics" title="歌词翻译" />}
            {text?.romaLyrics && <Tab key="romaLyrics" title="罗马音" />}
          </Tabs>
          <ScrollContainer className="px-4">
            <pre className="text-foreground/90 max-h-[420px] text-sm leading-relaxed break-words whitespace-pre-wrap">
              {text ? text[field] || "暂无歌词" : "歌词加载中..."}
            </pre>
          </ScrollContainer>
        </ModalBody>
        <ModalFooter className="justify-end gap-2">
          <Button variant="light" onPress={onClose}>
            关闭
          </Button>
          <Button
            color="primary"
            isDisabled={!text || saving}
            onPress={async () => {
              if (!text) return;
              setSaving(true);
              try {
                await onAdopt(text);
              } finally {
                setSaving(false);
              }
            }}
          >
            采用歌词
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
