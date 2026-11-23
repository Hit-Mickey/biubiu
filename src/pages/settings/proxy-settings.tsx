import React from "react";
import { Controller, type Control } from "react-hook-form";

import { Form, Input, Select, SelectItem } from "@heroui/react";

interface ProxySettingsProps {
  control: Control<AppSettings>;
}

const PROXY_TYPE_OPTIONS: { key: ProxyType; label: string }[] = [
  { key: "none", label: "不使用代理" },
  { key: "http", label: "HTTP 代理" },
  { key: "socks4", label: "SOCKS4 代理" },
  { key: "socks5", label: "SOCKS5 代理" },
];

const PROXY_INPUT_CLASS_NAMES = {
  base: "min-w-0",
  inputWrapper: "min-w-0",
  innerWrapper: "min-w-0",
  input: "min-w-0",
};

const ProxySettings: React.FC<ProxySettingsProps> = ({ control }) => {
  return (
    <Form className="w-full max-w-full min-w-0 space-y-6 @max-[36rem]/settings-page:items-stretch">
      <Controller
        control={control}
        name="proxySettings"
        render={({ field }) => {
          const value = field.value ?? {
            type: "none" as ProxyType,
            host: "",
            port: undefined,
            username: "",
            password: "",
          };

          const setProxy = (patch: Partial<ProxySettings>) => {
            field.onChange({
              ...value,
              ...patch,
            });
          };

          const showPassword = value.type === "http" || value.type === "socks5";

          return (
            <div className="max-w-full min-w-0 space-y-4 @max-[36rem]/settings-page:w-full">
              <div className="settings-row-control w-[240px] max-w-full min-w-0 @max-[36rem]/settings-page:w-full">
                <Select
                  disallowEmptySelection
                  aria-label="代理类型"
                  classNames={{
                    base: "min-w-0",
                    trigger: "min-w-0",
                  }}
                  selectedKeys={new Set([value.type])}
                  onSelectionChange={keys => {
                    const next = Array.from(keys)[0] as ProxyType | undefined;
                    setProxy({
                      type: next ?? "none",
                    });
                  }}
                >
                  {PROXY_TYPE_OPTIONS.map(option => (
                    <SelectItem key={option.key}>{option.label}</SelectItem>
                  ))}
                </Select>
              </div>

              {(value.type === "http" || value.type === "socks4" || value.type === "socks5") && (
                <>
                  <div className="grid grid-cols-2 gap-4 @max-[36rem]/settings-page:grid-cols-1 @max-[36rem]/settings-page:gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm text-zinc-500">主机</div>
                      <Input
                        classNames={PROXY_INPUT_CLASS_NAMES}
                        placeholder="主机"
                        value={value.host ?? ""}
                        onValueChange={v => setProxy({ host: v })}
                      />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm text-zinc-500">端口</div>
                      <Input
                        classNames={PROXY_INPUT_CLASS_NAMES}
                        placeholder="端口"
                        inputMode="numeric"
                        value={value.port ? String(value.port) : ""}
                        onValueChange={v => {
                          const trimmed = v.trim();
                          const num = Number(trimmed);
                          setProxy({ port: Number.isFinite(num) && num > 0 ? num : undefined });
                        }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 @max-[36rem]/settings-page:grid-cols-1 @max-[36rem]/settings-page:gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm text-zinc-500">用户名</div>
                      <Input
                        classNames={PROXY_INPUT_CLASS_NAMES}
                        placeholder="用户名"
                        value={value.username ?? ""}
                        onValueChange={v => setProxy({ username: v })}
                      />
                    </div>
                    {showPassword && (
                      <div className="min-w-0 space-y-1">
                        <div className="text-sm text-zinc-500">密码</div>
                        <Input
                          classNames={PROXY_INPUT_CLASS_NAMES}
                          placeholder="密码"
                          type="password"
                          value={value.password ?? ""}
                          onValueChange={v => setProxy({ password: v })}
                        />
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        }}
      />
    </Form>
  );
};

export default ProxySettings;
