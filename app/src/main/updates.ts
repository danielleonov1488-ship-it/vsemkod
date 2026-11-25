import { app, shell } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateCheck, UpdateReady } from "../shared/api";

const releaseUrl = "https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest";
const checkInterval = 6 * 60 * 60 * 1000;

export function createUpdates(publish: (update?: UpdateReady) => void) {
  const enabled = app.isPackaged && (process.platform !== "linux" || Boolean(process.env.APPIMAGE));
  const updater = enabled ? electronUpdater.autoUpdater : undefined;
  let ready: UpdateReady | undefined;
  let downloading: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on("error", error => console.warn("[updates]", error.message));
  }

  function setReady(update?: UpdateReady) {
    if (update?.version === ready?.version) return;
    ready = update;
    publish(update);
  }

  async function check(): Promise<UpdateCheck> {
    if (!updater) return "disabled";
    if (downloading) return "downloading";
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
      downloading = updater.downloadUpdate(result.cancellationToken)
        .then(() => setReady({ version, action: "restart" }))
        .catch(() => {}) // electron-updater emits and logs the error above.
        .finally(() => { downloading = undefined; });
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

  return { get ready() { return ready; }, check, start, stop: () => clearInterval(timer), apply };
}
