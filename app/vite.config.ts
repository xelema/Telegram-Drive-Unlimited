import { englishTranslationChunks } from './scripts/english-translation-chunks';
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    englishTranslationChunks(),
    {
      name: "compact-local-translation-data",
      enforce: "pre",
      apply: "build",
      async load(id) {
        if (!/[\\/]src[\\/]i18n[\\/]locales[\\/][^\\/]+\.json\?url$/.test(id)) return;
        const filename = id.slice(0, -4);
        const source = JSON.stringify(JSON.parse(await readFile(filename, "utf8")));
        const reference = this.emitFile({ type: "asset", name: basename(filename), source });
        return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
      },
    },
    react(),
  ],

  optimizeDeps: {
    // Only the app and direct browser fixtures are frontend entry points.
    // Vite's default **/*.html discovery also walks native build trees and
    // generated reports, which can delay the first document by over a minute.
    entries: ['index.html', 'src/components/dev/*BrowserFixture.tsx'],
  },

  build: {
    manifest: true,
    // Keep Vite's warning aligned with the reviewed hard failure ceiling in
    // bundle-budget.json. The budget checker still fails the build at 550 kB.
    chunkSizeWarningLimit: 550,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
