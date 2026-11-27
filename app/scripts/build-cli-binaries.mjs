
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "out/cli");
const assets = {
  "bun-linux-x64": "vsemkod-cli-linux-x64",
  "bun-linux-arm64": "vsemkod-cli-linux-arm64",
  "bun-darwin-arm64": "vsemkod-cli-macos-arm64",
  "bun-darwin-x64": "vsemkod-cli-macos-x64",
  "bun-windows-x64": "vsemkod-cli-windows-x64.exe"
};
const targets = process.argv.length > 2 ? [...new Set(process.argv.slice(2))] : Object.keys(assets);
for (const target of targets) {
  if (!Object.hasOwn(assets, target)) throw new Error("Нет целевой платформы " + target + ".");
}
await mkdir(out, { recursive: true });
const checksums = [];
for (const target of targets) {
  const name = assets[target];
  const outfile = join(out, name);
  const result = await Bun.build({
    entrypoints: [join(out, "vsemkod.mjs")],
    define: { __VSEMKOD_STANDALONE__: "true" },
    compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false }
  });
  if (!result.success) throw new AggregateError(result.logs, "Не удалось собрать " + name + ".");
  if (process.platform !== "win32" && !name.endsWith(".exe")) await chmod(outfile, 0o755);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(outfile)) hash.update(chunk);
  checksums.push(hash.digest("hex") + "  " + name);
  console.log(name + " · собрано");
}
await writeFile(join(out, "vsemkod-cli-checksums.txt"), checksums.join("\n") + "\n");
