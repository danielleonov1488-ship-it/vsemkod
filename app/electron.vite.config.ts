import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: { build: { lib: { formats: ["cjs"] } } },
  renderer: { server: { host: "127.0.0.1", hmr: false, ws: false } }
});
