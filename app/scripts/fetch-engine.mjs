import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "2.4.1";
const checksums = {
  "win32-x64": ["opencode-windows-x64-baseline.zip", "40c4f842398abcba3837d554a2b0ddd9a11c5fae667f198e0bb716d101a2aab4"],
  "win32-arm64": ["opencode-windows-arm64.zip", "03ccc3d6a9b46ab082cbf7f5f86ff07c4bfcd7b802dbafe1614c257b1a96df8e"],
  "darwin-x64": ["opencode-darwin-x64-baseline.zip", "3dd6612423b69f7f282866112d99b6d690c8e07f27375b227f6a6ee4e652f5b5"],
  "darwin-arm64": ["opencode-darwin-arm64.zip", "95a101eda95108478f1db43cff8fcbd4811f6c0e79af1e167301843c6a48d731"],
  "linux-x64": ["opencode-linux-x64-baseline.tar.gz", "9ddd18e3faf64eaeccf6a0fcbc96a5c7a14520ae5fd5b61e5be51d894f478b47"],
  "linux-arm64": ["opencode-linux-arm64.tar.gz", "cb28cf94541aeb62a4b2ea5997a99b5dd6bae595a772f36fbe279299f2032a4f"]
};
const platform = process.argv[2] ?? process.platform + "-" + process.arch;
if (!Object.hasOwn(checksums, platform)) throw new Error("Не поддерживается платформа " + platform);
const [archive, expected] = checksums[platform];
const windows = platform.startsWith("win32-");
const binary = windows ? "opencode.exe" : "opencode";
const destination = fileURLToPath(new URL("../resources/engine/" + platform + "/", import.meta.url));
await mkdir(destination, { recursive: true });

const digest = (data) => createHash("sha256").update(data).digest("hex");
const stamp = join(destination, "sha256");
const executable = join(destination, binary);
const installed = await Promise.all([readFile(stamp, "utf8"), readFile(executable)]).catch(() => undefined);
if (installed && installed[0] === version + " " + expected + " " + digest(installed[1])) process.exit(0);

const staging = await mkdtemp(join(destination, ".download-"));
try {
  const url = "https://github.com/anomalyco/opencode/releases/download/v" + version + "/" + archive;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error("OpenCode: HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error("SHA-256 OpenCode не совпал");
  const source = join(staging, archive);
  await writeFile(source, bytes);
  if (archive.endsWith(".zip") && process.platform === "win32") {
    execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive], { cwd: staging });
  } else if (archive.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archive], { cwd: staging });
  } else {
    execFileSync("tar", ["-xf", archive], { cwd: staging });
  }
  const extracted = join(staging, binary);
  const checksum = digest(await readFile(extracted));
  if (!windows) await chmod(extracted, 0o755);
  await rename(extracted, executable);
  await writeFile(stamp, version + " " + expected + " " + checksum);
  console.log("OpenCode " + version + " · " + platform + " · SHA-256 проверен");
} finally {
  if (dirname(resolve(staging)) === resolve(destination)) await rm(staging, { recursive: true, force: true });
}
