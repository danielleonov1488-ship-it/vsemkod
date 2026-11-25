import { voiceChunk, voiceModels } from "../shared/voice";
import { VoiceService } from "./voice-service";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, Notification, powerSaveBlocker, shell, Menu } from "electron";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { activeOffers, rankedModels } from "../shared/catalog";
import { keyIdSchema, personalProviders, remoteModelsSchema } from "../shared/providers";
import type { ChatEvent, ConnectEvent, Conversation, McpConfig, McpEntry, Notice, Preferences, SubscriptionId } from "../shared/api";
import { accessModes } from "../shared/workspace";
import { Attachments, attachmentLimit } from "./attachments";
import { chatMarkdown } from "./chat-export";
import { migratePreferences, preferencesSchema } from "./preferences";
import { projectPath } from "./engine/revert-files";
import { CatalogService } from "./catalog-service";
import { ClipboardWatch } from "./clipboard-watch";
import { ConnectService } from "./connect-service";
import type { NativeModel } from "./engine/adapter";
import { EngineService, enableOpenCodeZenFree, engineBinary } from "./engine/service";
import { KeyStore } from "./key-store";
import { Router } from "./router";
import { ProviderHealth } from "./router/health";
import { readJson, writeJson } from "./storage";
import { createUpdates } from "./updates";

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(here, "../renderer/index.html");
const rendererUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererFile).href;
const dataOverride = !app.isPackaged && process.env.VSEMKOD_DEV_DATA ? resolve(process.env.VSEMKOD_DEV_DATA) : undefined;
if (dataOverride) {
  mkdirSync(dataOverride, { recursive: true });
  app.setPath("userData", dataOverride);
}

const subscriptionId = z.enum(["github-copilot", "openai"]);
const connectionId = z.union([keyIdSchema, subscriptionId]);
const dialogId = z.uuid();
const id = z.string().min(1).max(250);
const localPath = z.string().min(1).max(32_768).refine(isAbsolute);
const mcpConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), command: z.array(z.string().min(1)).min(1).max(64), environment: z.record(z.string(), z.string()).optional(), disabled: z.boolean().optional() }),
  z.object({ type: z.literal("remote"), url: z.url({ protocol: /^https?$/ }), headers: z.record(z.string(), z.string()).optional(), disabled: z.boolean().optional() })
]);
const chatActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename"), title: z.string().trim().min(1).max(120) }),
  z.object({ type: z.enum(["pin", "archive"]), value: z.boolean() }),
  z.object({ type: z.enum(["fork", "delete"]) })
]);
const turnSchema = z.object({ access: z.enum(accessModes).optional(), variant: id.optional(), compact: z.boolean().optional(), replayMessageId: id.optional(),
  command: z.object({ name: id, args: z.string().max(100_000) }).optional(), skill: id.optional() });
