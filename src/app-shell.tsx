import type { ComponentProps, PropsWithChildren } from "react";

import { HeroUIProvider, ToastProvider } from "@heroui/react";

import Theme from "./components/theme";

import "overlayscrollbars/overlayscrollbars.css";
import "./app.css";

type NavigationProps = Pick<ComponentProps<typeof HeroUIProvider>, "navigate" | "useHref">;

export default function AppShell({ children, ...navigation }: PropsWithChildren<NavigationProps>) {
  return (
    <HeroUIProvider {...navigation} locale="zh-CN">
      <ToastProvider
        placement="bottom-right"
        toastOffset={90}
        maxVisibleToasts={3}
        toastProps={{ timeout: 2000, color: "primary" }}
        regionProps={{
          classNames: {
            base: "z-[99999]",
          },
        }}
      />
      <Theme>{children}</Theme>
    </HeroUIProvider>
  );
}
