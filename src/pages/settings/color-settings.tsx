import React from "react";
import { Controller, type Control } from "react-hook-form";

import { Card, CardBody, CardFooter } from "@heroui/react";

import { resolvePrimaryColor, Themes } from "@/common/constants/theme";
import { isHex } from "@/common/utils/color";
import ColorPicker from "@/components/color-picker";
import { useTheme } from "@/components/theme/use-theme";
import { defaultAppSettings } from "@shared/settings/app-settings";

const ColorItem = ({
  label,
  value,
  onChange,
  presets,
}: {
  label: string;
  value?: string;
  onChange: (hex: string) => void;
  presets?: string[];
}) => {
  return (
    <ColorPicker value={value} onChange={onChange} presets={presets}>
      <Card
        as="div"
        isPressable
        radius="md"
        shadow="sm"
        className="border-default w-[100px] max-w-full border @max-[36rem]/settings-page:w-auto @max-[36rem]/settings-page:max-w-[120px] @max-[36rem]/settings-page:min-w-[76px] @max-[36rem]/settings-page:flex-1"
      >
        <CardBody
          className="border-default h-[40px] items-center border-b p-0"
          style={{ backgroundColor: value || presets?.[0] }}
        />
        <CardFooter className="justify-center p-2 text-xs">
          <b>{label}</b>
        </CardFooter>
      </Card>
    </ColorPicker>
  );
};

const ColorSettings = ({ control }: { control: Control<AppSettings> }) => {
  const { theme } = useTheme();

  return (
    <div className="settings-row-control flex w-full max-w-full min-w-0 flex-wrap justify-end gap-3 @max-[36rem]/settings-page:justify-start @max-[36rem]/settings-page:gap-2">
      <Controller
        control={control}
        name="backgroundColor"
        render={({ field }) => {
          const backgroundColor = Themes[theme].colors!.background as string;
          const pickerValue = isHex(field.value) ? field.value : backgroundColor;
          return (
            <ColorItem label="背景" value={pickerValue} onChange={v => field.onChange(v)} presets={[backgroundColor]} />
          );
        }}
      />
      <Controller
        control={control}
        name="primaryColor"
        render={({ field }) => {
          const primaryColor = resolvePrimaryColor(theme);
          const pickerValue = resolvePrimaryColor(theme, field.value);
          return (
            <ColorItem
              label="主色"
              value={pickerValue}
              onChange={value =>
                field.onChange(
                  value.toLowerCase() === primaryColor.toLowerCase() ? defaultAppSettings.primaryColor : value,
                )
              }
              presets={[primaryColor]}
            />
          );
        }}
      />
    </div>
  );
};

export default ColorSettings;
