import React, { useRef, useState } from "react";
import { useLocation, useParams } from "react-router";

import { Button, Tab, Tabs } from "@heroui/react";
import { useRequest } from "ahooks";

import type { ModuleAuthor } from "@/service/web-dynamic";

import { UserRelation } from "@/common/constants/relation";
import ScrollContainer, { type ScrollRefObject } from "@/components/scroll-container";
import { getRelationStat } from "@/service/relation-stat";
import { getXSpaceSettings } from "@/service/space-setting";
import { getSpaceWbiAccInfo } from "@/service/space-wbi-acc-info";
import { getSpaceWbiAccRelation } from "@/service/space-wbi-acc-relation";
import { useUser } from "@/store/user";

import DynamicList from "./dynamic-list";
import Favorites from "./favorites";
import VideoPost from "./post";
import VideoSeries from "./series";
import SpaceInfo from "./space-info";

/**
 * 用户个人中心
 */
const UserProfile = () => {
  const { id } = useParams();
  const loggedIn = useUser(s => !!s.user?.isLogin);
  return id ? <Profile key={`${id}-${loggedIn}`} id={id} loggedIn={loggedIn} /> : null;
};

function Profile({ id, loggedIn }: { id: string; loggedIn: boolean }) {
  const selectedOwner = useLocation().state?.profileOwner;
  const [publicOwner, setPublicOwner] = useState<Pick<ModuleAuthor, "mid" | "name" | "face">>();
  const user = useUser(s => s.user);
  const isSelf = String(user?.mid) === id;
  const scrollRef = useRef<ScrollRefObject>(null);

  const {
    data: profile,
    loading,
    error,
    run: reloadProfile,
  } = useRequest((interactive = false) => getSpaceWbiAccInfo({ mid: id }, { passive: !loggedIn && !interactive }));
  const userInfo = profile?.code === 0 && Number(profile.data?.mid) === Number(id) ? profile.data : undefined;
  const verificationRequired = Boolean(profile?.data?.v_voucher || profile?.code === -352);
  const { data: relationWithMe, refreshAsync: refreshRelation } = useRequest(
    async () => {
      const res = await getSpaceWbiAccRelation({
        mid: Number(id),
      });

      return res.data?.relation?.attribute;
    },
    {
      ready: Boolean(user?.isLogin) && !!id,
      refreshDeps: [id],
    },
  );

  const { data: relationStats } = useRequest(
    async () => {
      const res = await getRelationStat({
        vmid: Number(id),
      });

      return res.data;
    },
    {
      ready: loggedIn && relationWithMe !== UserRelation.Blocked,
      refreshDeps: [id],
    },
  );

  const { data: spacePrivacy } = useRequest(
    async () => {
      const res = await getXSpaceSettings(
        {
          mid: Number(id),
          web_location: "333.1387",
        },
        { passive: !loggedIn },
      );

      return res.data?.privacy;
    },
    {
      ready: !!id,
      refreshDeps: [id],
    },
  );

  const tabs = [
    {
      label: "动态",
      key: "dynamic",
      content: (
        <DynamicList
          mid={Number(id)}
          guest={!loggedIn}
          onOwner={setPublicOwner}
          getScrollElement={() => scrollRef.current?.osInstance()?.elements().viewport || null}
        />
      ),
    },
    {
      label: "投稿",
      key: "video",
      content: <VideoPost getScrollElement={() => scrollRef.current?.osInstance()?.elements().viewport || null} />,
    },
    {
      label: "收藏夹",
      key: "collection",
      hidden: !isSelf && !spacePrivacy?.fav_video,
      content: <Favorites getScrollElement={() => scrollRef.current?.osInstance()?.elements().viewport || null} />,
    },
    {
      label: "合集",
      key: "union",
      content: <VideoSeries getScrollElement={() => scrollRef.current?.osInstance()?.elements().viewport || null} />,
    },
  ].filter(item => !item.hidden);

  return (
    <ScrollContainer enableBackToTop ref={scrollRef} className="h-full w-full">
      <SpaceInfo
        spaceInfo={userInfo ?? publicOwner ?? (selectedOwner?.mid === Number(id) ? selectedOwner : undefined)}
        relationStats={relationStats}
        relationWithMe={relationWithMe}
        refreshRelation={refreshRelation}
      />
      {((verificationRequired && !loggedIn) || (error && !publicOwner)) && (
        <Button size="sm" variant="light" className="mt-1" isLoading={loading} onPress={() => reloadProfile(true)}>
          {verificationRequired ? "验证并查看完整资料" : "重新加载资料"}
        </Button>
      )}
      {relationWithMe !== UserRelation.Blocked && (
        <div className="p-4">
          <Tabs
            radius="md"
            classNames={{ cursor: "rounded-medium", panel: "px-0 py-4" }}
            aria-label="个人资料栏目"
            variant="solid"
          >
            {tabs.map(item => (
              <Tab key={item.key} title={item.label}>
                {item.content}
              </Tab>
            ))}
          </Tabs>
        </div>
      )}
    </ScrollContainer>
  );
}

export default UserProfile;
