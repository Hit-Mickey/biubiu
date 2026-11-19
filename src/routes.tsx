import { lazy } from "react";
import type { RouteObject } from "react-router";

import Layout from "./layout";
import EmptyPage from "./pages/empty";
import MusicRecommend from "./pages/music-recommend";
import NotFound from "./pages/not-found";

const DownloadList = lazy(() => import("./pages/download-list"));
const DynamicFeed = lazy(() => import("./pages/dynamic-feed"));
const FollowList = lazy(() => import("./pages/follow-list"));
const History = lazy(() => import("./pages/history"));
const Later = lazy(() => import("./pages/later"));
const LocalMusicPage = lazy(() => import("./pages/local-music"));
const MiniPlayer = lazy(() => import("./pages/mini-player"));
const RemoteMusicPage = lazy(() => import("./pages/remote-music"));
const Search = lazy(() => import("./pages/search"));
const Settings = lazy(() => import("./pages/settings"));
const UserProfile = lazy(() => import("./pages/user-profile"));
const Folder = lazy(() => import("./pages/video-collection"));

const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <MusicRecommend />,
      },
      {
        path: "later",
        element: <Later />,
      },
      {
        path: "history",
        element: <History />,
      },
      {
        path: "follow",
        element: <FollowList />,
      },
      {
        path: "collection/:id",
        element: <Folder />,
      },
      {
        path: "user/:id",
        element: <UserProfile />,
      },
      {
        path: "settings",
        element: <Settings />,
      },
      {
        path: "download-list",
        element: <DownloadList />,
      },
      {
        path: "dynamic-feed",
        element: <DynamicFeed />,
      },
      {
        path: "local-music",
        element: <LocalMusicPage />,
      },
      {
        path: "remote-music",
        element: <RemoteMusicPage />,
      },
      {
        path: "search",
        element: <Search />,
      },
      {
        path: "empty",
        element: <EmptyPage />,
      },
    ],
  },
  {
    path: "mini-player",
    element: <MiniPlayer />,
  },
  {
    path: "*",
    element: <NotFound />,
  },
];

export default routes;
