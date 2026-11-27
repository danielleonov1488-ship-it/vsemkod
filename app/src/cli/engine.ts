
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { writeJson } from "../main/storage";
import { downloadFile, sha256, verifySha256 } from "./download";

export const engineVersion = "2.4.1";
// Keep these pins in sync with scripts/fetch-engine.mjs (checked by tests).
export const engineManifest: Record<string, readonly [string, string]> = {
  "win32-x64": ["opencode-windows-x64-baseline.zip", "40c4f842398abcba3837d554a2b0ddd9a11c5fae667f198e0bb716d101a2aab4"],
  "win32-arm64": ["opencode-windows-arm64.zip", "03ccc3d6a9b46ab082cbf7f5f86ff07c4bfcd7b802dbafe1614c257b1a96df8e"],
  "darwin-x64": ["opencode-darwin-x64-baseline.zip", "3dd6612423b69f7f282866112d99b6d690c8e07f27375b227f6a6ee4e652f5b5"],
  "darwin-arm64": ["opencode-darwin-arm64.zip", "95a101eda95108478f1db43cff8fcbd4811f6c0e79af1e167301843c6a48d731"],
  "linux-x64": ["opencode-linux-x64-baseline.tar.gz", "9ddd18e3faf64eaeccf6a0fcbc96a5c7a14520ae5fd5b61e5be51d894f478b47"],
  "linux-arm64": ["opencode-linux-arm64.tar.gz", "cb28cf94541aeb62a4b2ea5997a99b5dd6bae595a772f36fbe279299f2032a4f"]
};
const execute = promisify(execFile);

export function cliHome(env = process.env, platform = process.platform, home = homedir()) {
  if (env.VSEMKOD_HOME) return resolve(env.VSEMKOD_HOME);
  return platform === "win32"
    ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "vsemkod-cli")
    : join(home, ".vsemkod");
}

export function enginePath(data: string, env = process.env, platform = process.platform, arch = process.arch) {
  if (env.VSEMKOD_ENGINE) return resolve(env.VSEMKOD_ENGINE);
  return join(data, "engine", engineVersion, platform + "-" + arch, platform === "win32" ? "opencode.exe" : "opencode");
}

export async function ensureEngine(data: string, env = process.env): Promise<string> {
  const executable = enginePath(data, env);
  if (env.VSEMKOD_ENGINE) {
    await access(executable, constants.X_OK).catch(() => { throw new Error("Проверьте путь к OpenCode в VSEMKOD_ENGINE."); });
    return executable;
  }
  const target = process.platform + "-" + process.arch;
  const asset = engineManifest[target];
  if (!asset) throw new Error("Нет сборки OpenCode для " + target + ". Укажите VSEMKOD_ENGINE.");
  const [archive, expected] = asset;
  const destination = join(data, "engine", engineVersion, target);
  const stamp = join(destination, "sha256.json");
  const cached = await readFile(stamp, "utf8").catch(() => undefined);
  if (cached) {
    const binaryHash = await sha256(executable).catch(() => undefined);
    if (binaryHash && cached === JSON.stringify([expected, binaryHash])) {
      if (process.platform !== "win32") await access(executable, constants.X_OK).catch(() => chmod(executable, 0o755));
      return executable;
    }
  }

  await mkdir(destination, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(destination, ".download-"));
  try {
    const source = join(staging, archive);
    await downloadFile("https://github.com/anomalyco/opencode/releases/download/v" + engineVersion + "/" + archive, source);
    await verifySha256(source, expected);
    const windows = process.platform === "win32";
    const zip = archive.endsWith(".zip");
    const tool = windows ? join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : zip ? "unzip" : "tar";
    try {
      await execute(tool, [zip && !windows ? "-q" : "-xf", archive], { cwd: staging, windowsHide: true });
    } catch {
      throw new Error("Не удалось распаковать OpenCode. Проверьте наличие " + (zip && !windows ? "unzip" : "tar") + ".");
    }
    const extracted = join(staging, windows ? "opencode.exe" : "opencode");
    const binaryHash = await sha256(extracted);
    if (!windows) await chmod(extracted, 0o755);
    await rename(extracted, executable).catch(async error => {
      // Another CLI process may already be using the same verified binary.
      if (await sha256(executable).catch(() => undefined) !== binaryHash) throw error;
    });
    await writeJson(stamp, [expected, binaryHash]);
    return executable;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}
