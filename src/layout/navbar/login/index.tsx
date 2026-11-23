import React, { useCallback, useState, type ComponentProps } from "react";

import { Button, Divider, Modal, ModalBody, ModalContent, Tab, Tabs, addToast } from "@heroui/react";

import { nextCookieRefreshTime } from "@/common/utils/cookie";
import { useFavoritesStore } from "@/store/favorite";
import { useToken } from "@/store/token";
import { useUser } from "@/store/user";

import CodeLogin from "./code-login";
import PasswordLogin from "./password-login";
import QrcodeLogin from "./qrcode-login";

interface Props {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

const mobile = window.electron.getPlatform() === "android";
const methods = { qr: "扫码登录", sms: "短信登录", password: "密码登录" } as const;
type LoginMethod = keyof typeof methods;

function MobileLogin(props: ComponentProps<typeof QrcodeLogin>) {
  const [method, setMethod] = useState<LoginMethod>("qr");
  return (
    <ModalBody className="items-center gap-5 px-5 pt-8 pb-5">
      {method === "qr" ? (
        <QrcodeLogin {...props} />
      ) : (
        <div className="w-full max-w-80 min-w-0">
          <h2 className="mb-4 text-center text-lg font-medium">{methods[method]}</h2>
          {method === "sms" ? <CodeLogin {...props} /> : <PasswordLogin {...props} />}
        </div>
      )}
      <div className="flex w-full justify-center gap-2">
        {(Object.keys(methods) as LoginMethod[])
          .filter(key => key !== method)
          .map(key => (
            <Button key={key} size="sm" variant="light" color="primary" onPress={() => setMethod(key)}>
              {methods[key]}
            </Button>
          ))}
      </div>
    </ModalBody>
  );
}

const Login = ({ isOpen, onOpenChange }: Props) => {
  const updateUser = useUser(state => state.updateUser);
  const updateToken = useToken(state => state.updateToken);
  const updateCreatedFavorites = useFavoritesStore(state => state.updateCreatedFavorites);
  const updateCollectedFavorites = useFavoritesStore(state => state.updateCollectedFavorites);

  const onClose = () => onOpenChange(false);

  const updateUserData = useCallback(
    async (refreshToken?: string) => {
      try {
        if (refreshToken) {
          updateToken({
            tokenData: { refresh_token: refreshToken },
            nextCheckRefreshTime: nextCookieRefreshTime(),
          });
        }

        await updateUser();

        const user = useUser.getState().user;

        if (user?.mid) {
          await Promise.allSettled([updateCreatedFavorites(user.mid), updateCollectedFavorites(user.mid)]);
        }
      } catch {
        addToast({ title: "更新用户信息失败", color: "danger" });
      }
    },
    [updateCollectedFavorites, updateCreatedFavorites, updateToken, updateUser],
  );

  return (
    <Modal
      aria-label="登录哔哩哔哩"
      size={mobile ? "sm" : "2xl"}
      placement={mobile ? "center" : undefined}
      scrollBehavior={mobile ? "inside" : undefined}
      radius="md"
      isOpen={isOpen}
      isDismissable={false}
      onOpenChange={onOpenChange}
    >
      <ModalContent>
        {mobile ? (
          isOpen && <MobileLogin onClose={onClose} updateUserData={updateUserData} />
        ) : (
          <ModalBody className="flex-row items-center justify-center gap-8 py-8">
            <QrcodeLogin onClose={onClose} updateUserData={updateUserData} />
            <Divider className="h-42" orientation="vertical" />
            <div className="w-[320px]">
              <Tabs
                aria-label="登录方式"
                classNames={{ cursor: "rounded-medium", tabContent: "text-lg font-medium mb-4" }}
                fullWidth
                size="lg"
                variant="underlined"
              >
                <Tab key="code" title="短信登录">
                  <CodeLogin onClose={onClose} updateUserData={updateUserData} />
                </Tab>
                <Tab key="password" title="密码登录">
                  <PasswordLogin onClose={onClose} updateUserData={updateUserData} />
                </Tab>
              </Tabs>
            </div>
          </ModalBody>
        )}
      </ModalContent>
    </Modal>
  );
};

export default Login;
