import { voiceChunk, voiceModels } from "../shared/voice";
import { VoiceService } from "./voice-service";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Menu } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackgroundTasks } from "./background-tasks";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { activeOffers, rankedModels } from "../shared/catalog";
import { keyIdSchema, personalProviders, remoteModelsSchema } from "../shared/providers";
import type { ChatEvent, ConnectEvent, Conversation, McpEntry, Notice, Preferences, SubscriptionId } from "../shared/api";
import { accessModes } from "../shared/workspace";
import { Attachments, attachmentLimit } from "./attachments";
import { chatMarkdown } from "./chat-export";
import { migratePreferences, preferencesSchema } from "./preferences";
import { checkedFile, previewFile } from "./file-preview";
import { projectPath } from "./engine/revert-files";
import { CatalogService } from "./catalog-service";
import { ClipboardWatch, keyFromClipboard } from "./clipboard-watch";
import { ConnectService, customProviderIdSchema, customSelectionSchema } from "./connect-service";
import type { NativeModel } from "./engine/adapter";
import { EngineService, enableOpenCodeZenFree, engineBinary } from "./engine/service";
import { KeyStore } from "./key-store";
import { Connectors, mcpConfig, mcpName } from "./connectors";
import { SkillsCatalog, skillId } from "./skills-catalog";
import { Router } from "./router";
import { ProviderHealth } from "./router/health";
import { readJson, writeJson } from "./storage";
import { createUpdates } from "./updates";
import { projectTemplates, templateFolderName } from "../shared/templates";
import { createTray } from "./tray";
import { createBrowserHost } from "./browser-view";
import { registerWorktreeIpc, Worktrees } from "./worktrees";

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(here, "../renderer/index.html");
const rendererUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererFile).href;
const dataOverride = !app.isPackaged && process.env.VSEMKOD_DEV_DATA ? resolve(process.env.VSEMKOD_DEV_DATA) : undefined;
if (dataOverride) {
  mkdirSync(dataOverride, { recursive: true });
  app.setPath("userData", dataOverride);
}
// Без AppUserModelID Windows молча не показывает уведомления установленного приложения.
if (process.platform === "win32") app.setAppUserModelId("ru.vsemkod.app");

