import { app, shell } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateCheck, UpdateProgress, UpdateReady } from "../shared/api";

const releaseUrl = "https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest";
const checkInterval = 60 * 60 * 1000;
/** Окно показали или компьютер проснулся: проверяем снова, если прошло больше 10 минут. */
const staleAfter = 10 * 60 * 1000;

export function createUpdates(publish: (update?: UpdateReady) => void, progress: (value?: UpdateProgress) => void = () => {}) {
  const enabled = app.isPackaged && (process.platform !== "linux" || Boolean(process.env.APPIMAGE));
  const updater = enabled ? electronUpdater.autoUpdater : undefined;
  let ready: UpdateReady | undefined;
  let downloading: Promise<void> | undefined;
  let downloadingVersion: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checkedAt = 0;

  if (updater) {
    updater.autoDownload = false;
    // Windows и Linux: если пользователь просто закрыл приложение, загруженное обновление ставится при выходе.
    updater.autoInstallOnAppQuit = process.platform !== "darwin";
    updater.on("error", error => console.warn("[updates]", error.message));
    updater.on("download-progress", info => { if (downloadingVersion) progress({ version: downloadingVersion, percent: info.percent }); });
  }

  function setReady(update?: UpdateReady) {
    if (update?.version === ready?.version) return;
    ready = update;
    publish(update);
  }

  async function check(): Promise<UpdateCheck> {
    if (!updater) return "disabled";
    if (downloading) return "downloading";
    checkedAt = Date.now();
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) return ready ?? "current";

    const { version } = result.updateInfo;
    if (ready?.version === version) return ready;
    if (process.platform === "darwin") {
      setReady({ version, action: "download" });
      return ready!;
    }
    if (!downloading) {
      setReady(undefined);
      downloadingVersion = version;
      progress({ version });
      downloading = updater.downloadUpdate(result.cancellationToken)
        .then(() => setReady({ version, action: "restart" }))
        .catch(() => {}) // electron-updater emits and logs the error above.
        .finally(() => { downloading = undefined; downloadingVersion = undefined; progress(undefined); });
    }
    return "downloading";
  }

  function start() {
    if (!updater) return;
    const backgroundCheck = () => { void check().catch(() => {}); };
    backgroundCheck();
    timer = setInterval(backgroundCheck, checkInterval);
  }

  async function apply() {
    if (!updater || !ready) return;
    if (ready.action === "download") return shell.openExternal(releaseUrl);
    // AppImageUpdater starts the new process before asking Electron to quit.
    const appImage = process.platform === "linux";
    let installError: Error | undefined;
    const onError = (error: Error) => { installError = error; };
    updater.once("error", onError);
    try {
      if (appImage) app.releaseSingleInstanceLock();
      updater.quitAndInstall(true, true);
    } finally {
      updater.removeListener("error", onError);
    }
    if (installError) {
      if (appImage) app.requestSingleInstanceLock();
      throw new Error("Не удалось установить обновление.");
    }
  }

  /** Окно открыли из трея или вторым запуском: приложение могло неделями жить в трее и пропустить выпуск. */
  function checkIfStale() {
    if (!updater || !timer || downloading || ready?.action === "restart" || Date.now() - checkedAt < staleAfter) return;
    void check().catch(() => {});
  }

  return { get ready() { return ready; }, check, checkIfStale, start, stop: () => clearInterval(timer), apply };
}
