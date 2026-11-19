export const webDavScheme = "biu-webdav";

export interface WebDavListConfig {
  name: string;
  url: string;
  username: string;
  directory: string;
  includeSubdirectories: boolean;
  lazyMetadata: boolean;
  removeRemoteFiles: boolean;
}

export interface WebDavListInput extends WebDavListConfig {
  id?: string;
  password?: string;
}

export interface WebDavTrack {
  id: string;
  title: string;
  filename: string;
  folder: string;
  format: string;
  size?: number;
  createdAt?: number;
  modifiedAt?: number;
  artist?: string;
  album?: string;
  duration?: number;
  year?: number;
  disc?: number;
  track?: number;
  lossless?: boolean;
  hasCover: boolean;
}

export interface WebDavList extends WebDavListConfig {
  id: string;
  tracks: WebDavTrack[];
  syncedAt: number;
  hasPassword: boolean;
  isSyncing: boolean;
  error?: string;
}

export interface WebDavPreferences {
  cacheAudio: boolean;
  debugLog: boolean;
}

export interface WebDavLibrary {
  lists: WebDavList[];
  preferences: WebDavPreferences;
}

export interface WebDavRemoveResult {
  removed: string[];
  error?: string;
}

export function webDavMediaUrl(kind: "audio" | "cover", listId: string, trackId: string) {
  return `${webDavScheme}://${kind}/${listId}/${trackId}`;
}
