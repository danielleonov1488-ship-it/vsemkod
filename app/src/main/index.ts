import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { mkdirSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { activeOffers, rankedModels } from "../shared/catalog";
import { keyIdSchema, personalProviders } from "../shared/providers";
import type { ChatEvent, ConnectEvent, Conversation, Notice, Preferences, SubscriptionId } from "../shared/api";
import { CatalogService } from "./catalog-service";
import { ClipboardWatch } from "./clipboard-watch";
import { ConnectService } from "./connect-service";
import type { NativeModel } from "./engine/adapter";
import { inside } from "./engine/diff-tracker";
import { EngineService, enableOpenCodeZenFree, engineBinary } from "./engine/service";
import { KeyStore } from "./key-store";
import { Router } from "./router";
import { ProviderHealth } from "./router/health";
import { readJson, writeJson } from "./storage";

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(here, "../renderer/index.html");
const rendererUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererFile).href;
const dataOverride = !app.isPackaged && process.env.VSEMKOD_DEV_DATA ? resolve(process.env.VSEMKOD_DEV_DATA) : undefined;
if (dataOverride) {
  mkdirSync(dataOverride, { recursive: true });
  app.setPath("userData", dataOverride);
}

const preferencesSchema = z.object({
  directory: z.string().min(1), auto: z.boolean(), clipboard: z.boolean(), catalogUpdates: z.boolean()
}).strict();
const subscriptionId = z.enum(["github-copilot", "openai"]);
const connectionId = z.union([keyIdSchema, subscriptionId]);
const dialogId = z.uuid();
const id = z.string().min(1).max(250);
const localPath = z.string().min(1).max(32_768).refine(isAbsolute);
let window: BrowserWindow | undefined;
let teardown: (() => Promise<void>) | undefined;
let cancelConnections: (() => void) | undefined;
let quitting = false;

async function openExternal(raw: string): Promise<void> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Можно открыть только ссылки HTTP и HTTPS.");
  }
  await shell.openExternal(url.href);
}

function broadcast(channel: string, payload: unknown) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function createWindow() {
  window = new BrowserWindow({
    title: "vsemkod",
    width: 1400, height: 900, minWidth: 780, minHeight: 560,
    frame: false, show: false, backgroundColor: "#0f1112",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const contents = window.webContents;
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler((_page, _permission, callback) => callback(false));
  contents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url !== rendererUrl) void openExternal(url).catch(() => {});
  });
  window.once("ready-to-show", () => window?.show());
  contents.on("did-navigate", () => cancelConnections?.());
  window.on("closed", () => { cancelConnections?.(); window = undefined; });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(rendererFile);
}

