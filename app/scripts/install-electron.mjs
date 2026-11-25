import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const electronCache = process.env.ELECTRON_CACHE || resolve(root, ".electron-cache");
execFileSync(process.execPath, [require.resolve("electron/install.js")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_CACHE: electronCache,
    ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || resolve(root, ".eb-cache"),
    electron_config_cache: electronCache
  }
});
