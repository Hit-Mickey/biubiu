import React from "react";
import { Controller } from "react-hook-form";
import type { Control, UseFormSetValue } from "react-hook-form";

import {
  Button,
  Divider,
  Form,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Slider,
  Switch,
  Tab,
  Tabs,
} from "@heroui/react";
import {
  RiArrowRightLongLine,
  RiComputerLine,
  RiFileListLine,
  RiLayoutGridFill,
  RiListView,
  RiMoonLine,
  RiSunLine,
} from "@remixicon/react";

import FontSelect from "@/components/font-select";
import UpdateCheckButton from "@/components/update-check-button";
import { formatAppVersion } from "@shared/app";
import { lyricSearchSources } from "@shared/settings/lyric-search-sources";

import ColorSettings from "./color-settings";
import ImportExport from "./export-import";

const segmentedTabsClassNames = {
  base: "settings-row-control max-w-full min-w-0 @max-[36rem]/settings-page:w-full",
  tabList:
    "max-w-full @max-[36rem]/settings-page:w-full @max-[36rem]/settings-page:flex-wrap @max-[36rem]/settings-page:gap-1 @max-[36rem]/settings-page:overflow-visible",
  tab: "@max-[36rem]/settings-page:w-auto @max-[36rem]/settings-page:min-w-fit @max-[36rem]/settings-page:flex-auto @max-[36rem]/settings-page:px-2",
  cursor: "rounded-medium",
};

type SystemSettingsTabProps = {
  appVersion: string;
  audioQuality: AudioQuality;
  control: Control<AppSettings>;
  isUpdateAvailable: boolean;
  latestVersion?: string;
  setValue: UseFormSetValue<AppSettings>;
};

