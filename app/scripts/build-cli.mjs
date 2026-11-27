
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outfile = "out/cli/vsemkod.mjs";
await build({
  absWorkingDir: root,
  entryPoints: ["src/cli/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info"
});
if (process.platform !== "win32") await chmod(new URL("../" + outfile, import.meta.url), 0o755);
