import { createRoot } from "react-dom/client";

import AppShell from "./app-shell";
import MiniPlayer from "./pages/mini-player";

createRoot(document.getElementById("root") as HTMLElement).render(
  <AppShell>
    <MiniPlayer />
  </AppShell>,
);