const subscriptionId = z.enum(["github-copilot", "openai", "xai"]);
const connectionId = z.union([keyIdSchema, subscriptionId]);
const dialogId = z.uuid();
const id = z.string().min(1).max(250);
const modelId = z.string().min(1).max(514);
const localPath = z.string().min(1).max(32_768).refine(isAbsolute);
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
let exitConfirmed = false;
let approveExit: (() => boolean) | undefined;
// Возвращает true, если окно нужно спрятать в трей вместо закрытия.
let hideOnClose: (() => boolean) | undefined;
let startHidden = process.argv.includes("--hidden");
const exec = promisify(execFile);

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
    width: 1400, height: 900, minWidth: 900, minHeight: 560,
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
  window.once("ready-to-show", () => { if (!startHidden) window?.show(); startHidden = false; });
  contents.on("did-navigate", () => cancelConnections?.());
  contents.on("render-process-gone", () => cancelConnections?.());
  window.on("focus", () => { if (window && !window.isDestroyed()) window.flashFrame(false); });
  window.on("close", event => {
    if (quitting) return;
    if (hideOnClose?.()) { event.preventDefault(); created.hide(); return; }
    if (approveExit && !approveExit()) event.preventDefault();
  });
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
  // После тихого автообновления из трея приложение возвращается в трей, а не открывает окно.
  const relaunchMarker = join(data, "relaunch-hidden");
  try {
    if (Date.now() - statSync(relaunchMarker).mtimeMs < 10 * 60_000) startHidden = true;
    rmSync(relaunchMarker, { force: true });
  } catch { /* маркера нет */ }
  try {
    await mkdir(preferences.directory, { recursive: true });
    preferences.directory = await realpath(preferences.directory);
  } catch {
    await mkdir(defaultDirectory, { recursive: true });
    preferences.directory = await realpath(defaultDirectory);
  }
  const projectsPath = join(data, "projects.json");
  const projectList = z.array(localPath);
  const savedProjects = await readJson(projectsPath, z.union([
    projectList.transform(recent => ({ recent, hidden: [] as string[] })),
    z.object({ recent: projectList, hidden: projectList })
  ]));
  const worktrees = await Worktrees.load(data);
  let recentProjects = (savedProjects?.recent ?? []).filter(path => !worktrees.managed(path));
  const projects = new Set([preferences.directory, ...recentProjects]);
  const hiddenProjects = new Set(savedProjects?.hidden ?? []);
  let projectWrites = Promise.resolve();
  const attachments = new Attachments(join(data, "attachments"));
  const activeSessions = new Map<string, { interrupted: boolean }>();
  let power: number | undefined;
  function syncPower() {
    if (activeSessions.size && preferences.keepAwake && power === undefined) power = powerSaveBlocker.start("prevent-app-suspension");
    if ((!activeSessions.size || !preferences.keepAwake) && power !== undefined) { powerSaveBlocker.stop(power); power = undefined; }
  }
  let visibleChat: string | undefined;
  const notifications = new Set<Notification>();
  function announce(title: string, body: string, sessionId?: string, test = false) {
    const focused = window?.isFocused();
    if (!test && (!preferences.notifications || focused && (!sessionId || visibleChat === sessionId))) return;
    if (!focused) {
      if (process.platform === "darwin") app.dock?.bounce("informational");
      else window?.flashFrame(true);
    }
    if (!Notification.isSupported()) {
      if (test) throw new Error("Системные уведомления недоступны.");
      return;
    }
    const notification = new Notification({ title, body, silent: true });
    notifications.add(notification);
    const release = () => { notifications.delete(notification); };
    const expiry = setTimeout(release, 5 * 60_000);
    expiry.unref();
    notification.once("close", () => { clearTimeout(expiry); release(); });
    notification.once("show", () => {
      if (preferences.notificationSound) broadcast("notification:sound", undefined);
    });
    notification.on("click", () => {
      if (window?.isMinimized()) window.restore();
      window?.show();
      window?.focus();
      if (sessionId) broadcast("chat:focus", sessionId);
    });
    notification.show();
  }
  const conversations = new Map<string, Conversation>();
  const sideSessions = new Map<string, {
    parent?: string; directory: string; client?: Awaited<ReturnType<EngineService["ready"]>>;
    session?: string; sending?: Promise<unknown>; closed?: boolean;
  }>();
  const sideIds = new Set<string>();
  const tasks = new BackgroundTasks(items => broadcast("tasks:update", items));
  approveExit = () => {
    if (exitConfirmed) return true;
    const count = tasks.running().length;
    if (!count) return true;
    const word = new Intl.PluralRules("ru").select(count);
    const message = word === "one" ? "Остановить " + count + " фоновую задачу и выйти?" : "Остановить " + count +
      (word === "few" ? " фоновые задачи" : " фоновых задач") + " и выйти?";
    const options = { type: "warning" as const, message, buttons: ["Остановить и выйти", "Отмена"], defaultId: 1, cancelId: 1 };
    const accepted = (window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options)) === 0;
    return (exitConfirmed = accepted);
  };
  const keys = new KeyStore(join(data, "keys.json"));
  await keys.load();
  const connectors = await Connectors.load(join(resources, "connectors.json"), join(data, "mcp.json"), keys);
  const connectorAuth = new Map<string, { cancel: AbortController; done: Promise<unknown> }>();
  const voice = new VoiceService(data, join(resources, "voice", process.platform + "-" + process.arch),
    join(here, "voice-worker.js"), app.isPackaged ? join(resources, "voice-benchmark.wav") : join(resources, "../tests/fixtures/voice-en.wav"),
    () => keys.get("groq-api"), event => broadcast("voice:event", event));
  const connections = new ConnectService(keys, join(data, "provider-models.json"));
  await connections.loadCatalogModels();
  const providerRefresh = new AbortController();
  let subscriptions: SubscriptionId[] = [];
  let nativeModels: NativeModel[] = [];
  const personalModels = () => connections.personalRoutes().map(({ model }) => model);
  const effective = () => connections.effectiveCatalog(catalog.current);
  const legacyModel = (id: string) => connections.legacyCatalogModel(catalog.current, id);
  const health = new ProviderHealth(join(data, "usage.json"));
  await health.load();
  const state = () => ({
    catalog: effective(), connected: connections.connected(catalog.current), personal: connections.connectedPersonal(), subscriptions,
    customProviders: connections.customProviders(),
    personalModels: [...personalModels(), ...nativeModels.filter(({ model }) => model.providerId !== "opencode").map(({ model }) => model)],
    zenModels: nativeModels.filter(({ model }) => model.providerId === "opencode").map(({ model }) => model),
    latencies: health.latencies(), speeds: health.speeds(), benchmarks: catalog.benchmarks,
    customProviderUrl: URL.parse(keys.profile("custom-api")?.baseUrl ?? "")?.origin
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
    catalog: effective,
    key: providerId => connections.key(providerId),
    personal: () => connections.personalRoutes(),
    customIds: () => connections.customProviders().map(provider => provider.id),
    legacyModel,
    health,
    onActivity: sessionId => engine.routerActivity(sessionId),
    onWait: event => { if (!sideIds.has(event.sessionId)) broadcast("chat:event", { type: "route-wait", ...event } satisfies ChatEvent); },
    onRoute: route => { if (!sideIds.has(route.sessionId)) broadcast("chat:event", { type: "route", ...route } satisfies ChatEvent); },
    onExhausted: event => { if (!sideIds.has(event.sessionId)) broadcast("chat:event", event); },
    onSpeed: event => { if (!sideIds.has(event.sessionId)) broadcast("chat:event", event); },
    onReplyCache: (sessionId, cachePercent) => { if (!sideIds.has(sessionId)) broadcast("chat:event", { type: "reply-cache", sessionId, cachePercent } satisfies ChatEvent); },
    onStats: stats => broadcast("router:stats", stats)
  });
  await router.start();
  console.info("[router] Запущен: " + router.baseUrl);
  // Навыки движок читает при запуске: смена номера перезапускает его, когда агент свободен.
  let skillsRevision = 0;
  const engine = new EngineService(engineBinary(resources), join(data, "opencode"), effective, router,
    event => {
      if (sideIds.has(event.sessionId)) return;
      if (event.type === "part" && event.part.kind === "tool" && event.part.background && event.part.status === "running") {
        tasks.called(event.part.id, event.sessionId, event.part.target);
      }
      broadcast("chat:event", event);
      if (event.type === "permission" || event.type === "question") announce("Агент ждёт ответа", conversations.get(event.sessionId)?.title ?? "vsemkod", event.sessionId);
    }, personalModels, () => ({ agentSteps: preferences.agentSteps, webSearch: preferences.webSearch, mcp: { servers: connectors.engineConfigs() }, skills: skillsRevision }));
  const skills = new SkillsCatalog(join(resources, "skills-catalog"), engine.configDirectory);
  engine.keepBackground = () => tasks.running().length > 0 || sideSessions.size > 0 || terminals.size > 0;
  const taskTimer = setInterval(() => {
    if (engine.runningClient) void tasks.refresh(engine.runningClient, conversations).catch(() => {});
  }, 1000);
  taskTimer.unref();
  const terminals = new Map<string, Awaited<ReturnType<EngineService["openTerminal"]>>>();
  let tray: ReturnType<typeof createTray> | undefined;
  const updates = createUpdates(update => { broadcast("updates:ready", update); tray?.update({ update }); },
    progress => { broadcast("updates:progress", progress); tray?.update({ downloading: progress }); });
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
  const refreshProviderModels = () => void connections.refreshCatalogModels(catalog.current, providerRefresh.signal)
    .then(() => { if (!providerRefresh.signal.aborted) publishState(); });
  const providerTimer = setInterval(refreshProviderModels, 6 * 60 * 60_000);
  providerTimer.unref();
  async function closeSide(token: string) {
    const entry = sideSessions.get(token);
    if (!entry) return;
    entry.closed = true;
    if (entry.session) await engine.stop(entry.session).catch(() => {});
    await entry.sending?.catch(() => {});
    if (sideSessions.get(token) !== entry) return;
    sideSessions.delete(token);
    if (entry.session && entry.client) {
      try { await entry.client.removeSide(entry.session); }
      finally { sideIds.delete(entry.session); }
    }
  }
  cancelConnections = () => {
    cancelAll();
    for (const token of sideSessions.keys()) void closeSide(token).catch(() => {});
  };
  teardown = async () => {
    cancelAll();
    for (const attempt of connectorAuth.values()) attempt.cancel.abort();
    clearInterval(taskTimer);
    await Promise.allSettled(tasks.running().map(task => tasks.stop(task.id)));
    await Promise.allSettled([...sideSessions.keys()].map(closeSide));
    voice.pause();
    catalog.stop();
    clearInterval(providerTimer);
    providerRefresh.abort();
    updates.stop();
    tray?.destroy();
    tray = undefined;
    for (const sessionId of activeSessions.keys()) void engine.stop(sessionId).catch(() => {});
    activeSessions.clear();
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
    if (worktrees.managed(directory)) {
      if (!worktrees.known(directory) || !statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error("Папка копии недоступна.");
      }
    } else if (!projects.has(directory)) throw new Error("Сначала выберите папку проекта.");
    return directory;
  }
  function conversation(sessionId: string) {
    const session = conversations.get(sessionId);
    if (!session) throw new Error("Чат не найден.");
    return session;
  }

  registerWorktreeIpc(handle, worktrees, project, directory => tasks.running().some(task => task.directory === directory));
  handle("app:initial", z.tuple([]), () => ({ ...state(), projects: recentProjects, hiddenProjects: [...hiddenProjects], preferences, version: app.getVersion(), update: updates.ready }));
  handle("router:stats", z.tuple([]), () => router.stats());
  handle("updates:check", z.tuple([]), () => updates.check());
  handle("notification:test", z.tuple([]), () => announce("Тестовое уведомление vsemkod", "Так выглядит уведомление, когда агент закончил работу.", undefined, true));
  handle("chat:visible", z.tuple([id.optional()]), ([session]) => { visibleChat = session; });
  handle("tasks:list", z.tuple([]), () => tasks.list());
  handle("tasks:start", z.tuple([localPath, z.string().trim().min(1).max(16_384), id.optional()]), async ([directory, command, session]) => {
    project(directory);
    if (session && conversation(session).directory !== directory) throw new Error("Чат находится в другом проекте.");
    await worktrees.use(directory, () => engine.withAuth(client => tasks.start(client, directory, command, session)));
  });
  handle("tasks:stop", z.tuple([id]), ([task]) => tasks.stop(task));
  handle("projects:branch", z.tuple([localPath]), async ([directory]) => {
    const cwd = project(directory);
    const options = { cwd, windowsHide: true, timeout: 2500, maxBuffer: 4096 };
    const revision = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], options)
      .catch(() => exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options)).catch(() => undefined);
    return revision?.stdout.trim() || null;
  });
  handle("updates:apply", z.tuple([]), () => updates.apply());
  // Новый проект из шаблона: папка в папке по умолчанию + AGENTS.md с правилами шаблона.
  handle("projects:template", z.tuple([z.string().regex(/^[a-z0-9-]{1,40}$/), z.string().trim().min(1).max(80)]), async ([templateId, name]) => {
    const template = projectTemplates.find(item => item.id === templateId);
    if (!template) throw new Error("Шаблон не найден.");
    const base = templateFolderName(name);
    let directory = join(preferences.directory, base);
    for (let index = 2; index < 100; index++) {
      try { await stat(directory); directory = join(preferences.directory, base + "-" + index); } catch { break; }
    }
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "AGENTS.md"), template.agents, { encoding: "utf8", flag: "wx" }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    directory = await realpath(directory);
    const write = projectWrites.then(async () => {
      const next = [directory, ...recentProjects.filter(path => path !== directory)];
      await writeJson(projectsPath, { recent: next, hidden: [...hiddenProjects].filter(path => path !== directory) });
      recentProjects = next;
      projects.add(directory);
      hiddenProjects.delete(directory);
    });
    projectWrites = write.catch(() => {});
    await write;
    return directory;
  });
  handle("projects:choose", z.tuple([]), async () => {
    const choice = await dialog.showOpenDialog(window!, {
      title: "Выбрать папку проекта", defaultPath: preferences.directory, properties: ["openDirectory", "createDirectory"]
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const directory = await realpath(choice.filePaths[0]);
    if (worktrees.managed(directory)) throw new Error("Выберите основную папку проекта.");
    const write = projectWrites.then(async () => {
      const next = [directory, ...recentProjects.filter(path => path !== directory)];
      await writeJson(projectsPath, { recent: next, hidden: [...hiddenProjects].filter(path => path !== directory) });
      recentProjects = next;
      projects.add(directory);
      hiddenProjects.delete(directory);
    });
    projectWrites = write.catch(() => {});
    await write;
    return directory;
  });
  handle("projects:open", z.tuple([localPath]), async ([directory]) => {
    const path = await realpath(project(directory));
    if (path !== directory || !(await stat(path)).isDirectory()) throw new Error("Папка проекта недоступна.");
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  handle("projects:remove", z.tuple([localPath]), ([directory]) => {
    project(directory);
    const write = projectWrites.then(async () => {
      if ([...activeSessions.keys()].some(id => {
        const chat = conversations.get(id);
        return (chat?.worktree?.origin ?? chat?.directory) === directory;
      })) {
        throw new Error("Сначала остановите агента.");
      }
      const next = recentProjects.filter(path => path !== directory);
      await writeJson(projectsPath, { recent: next, hidden: [...new Set([...hiddenProjects, directory])] });
      recentProjects = next;
      hiddenProjects.add(directory);
    });
    projectWrites = write.catch(() => {});
    return write;
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
    if (patch.directory) {
      if (worktrees.managed(patch.directory)) throw new Error("Выберите основную папку проекта.");
      project(patch.directory);
    }
    const write = settingsQueue.then(async () => {
      const next = { ...preferences, ...patch };
      if (next.defaultAccess === "full" && !next.fullAccessConfirmed) throw new Error("Подтвердите полный доступ.");
      await writeJson(settingsPath, next);
      preferences = next;
      nativeTheme.themeSource = next.theme;
      syncPower();
      if (patch.catalogUpdates === true) catalog.start();
      if (patch.catalogUpdates === false) catalog.stop();
      if (patch.openAtLogin !== undefined) syncLogin();
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
  handle("connect:clipboard-key", z.tuple([keyIdSchema]), async ([providerId]) => {
    const provider = providerFor(providerId);
    if (!provider?.keyPattern || ("auth" in provider && provider.auth.type !== "manual_key")) return;
    return keyFromClipboard(await clipboard.readText(), new RegExp("^(?:" + provider.keyPattern + ")$"));
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
          if (!code && provider !== "xai") {
            try { await openExternal(url); }
            catch { throw new Error("Не удалось открыть системный браузер."); }
          }
          signalConnect({ id: token, type: "waiting", code, url: code || provider === "xai" ? url : undefined });
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
      router.resetProvider(provider.id);
      if ("auth" in provider) await connections.refreshCatalogModels(catalog.current, signal, provider.id);
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
    if (provider === "openai" || provider === "github-copilot" || provider === "xai") {
      await engine.withAuth(client => client.disconnect(preferences.directory, provider));
      return refreshNative();
    }
    await connections.disconnect(provider);
    if (provider === "groq-api") { voice.cancel(); await savePreferences({ voiceGroq: false }); }
    router.resetProvider(provider);
    return publishState();
  });
  handle("chat:list", z.tuple([localPath.optional()]), async ([directory]) => {
    if (directory) project(directory);
    const list = (await (await engine.ready()).list()).filter(chat => !sideIds.has(chat.id))
      .map(chat => worktrees.projectChat(chat))
      .filter(chat => !directory || chat.directory === directory || chat.worktree?.origin === directory);
    list.forEach(chat => {
      conversations.set(chat.id, chat);
      if (!chat.worktree && !worktrees.managed(chat.directory)) projects.add(chat.directory);
    });
    return list;
  });
  handle("chat:create", z.tuple([localPath, z.string().trim().min(1).max(120)]), ([directory, title]) => {
    project(directory);
    return worktrees.use(directory, async () => {
      const chat = await (await engine.ready()).create(directory, title, worktrees.label(directory));
      conversations.set(chat.id, chat);
      return chat;
    });
  });
  handle("chat:action", z.tuple([id, chatActionSchema]), async ([session, action]) => {
    const previous = conversation(session);
    if (activeSessions.has(session) && (action.type === "archive" || action.type === "delete")) throw new Error("Сначала остановите агента.");
    const change = async () => (await engine.ready()).chatAction(session, action);
    const changed = action.type === "fork" ? await worktrees.use(previous.directory, change) : await change();
    const chat = changed && worktrees.projectChat(changed);
    if (chat) conversations.set(chat.id, chat);
    else conversations.delete(session);
    return chat;
  });
  handle("chat:history", z.tuple([id]), async ([session]) => ({
    ...await engine.history(session, conversation(session).directory), speed: health.lastReply(session)
  }));
  handle("chat:revert", z.tuple([id, id.optional()]), ([session, message]) => {
    const { directory } = conversation(session);
    return worktrees.use(directory, () => engine.revert(session, directory, message));
  });
  handle("chat:revert-file", z.tuple([id, id]), ([session, file]) => {
    const { directory } = conversation(session);
    return worktrees.use(directory, () => engine.revertFile(session, directory, file));
  });
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
  const engineModel = (model: string) => nativeModels.find(entry => entry.model.id === model)?.upstream ?? { id: legacyModel(model) ?? model, providerID: "vsemkod" };
  handle("side:ask", z.tuple([dialogId, localPath, id.optional(), z.string().trim().min(1).max(100_000), modelId, id.optional()]),
    async ([token, directory, parent, text, model, variant]) => {
      project(directory);
      model = legacyModel(model) ?? model;
      if (parent && conversation(parent).directory !== directory) throw new Error("Чат находится в другом проекте.");
      const knownModel = nativeModels.some(entry => entry.model.id === model) || personalModels().some(entry => entry.id === model) ||
        activeOffers(effective(), model).some(({ offer, provider }) => offer.supportsTools && connections.connected(catalog.current).includes(provider.id));
      if (!knownModel) throw new Error("Эта модель недоступна.");
      const entry = sideSessions.get(token) ?? { directory, parent };
      if (entry.closed || entry.directory !== directory || entry.parent !== parent || entry.sending) throw new Error("Боковой чат занят или закрыт.");
      sideSessions.set(token, entry);
      const sending = worktrees.use(directory, async () => {
        if (!entry.session) {
          entry.client = await engine.ready();
          if (entry.closed) throw new Error("Боковой чат закрыт.");
          entry.session = await entry.client.createSide(directory, parent);
          sideIds.add(entry.session);
        }
        const session = entry.session;
        if (entry.closed) throw new Error("Боковой чат закрыт.");
        const native = nativeModels.find(item => item.model.id === model)?.upstream;
        const result = await engine.send(session, directory, text, model, false, [], native, { access: "read", variant });
        if (entry.closed || result.stopped) throw new Error("Ответ остановлен.");
        const history = await engine.history(session, directory);
        const lastUser = history.parts.findLastIndex(part => part.kind === "user");
        const answer = history.parts.slice(lastUser + 1).flatMap(part => part.kind === "text" ? [part.text] : []).join("\n\n");
        return { text: answer || "Ответ пуст.", sessionId: session };
      });
      entry.sending = sending;
      try { return await sending; }
      finally { entry.sending = undefined; }
    });
  handle("side:close", z.tuple([dialogId]), ([token]) => closeSide(token));

  handle("chat:send", z.tuple([id, z.string().trim().max(100_000), modelId, z.array(dialogId).max(10), turnSchema.optional()]), ([session, text, model, files, options]) => {
    const chat = conversation(session);
    return worktrees.use(chat.directory, () => sendChat(chat, text, model, files, options));
  });
  async function sendChat(chat: Conversation, text: string, model: string, files: string[], options?: z.infer<typeof turnSchema>) {
    const session = chat.id;
    if (activeSessions.has(session)) throw new Error("Агент уже отвечает в этом чате.");
    model = legacyModel(model) ?? model;
    const connected = connections.connected(catalog.current);
    const workingCatalog = effective();
    const available = rankedModels(workingCatalog).filter(entry =>
      entry.tier !== "basic" && activeOffers(workingCatalog, entry.id).some(({ offer, provider }) => offer.supportsTools && connected.includes(provider.id)));
    const native = nativeModels.find(entry => entry.model.id === model);
    const details = native?.model ?? personalModels().find(entry => entry.id === model);
    const catalogModel = available.find(entry => entry.id === model);
    if (!details && !(model === "auto" ? available.length : catalogModel)) {
      throw new Error("Эта модель недоступна. Выберите другую или подключите провайдера.");
    }
    if (!text && !files.length && !options?.compact && !options?.replayMessageId) throw new Error("Введите сообщение.");
    const access = options?.access ?? preferences.defaultAccess;
    if (access === "full" && !preferences.fullAccessConfirmed) throw new Error("Подтвердите полный доступ в настройках.");
    const turn = { interrupted: false };
    activeSessions.set(session, turn);
    tasks.watch(session);
    syncPower();
    try {
      const paths = await attachments.resolve(chat.directory, files, details?.vision ?? catalogModel?.capabilities.includes("vision") ?? false, chat.worktree?.origin);
      if (turn.interrupted) return { stopped: true, changes: (await engine.history(session, chat.directory)).changes };
      const result = await engine.send(session, chat.directory, text, model, preferences.auto, paths, native?.upstream, { ...options, access });
      if (!result.stopped && preferences.notifications && (!window?.isFocused() || visibleChat !== session)) {
        const history = await engine.history(session, chat.directory).catch(() => undefined);
        const answer = history?.parts.findLast(part => part.kind === "text");
        const body = answer?.kind === "text" ? answer.text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_~`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
        announce("Готово: " + chat.title, body || "Агент закончил работу.", session);
      }
      return result;
    } catch (error) {
      announce("Не получилось: " + chat.title, error instanceof Error ? error.message.slice(0, 120) : "Не удалось получить ответ.", session);
      throw error;
    } finally {
      if (engine.runningClient) await tasks.refresh(engine.runningClient, conversations).catch(() => {});
      tasks.unwatch(session);
      activeSessions.delete(session);
      syncPower();
    }
  }
  let browserRoot: string | undefined;
  const browser = createBrowserHost({ window: () => window, projectRoot: () => browserRoot, publish: event => broadcast("browser:event", event) });
  const browserBounds = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict();
  handle("browser:show", z.tuple([browserBounds]), ([bounds]) => browser.show(bounds));
  handle("browser:hide", z.tuple([]), () => browser.hide());
  handle("browser:navigate", z.tuple([z.string().max(8192), localPath.optional()]), ([input, directory]) => {
    if (directory) browserRoot = project(directory);
    return browser.navigate(input, browserRoot);
  });
  handle("browser:back", z.tuple([]), () => browser.back());
  handle("browser:forward", z.tuple([]), () => browser.forward());
  handle("browser:reload", z.tuple([]), () => browser.reload());
  handle("browser:stop", z.tuple([]), () => browser.stop());
  handle("browser:external", z.tuple([]), () => browser.external());
  handle("browser:devtools", z.tuple([]), () => browser.devtools());
  handle("browser:clear-data", z.tuple([]), () => browser.clearData());
  handle("browser:clear-errors", z.tuple([]), () => browser.clearErrors());
  handle("browser:state", z.tuple([]), () => browser.state());
  handle("browser:reveal", z.tuple([localPath]), ([path]) => {
    const downloads = app.getPath("downloads");
    if (relative(downloads, path).startsWith("..") || isAbsolute(relative(downloads, path))) throw new Error("Можно показать только скачанные файлы.");
    shell.showItemInFolder(path);
  });
  const projectFile = z.string().min(1).max(32768);
  handle("file:stat", z.tuple([localPath, projectFile]), ([directory, path]) =>
    checkedFile(project(directory), path).then(({ info }) => info, () => null));
  handle("file:preview", z.tuple([localPath, projectFile]), ([directory, path]) =>
    previewFile(project(directory), path));
  handle("file:action", z.tuple([localPath, projectFile, z.enum(["open", "reveal", "browser"])]), async ([directory, path, action]) => {
    const { info } = await checkedFile(project(directory), path);
    if (action === "reveal") { shell.showItemInFolder(info.path); return; }
    if (action === "browser") {
      if (!info.html || !info.canOpen) throw new Error("В браузере можно открыть только HTML.");
      await shell.openExternal(pathToFileURL(info.path).href);
      return;
    }
    if (!info.canOpen) throw new Error("Открытие исполняемых файлов и сценариев запрещено.");
    const error = await shell.openPath(info.path);
    if (error) throw new Error(error);
  });
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
      if (!engine.isWorking(session)) throw new Error("Вопрос уже закрыт.");
      await (await engine.ready()).answerQuestion(session, form, answer);
    });
  handle("models:variants", z.tuple([localPath, modelId]), async ([directory, model]) =>
    (await (await engine.ready()).modelInfo(project(directory), engineModel(model)))?.variants.map(item => item.id) ?? []);
  handle("models:custom", z.tuple([customInput.optional()]), ([input]) => connections.customModels(input));
  handle("models:custom-save", z.tuple([remoteModelsSchema.min(1)]), async ([models]) => {
    await connections.saveCustomModels(models);
    return publishState();
  });
  handle("models:custom-list", z.tuple([z.union([customInput, z.object({ id: customProviderIdSchema })])]),
    ([input]) => connections.customProviderModels(input));
  const customSave = customInput.extend({
    id: customProviderIdSchema.optional(), name: z.string().trim().min(1).max(60),
    key: customInput.shape.key.optional(), models: customSelectionSchema
  }).strict();
  handle("models:custom-provider-save", z.tuple([customSave]), async ([input]) => {
    const provider = await connections.saveCustomProvider(input);
    router.resetProvider(provider);
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
      name, status: status.status, error: "error" in status ? status.error : undefined, managed: !!connectors.get(name)
    }));
  }
  handle("mcp:list", z.tuple([localPath]), ([directory]) => mcpList(directory));
  let mcpQueue: Promise<unknown> = Promise.resolve();
  function changeMcp<T>(directory: string, run: () => Promise<T>): Promise<T> {
    project(directory);
    const task = mcpQueue.then(run);
    mcpQueue = task.catch(() => {});
    return task;
  }

  async function cancelConnectorAuth(name: string) {
    const attempt = connectorAuth.get(name);
    attempt?.cancel.abort();
    await attempt?.done.catch(() => {});
  }

  async function applyMcp(directory: string, name: string) {
    const running = engine.runningClient;
    const client = await engine.ready();
    // The next launch reads the persisted config. A busy instance also needs the live change.
    if (running === client) await client.mcpSet(directory, name, connectors.engineConfig(name));
    return client;
  }

  handle("mcp:change", z.tuple([localPath, mcpName, z.enum(["put", "delete", "enable", "disable", "check"]), mcpConfig.optional()]),
    ([directory, name, action, config]) => changeMcp(directory, async () => {
      if (action === "check") {
        await (await engine.ready()).mcpCheck(directory, name, connectors.engineConfig(name));
      } else {
        await cancelConnectorAuth(name);
        await connectors.change(name, action, config);
        if (action === "delete") await connectors.clearKey(name);
        await applyMcp(directory, name);
      }
      return mcpList(directory);
    }));

  const connectorList = async (directory: string) => {
    project(directory);
    const statuses = await mcpList(directory).catch(() => []);
    return connectors.list(statuses);
  };
  handle("connectors:list", z.tuple([localPath]), ([directory]) => connectorList(directory));
  const connectorInput = z.object({ key: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/).optional() });
  handle("connectors:install", z.tuple([localPath, mcpName, connectorInput.optional()]),
    ([directory, name, input]) => changeMcp(directory, async () => {
      await cancelConnectorAuth(name);
      await connectors.install(name, input?.key);
      const client = await applyMcp(directory, name);
      await client.mcpCheck(directory, name, connectors.engineConfig(name));
      return connectorList(directory);
    }));

  handle("connectors:authorize", z.tuple([localPath, mcpName]), async ([directory, name]) => {
    const attempt = await changeMcp(directory, async () => {
      const entry = connectors.entry(name);
      const config = connectors.get(name);
      if (entry.auth !== "oauth" || entry.transport !== "remote" || config?.type !== "remote" || config.url !== entry.url || config.disabled) {
        throw new Error("Сначала включите коннектор из каталога.");
      }
      const existing = connectorAuth.get(name);
      if (existing) return existing;
      const cancel = new AbortController();
      const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(5 * 60_000)]);
      const done = engine.withAuth(client => client.mcpAuthorize(directory, name, async value => {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("Сервер вернул небезопасный адрес входа.");
        await shell.openExternal(url.href);
      }, signal)).catch(error => {
        if (!signal.aborted) throw error;
      }).then(() => cancel.signal.aborted ? connectors.list([]) : connectorList(directory))
        .finally(() => connectorAuth.delete(name));
      // A queued change can cancel this attempt before its IPC caller has received the promise.
      void done.catch(() => {});
      const attempt = { cancel, done };
      connectorAuth.set(name, attempt);
      return attempt;
    });
    return attempt.done;
  });

  handle("connectors:remove", z.tuple([localPath, mcpName]), ([directory, name]) => changeMcp(directory, async () => {
    const entry = connectors.entry(name);
    await cancelConnectorAuth(name);
    const installed = connectors.get(name);
    if (installed) {
      if (entry.auth === "oauth") await (await engine.ready()).mcpLogout(directory, name);
      await connectors.change(name, "delete");
    }
    await connectors.clearKey(name);
    if (installed) await applyMcp(directory, name);
    return connectorList(directory);
  }));

  handle("skills:catalog", z.tuple([]), () => skills.list());
  handle("skills:install", z.tuple([skillId]), async ([name]) => { const list = await skills.install(name); skillsRevision++; return list; });
  handle("skills:remove", z.tuple([skillId]), async ([name]) => { const list = await skills.remove(name); skillsRevision++; return list; });
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
    const turn = activeSessions.get(session);
    if (turn) turn.interrupted = true;
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
  function showWindow() {
    if (!window) return createWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  // Значок в трее (Windows и Linux): окно закрывается в трей, выйти можно из меню значка.
  if (process.platform !== "darwin") {
    try {
      tray = createTray(resources, {
        open: showWindow,
        newChat: () => { showWindow(); broadcast("app:new-chat", undefined); },
        stopTasks: () => { void Promise.allSettled(tasks.running().map(task => tasks.stop(task.id))); },
        checkUpdates: () => { void updates.check().catch(() => {}); },
        applyUpdate: () => { if (updates.ready?.action === "restart") showWindow(); void updates.apply().catch(() => {}); },
        quit: () => app.quit()
      });
    } catch (error) { console.warn("[tray]", error instanceof Error ? error.message : error); }
  }
  hideOnClose = () => {
    // На Linux трей есть не во всех окружениях (GNOME без расширения), поэтому там это включается вручную.
    if (!tray || !(preferences.closeToTray ?? process.platform === "win32")) return false;
    if (!preferences.trayHintShown) {
      void savePreferences({ trayHintShown: true }).catch(() => {});
      try { announce("vsemkod работает в фоне", "Значок — в трее рядом с часами. Чтобы выйти, щёлкните по нему правой кнопкой → «Выйти из vsemkod».", undefined, true); } catch { /* без уведомлений */ }
    }
    return true;
  };
  function syncLogin() {
    if (!app.isPackaged || process.platform === "linux") return;
    app.setLoginItemSettings({ openAtLogin: preferences.openAtLogin === true, args: ["--hidden"] });
  }
  syncLogin();
  // Автообновление: ставим загруженную версию, когда агент ничего не делает —
  // сразу после запуска (обновление уже было скачано) или пока окно спрятано в трей.
  const launchedAt = Date.now();
  let installing = false;
  const idle = () => !activeSessions.size && !tasks.running().length && !terminals.size && ![...sideSessions.values()].some(item => item.sending);
  const autoUpdateTimer = setInterval(() => {
    tray?.update({ running: activeSessions.size, tasks: tasks.running().length });
    const ready = updates.ready;
    if (quitting || installing || ready?.action !== "restart" || preferences.autoUpdate === false || !idle()) return;
    const hidden = !window || !window.isVisible();
    if (!hidden && Date.now() - launchedAt > 20_000) return;
    installing = true;
    if (hidden) {
      try { writeFileSync(relaunchMarker, String(Date.now())); } catch { /* откроется с окном */ }
    } else broadcast("updates:installing", ready.version);
    setTimeout(() => {
      void updates.apply().catch(() => { installing = false; rmSync(relaunchMarker, { force: true }); });
    }, hidden ? 0 : 2500);
  }, 1000);
  autoUpdateTimer.unref();
  // Окно открыли из трея, вторым запуском или после сна: если давно не проверяли, проверяем обновления.
  app.on("browser-window-focus", () => updates.checkIfStale());
  powerMonitor.on("resume", () => updates.checkIfStale());
  createWindow();
  updates.start();
  if (preferences.catalogUpdates) catalog.start();
  refreshProviderModels();
  void refreshNative().catch(() => {});
}

if (!dataOverride && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!window) { if (teardown) createWindow(); return; }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox("Ошибка запуска vsemkod", error instanceof Error ? error.message : "Не удалось запустить приложение.");
    app.quit();
  });
  app.on("activate", () => { if (!window && teardown) createWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin" || exitConfirmed) app.quit(); });
  app.on("before-quit", event => {
    if (!teardown || quitting) return;
    event.preventDefault();
    if (approveExit && !approveExit()) return;
    quitting = true;
    void teardown().finally(() => app.quit());
  });
}
