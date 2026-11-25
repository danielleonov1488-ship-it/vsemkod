import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const release = "b5907";
const assets = {
  "win32-x64": [772393177, "whisper-bin-x64.zip", "Release",
    "ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b"],
  "linux-x64": [772388023, "whisper-bin-ubuntu-x64.tar.gz", "whisper-bin-ubuntu-x64",
    "a6199027fe5b4239c84171d2bca4c0ff44ec86a515494d5a39b237b212d429bd"]
};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

export async function fetchWhisperCli(target, destination) {
  const artifact = assets[target];
  if (!artifact) return;
  const [id, archive, prefix, checksum] = artifact;
  const windows = target.startsWith("win32-");
  const executable = windows ? "whisper-cli.exe" : "whisper-cli";
  const cli = join(destination, "cli");
  const stage = join(destination, ".cli-" + process.pid);
  const manifest = join(cli, "sha256.json");
  const cached = await readFile(manifest, "utf8").then(JSON.parse).catch(() => undefined);
  if (cached?.archive === checksum && cached.files.includes(executable)) {
    const files = await Promise.all(cached.files.map(async name => {
      const bytes = await readFile(join(cli, name)).catch(() => undefined);
      return bytes && [name, digest(bytes)];
    }));
    if (files.every(Boolean) && JSON.stringify(files) === JSON.stringify(cached.digests)) {
      if (!windows && process.platform !== "win32") await chmod(join(cli, executable), 0o755);
      console.log("whisper-cli " + target + " · SHA-256 проверен (кэш)");
      return;
    }
  }

  const repo = "https://github.com/ggml-org/whisper.cpp/releases/download/" + release;
  const signal = AbortSignal.timeout(120_000);
  let response = await fetch(repo + "/" + archive, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    response = await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases/assets/" + id, {
      headers: { Accept: "application/octet-stream" }, signal
    });
  }
  if (!response.ok) throw new Error("whisper-cli " + target + " · HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== checksum) throw new Error("SHA-256 whisper-cli не совпал: " + target);
  await mkdir(stage, { recursive: true });
  await mkdir(cli, { recursive: true });
  const source = join(stage, archive);
  try {
    await writeFile(source, bytes);
    const library = windows ? /^(?:ggml(?:-base|-cpu-[\w-]+)?|whisper)\.dll$/ :
      /^lib(?:ggml(?:-base|-cpu-[\w-]+)?|whisper)\.so(?:\.[\d.]+)?$/;
    const files = execFileSync(tar, ["-tf", source], { encoding: "utf8" }).trim().split(/\r?\n/)
      .filter(name => name.startsWith(prefix + "/")).map(name => name.slice(prefix.length + 1))
      .filter(name => name === executable || library.test(name));
    if (!files.includes(executable) || files.length < 3) throw new Error("Неполный архив whisper-cli.");
    // Extract each as a regular file, including Linux SONAMEs, for Electron Builder.
    const terminalFiles = files.filter(name => name === executable || windows || !/^lib(?:ggml|ggml-base|whisper)\.so(?:\.\d)?$/.test(name));
    const digests = [];
    for (const name of terminalFiles) {
      const blob = execFileSync(tar, ["-xOf", source, prefix + "/" + name], { maxBuffer: 32 * 1024 * 1024 });
      if (!blob.length) throw new Error("Пустой файл whisper-cli: " + name);
      const destNames = [name];
      const soname = /^(lib(?:ggml|ggml-base|whisper)\.so\.\d)\.\d+\.\d+$/.exec(name)?.[1];
      if (soname) destNames.push(soname);
      for (const destName of destNames) {
        const path = join(stage, destName);
        await writeFile(path, blob);
        if (!windows && process.platform !== "win32" && destName === executable) await chmod(path, 0o755);
        await rename(path, join(cli, destName));
        digests.push([destName, digest(blob)]);
      }
    }
    await writeFile(manifest, JSON.stringify({ archive: checksum, files: digests.map(entry => entry[0]), digests }));
    console.log("whisper-cli " + target + " · SHA-256 проверен");
  } finally {
    for (const name of await readdir(stage)) await rm(join(stage, name), { force: true });
    await rmdir(stage);
  }
}
