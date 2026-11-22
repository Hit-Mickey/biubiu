import "./bridge";

import { createRoot } from "react-dom/client";

import { HeroUIProvider } from "@heroui/react";

import Theme from "./components/theme";
import MiniPlayer from "./pages/mini-player";

import "./app.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <HeroUIProvider locale="zh-CN">
    <Theme>
      <MiniPlayer />
    </Theme>
  </HeroUIProvider>,
);
