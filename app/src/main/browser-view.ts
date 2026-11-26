import { existsSync, realpathSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, shell, WebContentsView, type BrowserWindow, type Session } from "electron";
import { emptyBrowserState, isAllowedNavigation, normalizeAddress, type BrowserBounds, type BrowserEvent, type BrowserState } from "../shared/browser";

const partition = "persist:vsemkod-browser";
const maxErrors = 50;

/** Один встроенный браузер на окно: WebContentsView поверх области вкладки «Браузер». */
export function createBrowserHost(options: {
  window: () => BrowserWindow | undefined;
  projectRoot: () => string | undefined;
  publish: (event: BrowserEvent) => void;
}) {
  let view: WebContentsView | undefined;
  let attachedTo: BrowserWindow | undefined;
  let visible = false;
  let currentRoot: string | undefined;
  let state: BrowserState = { ...emptyBrowserState };
  let configured: Session | undefined;

  const emit = () => options.publish({ type: "state", state: { ...state, errors: [...state.errors] } });
  const patch = (next: Partial<BrowserState>) => { state = { ...state, ...next }; emit(); };

  function configureSession(session: Session) {
    if (configured === session) return;
    configured = session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", (_event, item) => {
      const downloads = app.getPath("downloads");
      const name = basename(item.getFilename()) || "download";
      const extension = extname(name);
      let target = join(downloads, name);
      for (let index = 1; existsSync(target) && index < 1000; index++) target = join(downloads, name.slice(0, name.length - extension.length) + " (" + index + ")" + extension);
      item.setSavePath(target);
      item.once("done", (_done, result) => { if (result === "completed") options.publish({ type: "download", name: basename(target), path: target }); });
    });
  }

  function allowed(url: string, project?: string) {
    if (!isAllowedNavigation(url, project)) return false;
    if (!url.startsWith("file:")) return true;
    try { return isAllowedNavigation(pathToFileURL(realpathSync(fileURLToPath(url))).href, project); }
    catch { return false; }
  }

  function sync() {
    if (!view) return;
    const contents = view.webContents;
    patch({
      url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward()
    });
  }

  function ensure(): WebContentsView {
    const window = options.window();
    if (!window) throw new Error("Окно приложения закрыто.");
    if (!view) {
      view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
      view.setBackgroundColor("#ffffff");
      const contents = view.webContents;
      configureSession(contents.session);
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url) && isAllowedNavigation(url)) void contents.loadURL(url);
        return { action: "deny" };
      });
      const guard = (event: { preventDefault(): void }, url: string) => {
        if (allowed(url, options.projectRoot())) return;
        event.preventDefault();
        patch({ failure: "Этот адрес нельзя открыть во встроенном браузере." });
      };
      contents.on("will-navigate", (event, url) => guard(event, url));
      contents.on("will-redirect", (event, url) => guard(event, url));
      contents.on("did-start-loading", () => patch({ loading: true, failure: undefined }));
      contents.on("did-stop-loading", sync);
      contents.on("did-navigate", () => { state.errors = []; sync(); });
      contents.on("did-navigate-in-page", sync);
      contents.on("page-title-updated", sync);
      contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
        if (!mainFrame || code === -3) return; // -3: переход отменён новым переходом.
        patch({ loading: false, failure: "Не удалось открыть " + url + " — " + description });
      });
      contents.on("render-process-gone", () => patch({ loading: false, failure: "Страница аварийно закрылась. Нажмите «Обновить»." }));
      contents.on("console-message", (_event, ...args: unknown[]) => {
        const details = typeof args[0] === "object" && args[0] !== null
          ? args[0] as { level: string; message: string; lineNumber: number; sourceId: string }
          : { level: args[0] === 3 ? "error" : "", message: String(args[1] ?? ""), lineNumber: Number(args[2]), sourceId: String(args[3] ?? "") };
        if (details.level !== "error") return;
        const message = details.message.slice(0, 2000);
        if (!message) return;
        state.errors = [...state.errors, { message, line: details.lineNumber || undefined, source: details.sourceId || undefined, at: Date.now() }].slice(-maxErrors);
        emit();
      });
    }
    if (attachedTo !== window) {
      if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view);
      window.contentView.addChildView(view);
      attachedTo = window;
      window.once("closed", () => { if (attachedTo === window) host.destroy(); });
    }
    return view;
  }

  const host = {
    show(bounds: BrowserBounds) {
      const current = ensure();
      const zoom = options.window()?.webContents.getZoomFactor() ?? 1;
      current.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.max(0, Math.round(bounds.width * zoom)), height: Math.max(0, Math.round(bounds.height * zoom)) });
      if (!visible) { current.setVisible(true); visible = true; }
    },
    hide() {
      if (view && visible) { view.setVisible(false); visible = false; }
    },
    async navigate(input: string, directory?: string) {
      const url = normalizeAddress(input);
      const project = directory ?? options.projectRoot();
      const differentProject = currentRoot !== project;
      if (differentProject) {
        currentRoot = project;
        host.hide();
        view?.webContents.stop();
        state = { ...emptyBrowserState };
      }
      if (!url || !allowed(url, project)) {
        patch({ failure: "Этот адрес нельзя открыть во встроенном браузере." });
        return state;
      }
      const current = ensure();
      patch({ url, failure: undefined, loading: true });
      await current.webContents.loadURL(url).catch(() => { /* причина придёт в did-fail-load */ });
      if (differentProject && currentRoot === project) { current.webContents.navigationHistory.clear(); sync(); }
      return state;
    },
    back() { if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); },
    forward() { if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); },
    reload() { if (view) { state.errors = []; view.webContents.reload(); } },
    stop() { view?.webContents.stop(); },
    async external() {
      const url = view?.webContents.getURL();
      if (url && /^https?:/i.test(url)) await shell.openExternal(url);
      else if (url?.startsWith("file:")) await shell.openExternal(url);
    },
    devtools() { view?.webContents.openDevTools({ mode: "detach" }); },
    async clearData() {
      if (!view) return;
      await view.webContents.session.clearStorageData();
      await view.webContents.session.clearCache();
      view.webContents.reload();
    },
    clearErrors() { state.errors = []; emit(); },
    state: () => ({ ...state, errors: [...state.errors] }),
    destroy() {
      if (!view) return;
      if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      view = undefined;
      attachedTo = undefined;
      visible = false;
    }
  };
  return host;
}
