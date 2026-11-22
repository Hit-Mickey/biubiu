import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginSvgr } from "@rsbuild/plugin-svgr";

export default defineConfig({
  source: {
    entry: { index: "./src/index.tsx", mini: "./src/mini.tsx", "desktop-lyrics": "./src/desktop-lyrics.ts" },
  },
  output: {
    distPath: {
      root: "./dist/web",
    },
    assetPrefix: "./",
    cleanDistPath: true,
  },
  performance: {
    removeMomentLocale: true,
  },
  html: {
    template: "./src/index.html",
  },
  plugins: [
    pluginReact(),
    pluginSvgr({
      svgrOptions: {
        exportType: "named",
        // Enable SVGO to optimize inline SVGs
        svgo: true,
        svgoConfig: {
          plugins: [
            {
              name: "preset-default",
              params: { overrides: { removeViewBox: false } },
            },
          ],
        },
      },
    }),
  ],
  dev: {
    lazyCompilation: false,
    cliShortcuts: false,
  },
  server: {
    port: 5678,
    strictPort: true,
    printUrls: true,
    open: false,
    compress: false,
  },
});
