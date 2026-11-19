import { useState } from "react";

import { Button, Checkbox, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";

import { savePlaylist, type Playlist } from "@/store/desktop-playlists";

interface Props {
  kind: Playlist["kind"];
  list?: Playlist;
  catalog: Playlist[];
  onClose: () => void;
  onSaved: (id: string) => void;
}

export default function PlaylistEditor({ list, kind, catalog, onClose, onSaved }: Props) {
  const [name, setName] = useState(list?.name ?? "");
  const [sources, setSources] = useState(list?.kind === "dynamic" ? list.sourceIds : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const choices = catalog.filter(p => p.kind === "normal");
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      onSaved(await savePlaylist({ id: list?.id, name, sourceIds: kind === "dynamic" ? sources : undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal isOpen scrollBehavior="inside" isDismissable={!saving} isKeyboardDismissDisabled={saving} onClose={onClose}>
      <ModalContent>
        <ModalHeader>
          {list ? "编辑" : "新建"}
          {kind === "dynamic" ? "动态" : "普通"}歌单
        </ModalHeader>
        <ModalBody
          as="form"
          id="desktop-playlist-editor"
          onSubmit={e => {
            e.preventDefault();
            void save();
          }}
        >
          <Input label="歌单名称" isRequired maxLength={80} value={name} onValueChange={setName} />
          {kind === "dynamic" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm">来源歌单</legend>
              <p className="text-default-500 text-xs">按勾选顺序合并并去重。取消后重新勾选即可将来源移到最后。</p>
              {choices.map(p => {
                const i = sources.indexOf(p.id);
                return (
                  <Checkbox
                    key={p.id}
                    size="sm"
                    isSelected={i !== -1}
                    onValueChange={checked =>
                      setSources(previous => (checked ? [...previous, p.id] : previous.filter(id => id !== p.id)))
                    }
                  >
                    {i !== -1 && `${i + 1}. `}
                    {p.name}
                  </Checkbox>
                );
              })}
              {!choices.length && <p className="text-default-500 text-sm">先创建普通歌单，也可稍后添加来源。</p>}
            </fieldset>
          )}
          {error && (
            <p className="text-danger text-sm" role="alert">
              {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="flat" isDisabled={saving} onPress={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            color="primary"
            type="submit"
            form="desktop-playlist-editor"
            isLoading={saving}
            isDisabled={!name.trim()}
          >
            保存
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
