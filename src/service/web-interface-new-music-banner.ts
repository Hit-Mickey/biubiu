import type { AxiosRequestConfig } from "axios";

import { apiRequest } from "./request";

type NewMusicBannerRequestConfig = Pick<AxiosRequestConfig, "signal">;

export interface NewMusicBannerResponse {
  code?: number;
  message?: string;
  ttl?: number;
  data?: Data;
}

export interface Data {
  list?: List[];
}

export interface List {
  music_id?: string;
  archive_title?: string;
  music_corner?: string;
  publish_time?: string;
  jump_url?: string;
  cover?: string;
  author?: string;
  aid?: number;
  cid?: number;
  bvid?: string;
}

export const getNewMusicBanner = async (config?: NewMusicBannerRequestConfig) => {
  return apiRequest.get<NewMusicBannerResponse>("/x/centralization/interface/new/music/banner", {
    ...config,
    params: {
      web_location: "333.1351",
    },
    useCSRF: true,
  });
};
