import { lazy, Suspense, useEffect } from "react";

import { Card } from "@heroui/react";

import { usePlayList } from "@/store/play-list";

import Center from "./center";
import Right from "./right";

const Left = lazy(() => import("./left"));

/**
 * 播放任务栏
 */
function PlayBar() {
  const playId = usePlayList(s => s.playId);
  const init = usePlayList(s => s.init);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <Card
      radius="none"
      shadow="sm"
      className="bg-background grid h-full grid-cols-[minmax(0,1fr)_minmax(0,3fr)_minmax(max-content,1fr)] px-4"
    >
      <div className="h-full">
        {Boolean(playId) && (
          <Suspense fallback={null}>
            <Left />
          </Suspense>
        )}
      </div>
      <Center />
      <Right />
    </Card>
  );
}

export default PlayBar;
