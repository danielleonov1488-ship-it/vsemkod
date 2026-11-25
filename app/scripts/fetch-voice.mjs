import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fetchWhisperCli } from "./fetch-whisper-cli.mjs";

const version = "1.2.0-rc.2";
const checksums = {
  "win32-x64": "8bb202707a6fe04b5056c299f3ee248365062a24b605e3f08131edebc9970849",
  "win32-x64-vulkan": "b386588838eaa3763bf9fe967fdd0bc51c681db76d0f1be722ff409522eea85a",
  "darwin-arm64": "82a1230a8eb7f06edc6fd7934ee283e0e02e207dfe409f4cd70af53c0f4d9f37",
  "darwin-x64": "f6029c1fda9b3a7acc6af9383fe82d97df90a540cc6163c76da8c17cddf636b9",
  "linux-x64": "76adf34bd83b9c7a6055cb46f6b24b5bb563027788360bee631780a787f5990b",
  "linux-x64-vulkan": "f55a4894d865eb008d05389bd9d628eb90db176abef397aef9da4b84683bbbec"
};
const { values: { platform, arch, "if-supported": ifSupported } } = parseArgs({ options: {
  platform: { type: "string", default: process.platform },
  arch: { type: "string", default: process.arch },
  "if-supported": { type: "boolean" }
} });
const target = platform + "-" + arch;
if (!Object.hasOwn(checksums, target)) {
  if (!ifSupported) throw new Error("Whisper не поддерживается на " + target);
  process.exit(0);
}
const destination = fileURLToPath(new URL("../resources/voice/" + target + "/", import.meta.url));
await mkdir(destination, { recursive: true });

const hash = data => createHash("sha256").update(data).digest("hex");
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

for (const [suffix, filename] of [["", "whisper.node"], ["-vulkan", "whisper-vulkan.node"]]) {
  const artifact = target + suffix;
  const expected = checksums[artifact];
  if (!expected) continue;
  const binary = join(destination, filename);
  const stamp = binary + ".sha256";
  const cached = await Promise.all([readFile(stamp, "utf8"), readFile(binary)]).catch(() => undefined);
  if (cached && cached[0] === expected + " " + hash(cached[1])) {
    console.log("Whisper " + artifact + " · SHA-256 проверен (кэш)");
    continue;
  }

  const name = "node-whisper-" + artifact;
  const url = "https://registry.npmjs.org/@fugood/" + name + "/-/" + name + "-" + version + ".tgz";
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error("Whisper " + artifact + " · HTTP " + response.status);
  const archive = Buffer.from(await response.arrayBuffer());
  if (hash(archive) !== expected) throw new Error("SHA-256 Whisper не совпал: " + artifact);

  const temp = binary + "." + process.pid;
  try {
    await writeFile(temp + ".tgz", archive);
    const bytes = execFileSync(tar, ["-xOf", temp + ".tgz", "package/index.node"], { maxBuffer: 64 * 1024 * 1024 });
    await writeFile(temp, bytes);
    await rename(temp, binary);
    await writeFile(stamp, expected + " " + hash(bytes));
    console.log("Whisper " + artifact + " · SHA-256 проверен");
  } finally {
    await Promise.all([rm(temp, { force: true }), rm(temp + ".tgz", { force: true })]);
  }
}

await fetchWhisperCli(target, destination);
