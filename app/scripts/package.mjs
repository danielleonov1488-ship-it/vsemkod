import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const electronCache = process.env.ELECTRON_CACHE || join(root, ".electron-cache");
const builderCache = process.env.ELECTRON_BUILDER_CACHE || join(root, ".eb-cache");
await copyFile(join(root, "../catalog-bot/data/catalog.json"), join(root, "resources/catalog.json"));
if (!process.env.ELECTRON_BUILDER_CACHE) {
  // Builder's downloaded icon tool is CommonJS and lives under our ESM package.
  await mkdir(builderCache, { recursive: true });
  await writeFile(join(builderCache, "package.json"), '{"type":"commonjs"}\n');
}

const build = spawnSync(process.execPath, [require.resolve("electron-builder/cli.js"),
  `-c.electronDownload.cache=${electronCache}`, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: builderCache
  }
});
if (build.error) throw build.error;
process.exitCode = build.status ?? 1;