const customInput = z.object({ key: z.string().trim().min(1).max(4096), baseUrl: z.string().trim().max(4096) });
const nativeBackground = () => nativeTheme.shouldUseDarkColors ? "#0f1112" : "#F5F4F0";
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
    frame: false, show: false, backgroundColor: nativeBackground(),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const created = window;
  const applyTheme = () => created.setBackgroundColor(nativeBackground());
  nativeTheme.on("updated", applyTheme);
  created.on("closed", () => nativeTheme.off("updated", applyTheme));
  const contents = window.webContents;
  contents.session.setPermissionCheckHandler((page, permission, _origin, details) =>
    page === contents && contents.getURL() === rendererUrl && permission === "media" &&
    details.isMainFrame && details.mediaType === "audio");
  contents.session.setPermissionRequestHandler((page, permission, callback, details) =>
    callback(page === contents && permission === "media" && contents.getURL() === rendererUrl &&
      details.isMainFrame && details.requestingUrl === rendererUrl && "mediaTypes" in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio"));
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
  contents.on("render-process-gone", () => cancelConnections?.());
  window.on("closed", () => { cancelConnections?.(); window = undefined; });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(rendererFile);
}

async function start() {
  const data = app.getPath("userData");
  const resources = app.isPackaged ? process.resourcesPath : join(here, "../../resources");
  const defaultDirectory = join(dataOverride ?? app.getPath("documents"), "vsemkod Projects");
  const settingsPath = join(data, "preferences.json");
  let preferences: Preferences = migratePreferences(await readJson(settingsPath, preferencesSchema.partial()) ?? {}, defaultDirectory);
  nativeTheme.themeSource = preferences.theme;
  Menu.setApplicationMenu(null);
  try {
    await mkdir(preferences.directory, { recursive: true });
    preferences.directory = await realpath(preferences.directory);
  } catch {
    await mkdir(defaultDirectory, { recursive: true });
    preferences.directory = await realpath(defaultDirectory);
  }
  const projectsPath = join(data, "projects.json");
  let recentProjects = await readJson(projectsPath, z.array(localPath)) ?? [];
  const projects = new Set([preferences.directory, ...recentProjects]);
  let projectWrites = Promise.resolve();
  const attachments = new Attachments(join(data, "attachments"));
  const mcpPath = join(data, "mcp.json");
  let mcp: Record<string, McpConfig> = await readJson(mcpPath, z.record(z.string(), mcpConfig)) ?? {};
  let activeSession: string | undefined;
  let turnInterrupted = false;
  let power: number | undefined;
  function syncPower() {
    if (activeSession && preferences.keepAwake && power === undefined) power = powerSaveBlocker.start("prevent-app-suspension");
    if ((!activeSession || !preferences.keepAwake) && power !== undefined) { powerSaveBlocker.stop(power); power = undefined; }
  }
  function announce(title: string, body: string) {
    if (!preferences.notifications || window?.isFocused() || !Notification.isSupported()) return;
    const notification = new Notification({ title, body, silent: !preferences.notificationSound });
    notification.on("click", () => { window?.restore(); window?.focus(); });
    notification.show();
  }
  const conversations = new Map<string, Conversation>();
  const keys = new KeyStore(join(data, "keys.json"));
  await keys.load();
  const voice = new VoiceService(data, join(resources, "voice", process.platform + "-" + process.arch),
    join(here, "voice-worker.js"), app.isPackaged ? join(resources, "voice-benchmark.wav") : join(resources, "../tests/fixtures/voice-en.wav"),
    () => keys.get("groq-api"), event => broadcast("voice:event", event));
  const connections = new ConnectService(keys);
  let subscriptions: SubscriptionId[] = [];
  let nativeModels: NativeModel[] = [];
  const personalModels = () => connections.personalRoutes().map(({ model }) => model);
  const health = new ProviderHealth(join(data, "usage.json"));
  await health.load();
  const state = () => ({
    catalog: catalog.current, connected: connections.connected(catalog.current), personal: connections.connectedPersonal(), subscriptions,
    personalModels: [...personalModels(), ...nativeModels.filter(({ model }) => model.providerId !== "opencode").map(({ model }) => model)],
    zenModels: nativeModels.filter(({ model }) => model.providerId === "opencode").map(({ model }) => model),
    latencies: health.latencies()
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
  const router = new Router({
    catalog: () => catalog.current,
    key: providerId => connections.key(providerId),
    personal: () => connections.personalRoutes(),
    health,
    onRoute: route => broadcast("chat:event", { type: "route", ...route } satisfies ChatEvent)
  });
  await router.start();
  console.info("[router] Запущен: " + router.baseUrl);
  const engine = new EngineService(engineBinary(resources), join(data, "opencode"), () => catalog.current, router,
    event => {
      broadcast("chat:event", event);
      if (event.type === "permission" || event.type === "question") announce("Агент ждёт ответа", conversations.get(event.sessionId)?.title ?? "vsemkod");
    }, personalModels, () => ({ agentSteps: preferences.agentSteps, webSearch: preferences.webSearch, mcp }));
  const terminals = new Map<string, Awaited<ReturnType<EngineService["openTerminal"]>>>();
  const updates = createUpdates(update => broadcast("updates:ready", update));
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
    voice.cancel();
    watching?.watch.close();
    watching = undefined;
    for (const { controller } of attempts.values()) controller.abort();
  };
  cancelConnections = cancelAll;
  teardown = async () => {
    cancelAll();
    voice.pause();
    catalog.stop();
    updates.stop();
    activeSession = undefined;
    syncPower();
    await Promise.allSettled([...terminals.values()].map(terminal => terminal.close()));
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

  handle("app:initial", z.tuple([]), () => ({ ...state(), projects: recentProjects, preferences, version: app.getVersion(), update: updates.ready }));
  handle("updates:check", z.tuple([]), () => updates.check());
  handle("updates:apply", z.tuple([]), () => updates.apply());
  handle("projects:choose", z.tuple([]), async () => {
    const choice = await dialog.showOpenDialog(window!, {
      title: "Выбрать папку проекта", defaultPath: preferences.directory, properties: ["openDirectory", "createDirectory"]
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const directory = await realpath(choice.filePaths[0]);
    const write = projectWrites.then(async () => {
      const next = [directory, ...recentProjects.filter(path => path !== directory)];
      await writeJson(projectsPath, next);
      recentProjects = next;
      projects.add(directory);
    });
    projectWrites = write.catch(() => {});
    await write;
    return directory;
  });
  handle("projects:attach", z.tuple([localPath]), async ([directory]) => {
    project(directory);
    const choice = await dialog.showOpenDialog(window!, {
      title: "Прикрепить файлы", defaultPath: directory, properties: ["openFile", "multiSelections"]
    });
    if (choice.canceled) return [];
    return Promise.all(choice.filePaths.slice(0, 10).map(path => attachments.add(directory, { path, name: basename(path), mime: "" })));
  });
  let settingsQueue = Promise.resolve();
  function savePreferences(patch: Partial<Preferences>) {
    if (patch.directory) project(patch.directory);
    const write = settingsQueue.then(async () => {
      const next = { ...preferences, ...patch };
      if (next.defaultAccess === "full" && !next.fullAccessConfirmed) throw new Error("Подтвердите полный доступ.");
      await writeJson(settingsPath, next);
      preferences = next;
      nativeTheme.themeSource = next.theme;
      syncPower();
      if (patch.catalogUpdates === true) catalog.start();
      if (patch.catalogUpdates === false) catalog.stop();
      return preferences;
    });
    settingsQueue = write.then(() => {}, () => {});
    return write;
  }
  handle("app:preferences", z.tuple([preferencesSchema.partial()]), ([patch]) => {
    if (patch.voiceGroq && !keys.get("groq-api")) throw new Error("Сначала подключите Groq.");
    return savePreferences(patch);
  });
  handle("voice:status", z.tuple([]), () => voice.status());
  handle("voice:download", z.tuple([z.enum(voiceModels), z.boolean(), z.boolean()]), ([model, consent, vadOnly]) =>
    voice.download(model, consent, vadOnly));
  handle("voice:pause", z.tuple([]), () => voice.pause());
  handle("voice:remove", z.tuple([z.enum(voiceModels)]), ([model]) => voice.remove(model));
  handle("voice:start", z.tuple([dialogId]), ([id]) => voice.start(id, preferences));
  handle("voice:audio", z.tuple([dialogId, z.instanceof(ArrayBuffer).refine(pcm =>
    pcm.byteLength > 0 && pcm.byteLength <= voiceChunk * 2 && pcm.byteLength % 2 === 0)]), ([id, pcm]) => voice.audio(id, pcm));
  handle("voice:stop", z.tuple([dialogId]), ([id]) => voice.stop(id));
  handle("voice:cancel", z.tuple([dialogId]), ([id]) => voice.cancel(id));
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
  const keyInput = z.object({ key: z.string().trim().min(1).max(4096), baseUrl: z.string().trim().max(4096).optional(), models: remoteModelsSchema.optional() }).strict();
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
        await connections.manual(provider, input.key, input.baseUrl, signal, input.models);
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
    if (provider === "groq-api") { voice.cancel(); await savePreferences({ voiceGroq: false }); }
    health.reset(provider);
    return publishState();
  });
  handle("chat:list", z.tuple([localPath.optional()]), async ([directory]) => {
    if (directory) project(directory);
    const list = await (await engine.ready()).list(directory);
    list.forEach(chat => { conversations.set(chat.id, chat); projects.add(chat.directory); });
    return list;
  });
  handle("chat:create", z.tuple([localPath, z.string().trim().min(1).max(120)]), async ([directory, title]) => {
    project(directory);
    const chat = await (await engine.ready()).create(directory, title);
    conversations.set(chat.id, chat);
    return chat;
  });
  handle("chat:action", z.tuple([id, chatActionSchema]), async ([session, action]) => {
    conversation(session);
    if (activeSession === session) throw new Error("Сначала остановите агента.");
    const chat = await (await engine.ready()).chatAction(session, action);
    if (chat) conversations.set(chat.id, chat);
    else conversations.delete(session);
    return chat;
  });
  handle("chat:history", z.tuple([id]), ([session]) => engine.history(session, conversation(session).directory));
  handle("chat:revert", z.tuple([id, id.optional()]), ([session, message]) => engine.revert(session, conversation(session).directory, message));
  handle("chat:revert-file", z.tuple([id, id]), ([session, file]) => engine.revertFile(session, conversation(session).directory, file));
  handle("chat:export", z.tuple([id.optional()]), async ([session]) => {
    const found = session ? [conversation(session)] : await (await engine.ready()).list();
    if (!found.length) return 0;
    const filename = (chat: Conversation) => (chat.title.replace(/[^\p{L}\p{N}_ -]/gu, "_").trim().slice(0, 65) || "Чат") + "-" + chat.id.slice(-12) + ".md";
    const document = async (chat: Conversation) => chatMarkdown(chat.title, (await engine.history(chat.id, chat.directory)).parts);
    if (session) {
      const selection = await dialog.showSaveDialog(window!, { title: "Экспортировать чат", defaultPath: filename(found[0]),
        filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (selection.canceled || !selection.filePath) return 0;
      await writeFile(selection.filePath, await document(found[0]), "utf8");
      return 1;
    }
    const selection = await dialog.showOpenDialog(window!, { title: "Экспортировать все чаты", properties: ["openDirectory", "createDirectory"] });
    if (selection.canceled || !selection.filePaths[0]) return 0;
    const destination = await realpath(selection.filePaths[0]);
    const documents = await Promise.all(found.map(async chat => ({ name: filename(chat), text: await document(chat) })));
    for (const item of documents) {
      const path = join(destination, item.name);
      await writeFile(path, item.text, { flag: "wx" }).catch(error => {
        if (error.code !== "EEXIST") throw error;
        return writeFile(join(destination, item.name.replace(/\.md$/, "-" + randomUUID().slice(0, 8) + ".md")), item.text, { flag: "wx" });
      });
    }
    return documents.length;
  });
  const engineModel = (model: string) => nativeModels.find(entry => entry.model.id === model)?.upstream ?? { id: model, providerID: "vsemkod" };
  handle("chat:send", z.tuple([id, z.string().trim().max(100_000), id, z.array(dialogId).max(10), turnSchema.optional()]), async ([session, text, model, files, options]) => {
    if (activeSession) throw new Error("Агент уже отвечает.");
    const chat = conversation(session);
    const connected = connections.connected(catalog.current);
    const available = rankedModels(catalog.current).filter(entry =>
      entry.tier !== "basic" && activeOffers(catalog.current, entry.id).some(({ offer, provider }) => offer.supportsTools && connected.includes(provider.id)));
    const native = nativeModels.find(entry => entry.model.id === model);
    const details = native?.model ?? personalModels().find(entry => entry.id === model);
    const catalogModel = available.find(entry => entry.id === model);
    if (!details && !(model === "auto" ? available.length : catalogModel)) {
      throw new Error("Эта модель недоступна. Выберите другую или подключите провайдера.");
    }
    if (!text && !files.length && !options?.compact && !options?.replayMessageId) throw new Error("Введите сообщение.");
    const access = options?.access ?? preferences.defaultAccess;
    if (access === "full" && !preferences.fullAccessConfirmed) throw new Error("Подтвердите полный доступ в настройках.");
    activeSession = session;
    turnInterrupted = false;
    syncPower();
    try {
      const paths = await attachments.resolve(chat.directory, files, details?.vision ?? catalogModel?.capabilities.includes("vision") ?? false);
      if (turnInterrupted) return { stopped: true, changes: (await engine.history(session, chat.directory)).changes };
      const result = await engine.send(session, chat.directory, text, model, preferences.auto, paths, native?.upstream, { ...options, access });
      if (!result.stopped) announce("Агент закончил работу", chat.title);
      return result;
    } finally {
      activeSession = undefined;
      syncPower();
    }
  });
  const projectFile = z.string().min(1).max(32768);
  const attachmentInput = z.object({
    name: projectFile, mime: z.string().max(250), path: localPath.optional(),
    data: z.instanceof(Uint8Array).refine(data => data.byteLength <= attachmentLimit).optional()
  }).refine(value => Boolean(value.path || value.data));
  handle("projects:capture", z.tuple([localPath, z.array(attachmentInput).max(10)]), ([directory, items]) =>
    Promise.all(items.map(item => attachments.add(project(directory), item))));
  handle("projects:tools", z.tuple([localPath]), async ([directory]) => (await engine.ready()).tools(project(directory)));
  handle("projects:find", z.tuple([localPath, z.string().max(512)]), async ([directory, query]) =>
    (await engine.ready()).findFiles(project(directory), query));
  handle("projects:files", z.tuple([localPath, projectFile.optional()]), async ([directory, path]) => {
    project(directory);
    if (path) await projectPath(directory, path);
    return (await engine.ready()).listFiles(directory, path);
  });
  handle("projects:read", z.tuple([localPath, projectFile]), async ([directory, path]) => {
    const file = await projectPath(project(directory), path);
    const info = await stat(file);
    if (!info.isFile() || info.size > 512 * 1024) throw new Error("Текстовый просмотр доступен для файлов размером до 512 КБ.");
    return (await engine.ready()).readFile(directory, path);
  });
  handle("chat:question", z.tuple([id, id, z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()]),
    async ([session, form, answer]) => {
      conversation(session);
      if (activeSession !== session) throw new Error("Вопрос уже закрыт.");
      await (await engine.ready()).answerQuestion(session, form, answer);
    });
  handle("models:variants", z.tuple([localPath, id]), async ([directory, model]) =>
    (await (await engine.ready()).modelInfo(project(directory), engineModel(model)))?.variants.map(item => item.id) ?? []);
  handle("models:custom", z.tuple([customInput.optional()]), ([input]) => connections.customModels(input));
  handle("models:custom-save", z.tuple([remoteModelsSchema.min(1)]), async ([models]) => {
    await connections.saveCustomModels(models);
    return publishState();
  });
  const rulesPath = join(engine.configDirectory, "AGENTS.md");
  let rulesQueue = Promise.resolve();
  handle("agent:rules", z.tuple([]), () => readFile(rulesPath, "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return "";
  }));
  handle("agent:rules-save", z.tuple([z.string().max(200_000)]), ([text]) => {
    const writing = rulesQueue.then(async () => {
      await mkdir(engine.configDirectory, { recursive: true });
      await writeFile(rulesPath, text, "utf8");
    });
    rulesQueue = writing.catch(() => {});
    return writing;
  });
  async function mcpList(directory: string): Promise<McpEntry[]> {
    const list = await (await engine.ready()).mcpList(project(directory));
    return list.map(({ name, status }) => ({
      name, status: status.status, error: "error" in status ? status.error : undefined, managed: Object.hasOwn(mcp, name)
    }));
  }
  handle("mcp:list", z.tuple([localPath]), ([directory]) => mcpList(directory));
  let mcpQueue: Promise<unknown> = Promise.resolve();
  const mcpName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
  handle("mcp:change", z.tuple([localPath, mcpName, z.enum(["put", "delete", "enable", "disable", "check"]), mcpConfig.optional()]),
    ([directory, name, action, config]) => {
      project(directory);
      const task = mcpQueue.then(async () => {
        if (activeSession) throw new Error("Дождитесь окончания работы агента.");
        if (action === "check") {
          await (await engine.ready()).mcpCheck(directory, name, mcp[name]);
          return mcpList(directory);
        }
        const next = { ...mcp };
        if (action === "put" && config) next[name] = config;
        else if (action === "delete" && Object.hasOwn(next, name)) delete next[name];
        else if ((action === "enable" || action === "disable") && Object.hasOwn(next, name)) {
          next[name] = { ...next[name], disabled: action === "disable" };
        } else throw new Error("Сервер MCP не найден.");
        await writeJson(mcpPath, next);
        mcp = next;
        return mcpList(directory);
      });
      mcpQueue = task.catch(() => {});
      return task;
    });
  handle("app:folder", z.tuple([z.enum(["data", "logs", "skills"])]), async ([folder]) => {
    const path = folder === "data" ? data : folder === "logs" ? join(data, "opencode", "data", "opencode", "log") : join(engine.configDirectory, "skills");
    await mkdir(path, { recursive: true });
    const failure = await shell.openPath(path);
    if (failure) throw new Error("Не удалось открыть папку.");
  });
  handle("catalog:refresh", z.tuple([]), async () => { await catalog.refresh(); return state(); });
  handle("app:copy", z.tuple([z.string().max(2_000_000)]), ([text]) => clipboard.writeText(text));
  handle("catalog:clear", z.tuple([]), () => catalog.clearCache());
  handle("terminal:open", z.tuple([localPath, dialogId]), async ([directory, token]) => {
    if (terminals.has(token)) return;
    const terminal = await engine.openTerminal(project(directory), text => broadcast("terminal:event", { id: token, text }), () => {
      terminals.delete(token);
      broadcast("terminal:event", { id: token, closed: true });
    });
    terminals.set(token, terminal);
  });
  handle("terminal:input", z.tuple([dialogId, z.string().max(100_000)]), ([token, input]) => terminals.get(token)?.input(input));
  handle("terminal:resize", z.tuple([dialogId, z.int().min(2).max(400), z.int().min(2).max(200)]), ([token, cols, rows]) => terminals.get(token)?.resize(cols, rows));
  handle("terminal:close", z.tuple([dialogId]), async ([token]) => {
    const terminal = terminals.get(token);
    terminals.delete(token);
    await terminal?.close();
  });
  handle("chat:stop", z.tuple([id]), ([session]) => {
    if (activeSession === session) turnInterrupted = true;
    return engine.stop(session);
  });
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
  updates.start();
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
