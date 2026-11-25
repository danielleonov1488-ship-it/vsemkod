import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: { index: "src/main/index.ts", "voice-worker": "src/main/voice-worker.ts" } } } },
  preload: { build: { lib: { formats: ["cjs"] } } },
  renderer: { server: { host: "127.0.0.1", hmr: false, ws: false } }
});