export const SystemSettingsTab = ({
  appVersion,
  audioQuality,
  control,
  isUpdateAvailable,
  latestVersion,
  setValue,
}: SystemSettingsTabProps) => {
  return (
    <Form className="w-full max-w-full min-w-0 space-y-6">
      <h2>外观</h2>
      {/* 显示模式 */}
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">数据显示样式</div>
          <div className="text-sm text-zinc-500">选择媒体内容的显示样式</div>
        </div>
        <Controller
          control={control}
          name="displayMode"
          render={({ field }) => (
            <Tabs
              aria-label="数据展示"
              classNames={segmentedTabsClassNames}
              selectedKey={field.value}
              onSelectionChange={key => field.onChange(key)}
            >
              <Tab
                key="list"
                title={
                  <div className="flex items-center space-x-2 @max-[36rem]/settings-page:space-x-1">
                    <RiListView size={18} />
                    <span>列表</span>
                  </div>
                }
              />
              <Tab
                key="card"
                title={
                  <div className="flex items-center space-x-2 @max-[36rem]/settings-page:space-x-1">
                    <RiLayoutGridFill size={18} />
                    <span>网格</span>
                  </div>
                }
              />
              <Tab
                key="compact"
                title={
                  <div className="flex items-center space-x-2 @max-[36rem]/settings-page:space-x-1">
                    <RiFileListLine size={18} />
                    <span>紧凑</span>
                  </div>
                }
              />
            </Tabs>
          )}
        />
      </div>
      {/* 主题模式 */}
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">主题</div>
          <div className="text-sm text-zinc-500">选择浅色或深色主题</div>
        </div>

        <Controller
          control={control}
          name="themeMode"
          render={({ field }) => (
            <Tabs
              aria-label="主题切换"
              classNames={segmentedTabsClassNames}
              selectedKey={field.value}
              onSelectionChange={key => field.onChange(key)}
            >
              <Tab
                key="system"
                title={
                  <div className="flex items-center space-x-2 @max-[36rem]/settings-page:space-x-1">
                    <RiComputerLine size={18} />
                    <span>跟随系统</span>
                  </div>
                }
              />
              <Tab
                key="light"
                title={
                  <div className="flex items-center space-x-2 @max-[36rem]/settings-page:space-x-1">
                    <RiSunLine size={18} />
                    <span>浅色</span>
                  </div>
                }
              />
              <Tab
                key="dark"
                title={
                  <div className="flex items-center space-x-2 @max-[36rem]/settings-page:space-x-1">
                    <RiMoonLine size={18} />
                    <span>深色</span>
                  </div>
                }
              />
            </Tabs>
          )}
        />
      </div>
      {/* color 自定义 */}
      <div className="w-full min-w-0">
        <ColorSettings control={control} />
      </div>
      {/* 字体选择 */}
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">字体</div>
          <div className="text-sm text-zinc-500">选择界面显示的字体</div>
        </div>
        <div className="settings-row-control w-[180px] max-w-full min-w-0 shrink-0 @max-[36rem]/settings-page:w-full">
          <Controller
            control={control}
            name="fontFamily"
            render={({ field }) => (
              <FontSelect className="w-full min-w-0" value={field.value} onChange={field.onChange} />
            )}
          />
        </div>
      </div>

      {/* 页面切换动画 FIXME:暂时移除，该功能会导致页面切换时重复渲染，数据请求double */}
      {/* <div className="flex w-full items-center justify-between">
        <div className="mr-6 space-y-1">
          <div className="text-medium font-medium">页面切换动画</div>
          <div className="text-sm text-zinc-500">选择页面切换时的过渡效果</div>
        </div>
        <div className="w-[180px]">
          <Controller
            control={control}
            name="pageTransition"
            render={({ field }) => (
              <Select
                aria-label="页面切换动画"
                selectedKeys={field.value ? new Set([field.value]) : new Set()}
                onSelectionChange={keys => {
                  const value = Array.from(keys)[0] as PageTransition;
                  field.onChange(value);
                }}
              >
                <SelectItem key="none">无动画</SelectItem>
                <SelectItem key="fade">淡入淡出</SelectItem>
                <SelectItem key="slide">滑动</SelectItem>
                <SelectItem key="scale">缩放</SelectItem>
                <SelectItem key="slideUp">上浮</SelectItem>
              </Select>
            )}
          />
        </div>
      </div> */}
      {/* 全局圆角设置 */}
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">圆角</div>
          <div className="text-sm text-zinc-500">调整界面控件的圆角大小</div>
        </div>
        <div className="settings-row-control w-[360px] max-w-full min-w-0 shrink-0 @max-[36rem]/settings-page:w-full">
          <Controller
            control={control}
            name="borderRadius"
            render={({ field }) => (
              <Slider
                showTooltip={false}
                size="sm"
                endContent={<span className="shrink-0 whitespace-nowrap">{field.value}px</span>}
                aria-label="全局圆角"
                value={field.value}
                onChange={v => field.onChange(Number(v))}
                minValue={0}
                maxValue={24}
                step={1}
                classNames={{
                  base: "w-full min-w-0",
                  thumb: "after:hidden",
                }}
              />
            )}
          />
        </div>
      </div>
      <Divider />
      <h2>播放</h2>
      {/* 音质选择 */}
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">音质偏好</div>
          <div className="text-sm text-zinc-500">
            {audioQuality === "auto" && "自动选择最高音质"}
            {audioQuality === "lossless" && "FLAC / Hi-Res"}
            {audioQuality === "high" && "180-320 kbps"}
            {audioQuality === "medium" && "100-140 kbps"}
            {audioQuality === "low" && "60-80 kbps"}
          </div>
          <div id="audio-quality-sources" className="text-xs text-zinc-500">
            仅影响 B 站歌曲，本地、WebDAV 音质由源文件决定
          </div>
        </div>
        <div className="settings-row-control w-[180px] max-w-full min-w-0 shrink-0 @max-[36rem]/settings-page:w-full">
          <Controller
            control={control}
            name="audioQuality"
            render={({ field }) => (
              <Select
                disallowEmptySelection
                aria-label="音质偏好"
                aria-describedby="audio-quality-sources"
                selectedKeys={field.value ? new Set([field.value]) : new Set()}
                onSelectionChange={keys => {
                  const value = Array.from(keys)[0] as AudioQuality;
                  field.onChange(value);
                }}
              >
                <SelectItem key="auto">自动</SelectItem>
                <SelectItem key="lossless">无损</SelectItem>
                <SelectItem key="high">高品质</SelectItem>
                <SelectItem key="medium">中等</SelectItem>
                <SelectItem key="low">低品质</SelectItem>
              </Select>
            )}
          />
        </div>
      </div>
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">歌词搜索默认源</div>
          <div className="text-sm text-zinc-500">打开歌词搜索时优先使用的来源</div>
        </div>
        <div className="settings-row-control w-[180px] max-w-full min-w-0 shrink-0 @max-[36rem]/settings-page:w-full">
          <Controller
            control={control}
            name="lyricSearchSource"
            render={({ field }) => (
              <Select
                aria-label="歌词搜索默认源"
                disallowEmptySelection
                selectedKeys={[field.value]}
                onSelectionChange={keys => {
                  const [source] = keys;
                  if (source && Object.hasOwn(lyricSearchSources, source)) field.onChange(source);
                }}
              >
                {Object.entries(lyricSearchSources).map(([source, label]) => (
                  <SelectItem key={source}>{label}</SelectItem>
                ))}
              </Select>
            )}
          />
        </div>
      </div>
      {/* 播放记录上报 */}
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">上报本机播放记录</div>
          <div className="text-sm text-zinc-500">将播放进度同步到Bilibili服务器</div>
        </div>
        <Controller
          control={control}
          name="reportPlayHistory"
          render={({ field }) => (
            <Switch
              className="settings-row-control shrink-0 @max-[36rem]/settings-page:self-start"
              disableAnimation
              isSelected={field.value}
              onValueChange={field.onChange}
            />
          )}
        />
      </div>

      <Divider />
      <h2>下载</h2>
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">下载目录</div>
          <div className="text-sm text-zinc-500">选择音视频保存的位置</div>
        </div>
        <div className="settings-row-control w-[360px] max-w-full min-w-0 shrink-0 @max-[36rem]/settings-page:w-full">
          <Controller
            control={control}
            name="downloadPath"
            render={({ field }) => (
              <div className="flex min-w-0 items-center space-x-1 @max-[36rem]/settings-page:flex-col @max-[36rem]/settings-page:items-stretch @max-[36rem]/settings-page:gap-2 @max-[36rem]/settings-page:space-x-0">
                <Input
                  className="min-w-0 flex-1 @max-[36rem]/settings-page:hidden"
                  isDisabled
                  placeholder="选择文件夹"
                  value={field.value}
                  onValueChange={field.onChange}
                />
                <div className="bg-default-100 rounded-medium text-small hidden w-full min-w-0 px-3 py-2 break-all @max-[36rem]/settings-page:block">
                  {field.value || <span className="text-foreground-500">选择文件夹</span>}
                </div>
                <Button
                  className="shrink-0 @max-[36rem]/settings-page:self-start"
                  variant="flat"
                  onPress={async () => {
                    const path = await window.electron.selectDirectory();
                    if (path) setValue("downloadPath", path, { shouldDirty: true, shouldTouch: true });
                  }}
                >
                  选择
                </Button>
              </div>
            )}
          />
        </div>
      </div>

      {/* FFmpeg 路径配置 */}
      {window.electron.getPlatform() !== "android" && (
        <div className="settings-row flex w-full min-w-0 items-center justify-between">
          <div className="settings-row-label mr-6 min-w-0 space-y-1">
            <div className="text-medium font-medium">FFmpeg 路径</div>
            <div className="text-sm text-zinc-500">手动指定 FFmpeg 可执行文件路径</div>
          </div>
          <div className="settings-row-control w-[360px] max-w-full min-w-0 shrink-0 @max-[36rem]/settings-page:w-full">
            <Controller
              control={control}
              name="ffmpegPath"
              render={({ field }) => (
                <div className="flex min-w-0 items-center space-x-1 @max-[36rem]/settings-page:flex-col @max-[36rem]/settings-page:items-stretch @max-[36rem]/settings-page:gap-2 @max-[36rem]/settings-page:space-x-0">
                  <Input
                    className="min-w-0 flex-1 @max-[36rem]/settings-page:hidden"
                    isDisabled
                    placeholder="自动检测"
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                  <div className="bg-default-100 rounded-medium text-small hidden w-full min-w-0 px-3 py-2 break-all @max-[36rem]/settings-page:block">
                    {field.value || <span className="text-foreground-500">自动检测</span>}
                  </div>
                  <Button
                    className="shrink-0 @max-[36rem]/settings-page:self-start"
                    variant="flat"
                    onPress={async () => {
                      const path = await window.electron.selectFile();
                      if (path) setValue("ffmpegPath", path, { shouldDirty: true, shouldTouch: true });
                    }}
                  >
                    选择
                  </Button>
                </div>
              )}
            />
          </div>
        </div>
      )}
      <Divider />
      <h2>搜索</h2>
      {/* 显示搜索历史 */}
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 min-w-0 space-y-1">
          <div className="text-medium font-medium">显示搜索历史</div>
          <div className="text-sm text-zinc-500">在搜索框中显示搜索历史记录</div>
        </div>
        <Controller
          control={control}
          name="showSearchHistory"
          render={({ field }) => (
            <Switch
              className="settings-row-control shrink-0 @max-[36rem]/settings-page:self-start"
              disableAnimation
              isSelected={field.value}
              onValueChange={field.onChange}
            />
          )}
        />
      </div>

      <Divider />
      <h2>系统</h2>
      {/* 窗口关闭选项 */}
      {window.electron.getPlatform() !== "android" && (
        <div className="settings-row flex w-full min-w-0 items-center justify-between">
          <div className="settings-row-label mr-6 min-w-0 space-y-1">
            <div className="text-medium font-medium">窗口关闭</div>
            <div className="text-sm text-zinc-500">选择窗口关闭时的行为</div>
          </div>
          <Controller
            control={control}
            name="closeWindowOption"
            render={({ field }) => (
              <RadioGroup
                classNames={{
                  base: "settings-row-control max-w-full min-w-0",
                  wrapper: "flex-wrap",
                }}
                orientation="horizontal"
                value={field.value}
                onValueChange={field.onChange}
              >
                <Radio value="hide">隐藏到托盘</Radio>
                <Radio value="exit">直接退出</Radio>
              </RadioGroup>
            )}
          />
        </div>
      )}

      {/* 开机自启动开关 */}
      {window.electron.getPlatform() !== "android" && (
        <div className="settings-row flex w-full min-w-0 items-center justify-between">
          <div className="settings-row-label mr-6 min-w-0 space-y-1">
            <div className="text-medium font-medium">开机自启动</div>
            <div className="text-sm text-zinc-500">系统登录后自动启动应用</div>
          </div>
          <div className="settings-row-control flex w-[360px] max-w-full min-w-0 justify-end @max-[36rem]/settings-page:w-full @max-[36rem]/settings-page:justify-start">
            <Controller
              control={control}
              name="autoStart"
              render={({ field }) => (
                <Switch disableAnimation isSelected={field.value} onValueChange={field.onChange} />
              )}
            />
          </div>
        </div>
      )}

      <Divider />
      <h2>关于应用</h2>
      <div className="settings-row flex w-full min-w-0 items-center justify-between">
        <div className="settings-row-label mr-6 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
          <span>当前版本 {formatAppVersion(appVersion)}</span>
          {isUpdateAvailable && Boolean(latestVersion) && (
            <>
              <RiArrowRightLongLine size={16} />
              <span className="text-primary">{formatAppVersion(latestVersion ?? "")}</span>
            </>
          )}
        </div>
        <div className="settings-row-control max-w-full min-w-0 shrink-0 @max-[36rem]/settings-page:self-start">
          <UpdateCheckButton />
        </div>
      </div>
      <ImportExport />
    </Form>
  );
};