async function start() {
  const data = app.getPath("userData");
  const resources = app.isPackaged ? process.resourcesPath : join(here, "../../resources");
  const defaultDirectory = join(dataOverride ?? app.getPath("documents"), "vsemkod Projects");
  const settingsPath = join(data, "preferences.json");
  let preferences: Preferences = {
    directory: defaultDirectory, auto: true, clipboard: false, catalogUpdates: true,
    ...await readJson(settingsPath, preferencesSchema.partial())
  };
  try {
    await mkdir(preferences.directory, { recursive: true });
    preferences.directory = await realpath(preferences.directory);
  } catch {
    await mkdir(defaultDirectory, { recursive: true });
    preferences.directory = await realpath(defaultDirectory);
  }
  const projects = new Set([preferences.directory]);
  const attachments = new Set<string>();
  const conversations = new Map<string, Conversation>();
  const keys = new KeyStore(join(data, "keys.json"));
  await keys.load();
  const connections = new ConnectService(keys);
  let subscriptions: SubscriptionId[] = [];
  let nativeModels: NativeModel[] = [];
  const personalModels = () => connections.personalRoutes().map(({ model }) => model);
  const state = () => ({
    catalog: catalog.current, connected: connections.connected(catalog.current), personal: connections.connectedPersonal(), subscriptions,
    personalModels: [...personalModels(), ...nativeModels.filter(({ model }) => model.providerId !== "opencode").map(({ model }) => model)],
    zenModels: nativeModels.filter(({ model }) => model.providerId === "opencode").map(({ model }) => model)
  });
  const publishState = () => {
    const next = state();
    broadcast("catalog:update", next);
    return next;
  };
  const catalog = new CatalogService(data, join(resources, "catalog.json"), (current, news) => {
    publishState();
    if (!preferences.catalogUpdates) return;
    for (const change of news) {
      const model = current.models.find(model => model.id === change.modelId);
      const provider = current.providers.find(provider => provider.id === change.providerId);
      if (!model || !provider) continue;
      const notice: Notice = {
        text: "Новая раздача: " + model.name + " бесплатно у " + provider.name,
        connect: provider.auth.type === "none" ? undefined : { modelId: model.id, providerId: provider.id }
      };
      broadcast("notice", notice);
    }
  });
  await catalog.loadInitial();
  const health = new ProviderHealth(join(data, "usage.json"));
  await health.load();
  const router = new Router({
    catalog: () => catalog.current,
    key: providerId => connections.key(providerId),
    personal: () => connections.personalRoutes(),
    health,
    onRoute: route => broadcast("chat:event", { type: "route", ...route } satisfies ChatEvent)
  });
  await router.start();
  const engine = new EngineService(engineBinary(resources), join(data, "opencode"), () => catalog.current, router,
    event => broadcast("chat:event", event), personalModels);
  const attempts = new Map<string, { provider: z.infer<typeof connectionId>; controller: AbortController; done: Promise<unknown> }>();
  let watching: { id: string; watch: ClipboardWatch } | undefined;
  let nativeQueue = Promise.resolve();
  function refreshNative(waitFor?: SubscriptionId) {
    const refresh = nativeQueue.then(() => engine.withAuth(async client => {
      const active = (await client.nativeConnections(preferences.directory)).flatMap(entry => {
        const parsed = subscriptionId.safeParse(entry.id);
        return parsed.success && entry.connections.some(item => item.type === "credential" && !item.status) ? [parsed.data] : [];
      });
      let models: NativeModel[] = [];
      if (active.length || enableOpenCodeZenFree) {
        for (let retry = 0; retry < 8; retry++) {
          models = await client.nativeModels(preferences.directory, active, enableOpenCodeZenFree);
          if ((!waitFor || models.some(({ model }) => model.providerId === waitFor)) &&
            (!enableOpenCodeZenFree || models.some(({ model }) => model.providerId === "opencode"))) break;
          await delay(350);
        }
      }
      subscriptions = active;
      nativeModels = models;
      return publishState();
    }));
    nativeQueue = refresh.then(() => {}, () => {});
    return refresh;
  }
  const providerFor = (provider: z.infer<typeof keyIdSchema>) =>
    personalProviders.find(item => item.id === provider) ?? catalog.current.providers.find(item => item.id === provider);
  const signalConnect = (event: ConnectEvent) => broadcast("connect:event", event);
  const cancelAll = () => {
    watching?.watch.close();
    watching = undefined;
    for (const { controller } of attempts.values()) controller.abort();
  };
  cancelConnections = cancelAll;
  teardown = async () => {
    cancelAll();
    catalog.stop();
    await engine.close();
    await router.close();
  };

  function handle<A extends z.ZodType, R>(name: string, schema: A, run: (args: z.output<A>) => R) {
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== rendererUrl) throw new Error("Источник запроса не разрешён.");
      return run(schema.parse(args));
    });
  }
  function project(directory: string) {
    if (!projects.has(directory)) throw new Error("Сначала выберите папку проекта.");
    return directory;
  }
  function conversation(sessionId: string) {
    const session = conversations.get(sessionId);
    if (!session) throw new Error("Чат не найден.");
    return session;
  }

  handle("app:initial", z.tuple([]), () => ({ ...state(), preferences, version: app.getVersion() }));
  handle("projects:choose", z.tuple([]), async () => {
    const choice = await dialog.showOpenDialog(window!, {
      title: "Выбрать папку проекта", defaultPath: preferences.directory, properties: ["openDirectory", "createDirectory"]
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const directory = await realpath(choice.filePaths[0]);
    projects.add(directory);
    return directory;
  });
  handle("projects:attach", z.tuple([localPath]), async ([directory]) => {
    project(directory);
    const choice = await dialog.showOpenDialog(window!, {
      title: "Прикрепить файлы из проекта", defaultPath: directory, properties: ["openFile", "multiSelections"]
    });
    if (choice.canceled) return [];
    const selected = await Promise.all(choice.filePaths.slice(0, 10).map(file => realpath(file)));
    if (selected.some(file => !inside(directory, file))) throw new Error("Выберите файлы внутри папки проекта.");
    for (const file of selected) attachments.add(file);
    return selected;
  });
  let settingsQueue = Promise.resolve();
  handle("app:preferences", z.tuple([preferencesSchema.partial()]), ([patch]) => {
    if (patch.directory) project(patch.directory);
    const write = settingsQueue.then(async () => {
      const next = { ...preferences, ...patch };
      await writeJson(settingsPath, next);
      preferences = next;
      if (patch.catalogUpdates === true) catalog.start();
      if (patch.catalogUpdates === false) catalog.stop();
      return preferences;
    });
    settingsQueue = write.then(() => {}, () => {});
    return write;
  });
  handle("connect:clipboard", z.tuple([dialogId, keyIdSchema, z.boolean()]), ([token, providerId, enabled]) => {
    const provider = providerFor(providerId);
    if (!provider?.keyPattern || ("auth" in provider && provider.auth.type !== "manual_key")) return;
    if (!enabled) {
      if (watching?.id === token) watching.watch.pause();
      return;
    }
    if (watching?.id !== token) {
      watching?.watch.close();
      watching = { id: token, watch: new ClipboardWatch(() => clipboard.readText()) };
    }
    watching.watch.enable(provider.keyPattern, key => signalConnect({ id: token, type: "clipboard", key }),
      () => signalConnect({ id: token, type: "clipboard-expired" }));
  });
  handle("connect:cancel", z.tuple([dialogId]), ([token]) => {
    const running = attempts.get(token);
    running?.controller.abort();
    if (watching?.id === token) {
      watching.watch.close();
      watching = undefined;
    }
  });
  const keyInput = z.object({ key: z.string().trim().min(1).max(4096), baseUrl: z.string().trim().max(4096).optional() }).strict();
  handle("connect:start", z.tuple([dialogId, connectionId, keyInput.optional()]), ([token, providerId, input]) => {
    if (attempts.has(token) || [...attempts.values()].some(attempt => attempt.provider === providerId && !attempt.controller.signal.aborted)) {
      throw new Error("Подключение уже запущено.");
    }
    const controller = new AbortController();
    const { signal } = controller;
    const done = Promise.resolve().then(async () => {
      if (watching?.id === token) watching.watch.pause();
      const subscription = subscriptionId.safeParse(providerId);
      if (subscription.success) {
        const provider = subscription.data;
        await engine.withAuth(client => client.signIn(preferences.directory, provider, async (url, code) => {
          if (!code) {
            try { await openExternal(url); }
            catch { throw new Error("Не удалось открыть системный браузер."); }
          }
          signalConnect({ id: token, type: "waiting", code, url: code ? url : undefined });
        }, signal));
        return refreshNative(provider);
      }
      const provider = providerFor(keyIdSchema.parse(providerId));
      if (!provider) throw new Error("Провайдер недоступен.");
      if ("auth" in provider && provider.auth.type === "oauth_pkce") {
        await connections.oauth(provider, async url => {
          try { await openExternal(url); }
          catch { throw new Error("Не удалось открыть системный браузер."); }
          signalConnect({ id: token, type: "waiting" });
        }, signal);
      } else if (input && (!("auth" in provider) || provider.auth.type === "manual_key")) {
        await connections.manual(provider, input.key, input.baseUrl, signal);
      } else throw new Error("Введите ключ провайдера.");
      health.reset(provider.id);
      return publishState();
    }).catch(error => {
      if (signal.aborted) throw new Error("Подключение отменено.");
      throw error;
    }).finally(() => { attempts.delete(token); });
    attempts.set(token, { provider: providerId, controller, done });
    return done;
  });
  handle("connect:disconnect", z.tuple([connectionId]), async ([provider]) => {
    const pending = [...attempts.values()].filter(attempt => attempt.provider === provider);
    for (const attempt of pending) attempt.controller.abort();
    await Promise.allSettled(pending.map(attempt => attempt.done));
    if (provider === "openai" || provider === "github-copilot") {
      await engine.withAuth(client => client.disconnect(preferences.directory, provider));
      return refreshNative();
    }
    await connections.disconnect(provider);
    health.reset(provider);
    return publishState();
  });
  handle("chat:list", z.tuple([localPath]), async ([directory]) => {
    project(directory);
    const client = await engine.ready();
    const list = await client.list(directory);
    list.forEach(chat => conversations.set(chat.id, chat));
    return list;
  });
  handle("chat:create", z.tuple([localPath, z.string().trim().min(1).max(120)]), async ([directory, title]) => {
    project(directory);
    const client = await engine.ready();
    const chat = await client.create(directory, title);
    conversations.set(chat.id, chat);
    return chat;
  });
  handle("chat:history", z.tuple([id]), ([session]) => engine.history(session, conversation(session).directory));
  handle("chat:send", z.tuple([id, z.string().trim().min(1).max(100_000), id, z.array(localPath).max(10)]), async ([session, text, model, files]) => {
    const chat = conversation(session);
    const connected = connections.connected(catalog.current);
    const available = rankedModels(catalog.current).filter(entry =>
      entry.tier !== "basic" && activeOffers(catalog.current, entry.id).some(({ offer, provider }) => offer.supportsTools && connected.includes(provider.id)));
    const native = nativeModels.find(entry => entry.model.id === model);
    if (!native && !personalModels().some(entry => entry.id === model) &&
      !(model === "auto" ? available.length : available.some(entry => entry.id === model))) {
      throw new Error("Эта модель недоступна. Выберите другую или подключите провайдера.");
    }
    for (const file of files) {
      if (!attachments.has(file) || !inside(chat.directory, await realpath(file)) || (await stat(file)).size > 2 * 1024 * 1024) {
        throw new Error("Можно прикрепить файлы из проекта размером до 2 МБ.");
      }
    }
    return engine.send(session, chat.directory, text, model, preferences.auto, files, native?.upstream);
  });
  handle("chat:stop", z.tuple([id]), ([session]) => engine.stop(session));
  handle("chat:answer", z.tuple([id, id, z.enum(["once", "always", "reject"])]), ([session, permission, decision]) =>
    engine.answer(session, permission, decision));
  handle("app:external", z.tuple([z.string().url().max(4096)]), ([url]) => openExternal(url));
  handle("app:window", z.tuple([z.enum(["minimize", "maximize", "close"])]), ([action]) => {
    if (action === "minimize") window?.minimize();
    if (action === "maximize") {
      if (window?.isMaximized()) window.unmaximize();
      else window?.maximize();
    }
    if (action === "close") window?.close();
  });
  createWindow();
  if (preferences.catalogUpdates) catalog.start();
  void refreshNative().catch(() => {});
}

if (!dataOverride && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox("Ошибка запуска vsemkod", error instanceof Error ? error.message : "Не удалось запустить приложение.");
    app.quit();
  });
  app.on("activate", () => { if (!window && teardown) createWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", event => {
    if (!teardown || quitting) return;
    event.preventDefault();
    quitting = true;
    void teardown().finally(() => app.quit());
  });
}
