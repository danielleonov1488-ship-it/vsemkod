import { existsSync, realpathSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, shell, WebContentsView, type BrowserWindow, type Session, type WebContents } from "electron";
import { emptyBrowserState, isAllowedNavigation, normalizeAddress, type BrowserBounds, type BrowserEvent, type BrowserState } from "../shared/browser";

const partition = "persist:vsemkod-browser";
const maxErrors = 50;
const maxTabs = 24;

type Tab = {
  id: string;
  view?: WebContentsView;
  visible: boolean;
  /** Папка проекта, внутри которой вкладке можно открывать file:-адреса. */
  root?: string;
  state: BrowserState;
};

/**
 * Вкладки встроенного браузера: у каждой свой WebContentsView поверх области вкладки.
 * Видна не больше одной; закрытая вкладка выгружает страницу.
 */
export function createBrowserHost(options: { window: () => BrowserWindow | undefined; publish: (event: BrowserEvent) => void }) {
  const tabs = new Map<string, Tab>();
  let attachedTo: BrowserWindow | undefined;
  let configured: Session | undefined;

  const emit = (tab: Tab) => options.publish({ type: "state", id: tab.id, state: { ...tab.state, errors: [...tab.state.errors] } });
  const patch = (tab: Tab, next: Partial<BrowserState>) => { tab.state = { ...tab.state, ...next }; emit(tab); };
  const byContents = (contents: WebContents | undefined) => [...tabs.values()].find(tab => tab.view?.webContents === contents);

  function tab(id: string) {
    let found = tabs.get(id);
    if (!found) {
      if (tabs.size >= maxTabs) throw new Error("Открыто слишком много вкладок браузера. Закройте лишние.");
      found = { id, visible: false, state: { ...emptyBrowserState } };
      tabs.set(id, found);
    }
    return found;
  }

  function configureSession(session: Session) {
    if (configured === session) return;
    configured = session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", (_event, item, contents) => {
      const downloads = app.getPath("downloads");
      const name = basename(item.getFilename()) || "download";
      const extension = extname(name);
      let target = join(downloads, name);
      for (let index = 1; existsSync(target) && index < 1000; index++) target = join(downloads, name.slice(0, name.length - extension.length) + " (" + index + ")" + extension);
      item.setSavePath(target);
      const id = byContents(contents)?.id ?? "";
      item.once("done", (_done, result) => { if (result === "completed") options.publish({ type: "download", id, name: basename(target), path: target }); });
    });
  }

  function allowed(url: string, project?: string) {
    if (!isAllowedNavigation(url, project)) return false;
    if (!url.startsWith("file:")) return true;
    try { return isAllowedNavigation(pathToFileURL(realpathSync(fileURLToPath(url))).href, project); }
    catch { return false; }
  }

  function sync(tab: Tab) {
    if (!tab.view) return;
    const contents = tab.view.webContents;
    patch(tab, {
      url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward()
    });
  }

  function attach(view: WebContentsView, window: BrowserWindow) {
    if (attachedTo !== window) {
      if (attachedTo && !attachedTo.isDestroyed()) for (const item of tabs.values()) if (item.view) attachedTo.contentView.removeChildView(item.view);
      attachedTo = window;
      window.once("closed", () => { if (attachedTo === window) host.destroy(); });
    }
    if (!window.contentView.children.includes(view)) window.contentView.addChildView(view);
  }

  function ensure(tab: Tab): WebContentsView {
    const window = options.window();
    if (!window) throw new Error("Окно приложения закрыто.");
    if (!tab.view) {
      const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
      tab.view = view;
      view.setBackgroundColor("#ffffff");
      view.setVisible(false);
      const contents = view.webContents;
      configureSession(contents.session);
      // Ссылки «в новой вкладке» открываются новой вкладкой приложения, а не отдельным окном.
      contents.setWindowOpenHandler(({ url }) => {
        if (allowed(url, tab.root)) options.publish({ type: "open", id: tab.id, url });
        else patch(tab, { failure: "Этот адрес нельзя открыть во встроенном браузере." });
        return { action: "deny" };
      });
      const guard = (event: { preventDefault(): void }, url: string) => {
        if (allowed(url, tab.root)) return;
        event.preventDefault();
        patch(tab, { failure: "Этот адрес нельзя открыть во встроенном браузере." });
      };
      contents.on("will-navigate", (event, url) => guard(event, url));
      contents.on("will-redirect", (event, url) => guard(event, url));
      contents.on("did-start-loading", () => patch(tab, { loading: true, failure: undefined }));
      contents.on("did-stop-loading", () => sync(tab));
      contents.on("did-navigate", () => { tab.state.errors = []; sync(tab); });
      contents.on("did-navigate-in-page", () => sync(tab));
      contents.on("page-title-updated", () => sync(tab));
      contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
        if (!mainFrame || code === -3) return; // -3: переход отменён новым переходом.
        patch(tab, { loading: false, failure: "Не удалось открыть " + url + " — " + description });
      });
      contents.on("render-process-gone", () => patch(tab, { loading: false, failure: "Страница аварийно закрылась. Нажмите «Обновить»." }));
      contents.on("console-message", (_event, ...args: unknown[]) => {
        const details = typeof args[0] === "object" && args[0] !== null
          ? args[0] as { level: string; message: string; lineNumber: number; sourceId: string }
          : { level: args[0] === 3 ? "error" : "", message: String(args[1] ?? ""), lineNumber: Number(args[2]), sourceId: String(args[3] ?? "") };
        if (details.level !== "error") return;
        const message = details.message.slice(0, 2000);
        if (!message) return;
        tab.state.errors = [...tab.state.errors, { message, line: details.lineNumber || undefined, source: details.sourceId || undefined, at: Date.now() }].slice(-maxErrors);
        emit(tab);
      });
    }
    attach(tab.view, window);
    return tab.view;
  }

  function hide(item: Tab) {
    if (item.view && item.visible) { item.view.setVisible(false); item.visible = false; }
  }

  function close(item: Tab) {
    tabs.delete(item.id);
    const view = item.view;
    item.view = undefined;
    item.visible = false;
    if (!view) return;
    if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  const host = {
    show(id: string, bounds: BrowserBounds) {
      const current = tab(id);
      const view = ensure(current);
      for (const other of tabs.values()) if (other !== current) hide(other);
      const zoom = options.window()?.webContents.getZoomFactor() ?? 1;
      view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.max(0, Math.round(bounds.width * zoom)), height: Math.max(0, Math.round(bounds.height * zoom)) });
      if (!current.visible) { view.setVisible(true); current.visible = true; }
    },
    hide(id: string) {
      const current = tabs.get(id);
      if (current) hide(current);
    },
    async navigate(id: string, input: string, project?: string) {
      const current = tab(id);
      const url = normalizeAddress(input);
      const differentProject = current.root !== project;
      if (differentProject) {
        current.root = project;
        current.view?.webContents.stop();
        current.state = { ...emptyBrowserState };
      }
      if (!url || !allowed(url, project)) {
        patch(current, { failure: "Этот адрес нельзя открыть во встроенном браузере." });
        return current.state;
      }
      const view = ensure(current);
      patch(current, { url, failure: undefined, loading: true });
      await view.webContents.loadURL(url).catch(() => { /* причина придёт в did-fail-load */ });
      if (differentProject && current.root === project && tabs.get(id) === current) { view.webContents.navigationHistory.clear(); sync(current); }
      return current.state;
    },
    back(id: string) { const view = tabs.get(id)?.view; if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); },
    forward(id: string) { const view = tabs.get(id)?.view; if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); },
    reload(id: string) { const current = tabs.get(id); if (current?.view) { current.state.errors = []; current.view.webContents.reload(); } },
    stop(id: string) { tabs.get(id)?.view?.webContents.stop(); },
    async external(id: string) {
      const url = tabs.get(id)?.view?.webContents.getURL();
      if (url && (/^https?:/i.test(url) || url.startsWith("file:"))) await shell.openExternal(url);
    },
    devtools(id: string) { tabs.get(id)?.view?.webContents.openDevTools({ mode: "detach" }); },
    async clearData(id: string) {
      const view = tabs.get(id)?.view;
      if (!view) return;
      await view.webContents.session.clearStorageData();
      await view.webContents.session.clearCache();
      view.webContents.reload();
    },
    clearErrors(id: string) { const current = tabs.get(id); if (current) { current.state.errors = []; emit(current); } },
    close(id: string) { const current = tabs.get(id); if (current) close(current); },
    state(id: string) { const current = tabs.get(id); return current ? { ...current.state, errors: [...current.state.errors] } : { ...emptyBrowserState }; },
    destroy() {
      for (const item of [...tabs.values()]) close(item);
      attachedTo = undefined;
    }
  };
  return host;
}
