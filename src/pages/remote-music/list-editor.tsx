import { useRef, useState, type FormEvent } from "react";

import {
  addToast,
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";

import type { WebDavList, WebDavListInput } from "@shared/webdav";

import { webDavErrorMessage } from "./utils";

const defaultList: WebDavListInput = {
  name: "",
  url: "",
  username: "",
  directory: "",
  includeSubdirectories: false,
  lazyMetadata: false,
  removeRemoteFiles: false,
};

interface Props {
  list?: WebDavList;
  onClose: () => void;
  onSaved: (id: string) => void;
}

const WebDavListEditor = ({ list, onClose, onSaved }: Props) => {
  const [value, setValue] = useState<WebDavListInput>(() =>
    list
      ? {
          id: list.id,
          name: list.name,
          url: list.url,
          username: list.username,
          directory: list.directory,
          includeSubdirectories: list.includeSubdirectories,
          lazyMetadata: list.lazyMetadata,
          removeRemoteFiles: list.removeRemoteFiles,
        }
      : defaultList,
  );
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [pending, setPending] = useState<"test" | "save">();
  const [error, setError] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const patch = (patch: Partial<WebDavListInput>) => setValue(previous => ({ ...previous, ...patch }));

  const submit = async (action: "test" | "save", event?: FormEvent) => {
    event?.preventDefault();
    if (pending) return;
    setPending(action);
    setError("");
    const input = { ...value, password: clearPassword ? "" : password || undefined };
    try {
      if (action === "test") {
        await window.electron.testWebDavList({ ...input, name: input.name.trim() || "WebDAV" });
        addToast({ title: "WebDAV 连接成功", color: "success" });
      } else {
        const saved = await window.electron.saveWebDavList(input);
        if (saved.passwordSessionOnly)
          addToast({ title: "系统凭据存储不可用，密码仅在本次运行期间保留", color: "warning" });
        onSaved(saved.id);
      }
    } catch (error) {
      const message = webDavErrorMessage(error);
      setError(message);
      if (message.includes("账号和密码")) passwordRef.current?.focus();
    } finally {
      setPending(undefined);
    }
  };

  return (
    <Modal
      isOpen
      size="lg"
      scrollBehavior="inside"
      isDismissable={!pending}
      isKeyboardDismissDisabled={Boolean(pending)}
      hideCloseButton={Boolean(pending)}
      onClose={onClose}
    >
      <ModalContent>
        <ModalHeader>{list ? "编辑 WebDAV 列表" : "新建 WebDAV 列表"}</ModalHeader>
        <ModalBody as="form" id="webdav-list-form" onSubmit={event => void submit("save", event)}>
          <Input
            label="列表名称"
            isRequired
            maxLength={30}
            value={value.name}
            onValueChange={name => patch({ name })}
          />
          <Input
            label="服务器地址"
            type="url"
            isRequired
            placeholder="https://nas.example.com/dav/"
            value={value.url}
            onValueChange={url => patch({ url })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input label="账号" value={value.username} onValueChange={username => patch({ username })} />
            <Input
              ref={passwordRef}
              label="密码"
              type="password"
              autoComplete="off"
              isDisabled={clearPassword}
              placeholder={list?.hasPassword ? "已保存" : "选填"}
              value={password}
              onValueChange={setPassword}
            />
          </div>
          {list?.hasPassword && (
            <Checkbox size="sm" isSelected={clearPassword} onValueChange={setClearPassword}>
              清除已保存的密码
            </Checkbox>
          )}
          <Input
            label="文件目录"
            placeholder="/音乐"
            description="路径相对于服务器地址，留空扫描根目录。"
            value={value.directory}
            onValueChange={directory => patch({ directory })}
          />
          <div className="flex flex-col gap-2 py-2">
            <Checkbox
              size="sm"
              isSelected={value.includeSubdirectories}
              onValueChange={includeSubdirectories => patch({ includeSubdirectories })}
            >
              包含子目录（最多 5 层）
            </Checkbox>
            <Checkbox size="sm" isSelected={value.lazyMetadata} onValueChange={lazyMetadata => patch({ lazyMetadata })}>
              播放时读取歌曲标签
            </Checkbox>
            <Checkbox
              size="sm"
              isSelected={value.removeRemoteFiles}
              onValueChange={removeRemoteFiles => patch({ removeRemoteFiles })}
            >
              移除歌曲时同时删除远程文件
            </Checkbox>
          </div>
          {error && (
            <p className="text-danger text-sm" role="alert">
              {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter className="justify-between">
          <Button
            variant="flat"
            isDisabled={!value.url.trim() || pending === "save"}
            isLoading={pending === "test"}
            onPress={() => void submit("test")}
          >
            测试连接
          </Button>
          <div className="flex gap-2">
            <Button variant="light" onPress={onClose} isDisabled={Boolean(pending)}>
              取消
            </Button>
            <Button
              color="primary"
              type="submit"
              form="webdav-list-form"
              isDisabled={pending === "test"}
              isLoading={pending === "save"}
            >
              保存
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default WebDavListEditor;
