
import { chmod, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { downloadFile, verifySha256 } from "./download";

declare const __VSEMKOD_STANDALONE__: boolean | undefined;
const standalone = typeof __VSEMKOD_STANDALONE__ !== "undefined" && __VSEMKOD_STANDALONE__;
const repository = "danielleonov1488-ship-it/vsemkod";
const checksumAsset = "vsemkod-cli-checksums.txt";
const releaseSchema = z.object({
  tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/),
  assets: z.array(z.object({ name: z.string() }))
});

const targets: Record<string, string> = {
  "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
  "darwin-x64": "macos-x64", "darwin-arm64": "macos-arm64",
  "win32-x64": "windows-x64.exe"
};

const previousPath = (executable: string) => executable + ".vsemkod-previous";

export async function clearPreviousUpdate() {
  if (standalone && process.platform === "win32") {
    const executable = await realpath(process.execPath);
    await rm(previousPath(executable), { force: true }).catch(() => {});
  }
}

function newerVersion(release: string, current: string) {
  const previous = current.split(".").map(Number);
  const difference = release.slice(1).split(".").map((part, i) => Number(part) - previous[i]);
  return (difference.find(part => part !== 0) ?? 0) > 0;
}

export async function update(current: string) {
  if (!standalone) throw new Error("Самообновление доступно в готовом бинарнике vsemkod из GitHub Releases.");
  const target = targets[process.platform + "-" + process.arch];
  if (!target) throw new Error("Для этой платформы нет сборки vsemkod CLI.");
  const asset = "vsemkod-cli-" + target;
  const response = await fetch("https://api.github.com/repos/" + repository + "/releases/latest", {
    signal: AbortSignal.timeout(15_000)
  }).catch(() => { throw new Error("Не удалось проверить выпуск. Проверьте доступ к GitHub."); });
  if (!response.ok) throw new Error("Не удалось проверить выпуск GitHub (HTTP " + response.status + ").");
  const release = releaseSchema.safeParse(await response.json());
  if (!release.success) throw new Error("GitHub вернул неверные сведения о выпуске.");
  const { tag_name: tag, assets } = release.data;
  if (!newerVersion(tag, current)) {
    console.log("Установлена актуальная версия " + current + ".");
    return;
  }
  if (![asset, checksumAsset].every(name => assets.some(item => item.name === name))) {
    throw new Error("В выпуске " + tag + " отсутствует сборка CLI или файл SHA-256.");
  }
  const base = "https://github.com/" + repository + "/releases/download/" + tag + "/";
  const checksums = await fetch(base + checksumAsset, { signal: AbortSignal.timeout(15_000) });
  if (!checksums.ok) throw new Error("Не удалось скачать контрольные суммы.");
  const matching = (await checksums.text()).split(/\r?\n/)
    .map(line => /^([0-9a-f]{64})[ \t]+\*?(\S+)$/i.exec(line))
    .filter(entry => entry?.[2] === asset);
  if (matching.length !== 1) throw new Error("В выпуске нет однозначной суммы SHA-256 для этой сборки.");

  const executable = await realpath(process.execPath);
  const staging = await mkdtemp(join(dirname(executable), ".vsemkod-update-"));
  try {
    const download = join(staging, asset);
    await downloadFile(base + asset, download);
    await verifySha256(download, matching[0]![1]);
    if (process.platform === "win32") {
      const previous = previousPath(executable);
      // Windows allows moving a running image but disallows replacing it in place.
      await rename(executable, previous);
      try {
        await rename(download, executable);
      } catch (error) {
        await rename(previous, executable).catch(() => {
          throw new Error("Не удалось восстановить бинарник. Предыдущая версия сохранена в " + previous + ".");
        });
        throw error;
      }
    } else {
      await chmod(download, 0o755);
      await rename(download, executable);
    }
    console.log("Обновлено до " + tag + " · SHA-256 проверен.");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
