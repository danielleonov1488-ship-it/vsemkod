import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Attachment, ChatAction, ChatPart, CatalogState, ChatEvent, ConnectionId, Conversation, DesktopApi, InitialState, Notice, Preferences, ProjectTools, UpdateProgress, UpdateReady } from "../shared/api";
import type { RouterStats } from "../shared/api";
import { Chat } from "./chat";
import { catalogConnection, ConnectDialog, ConnectionsPage, readableError, type Connection } from "./connections";
import { accessModes, slashCommand, type AccessMode } from "../shared/workspace";
import { defaultModel } from "../shared/catalog";
import { applyChatEvent, applyHistory, emptyView, isRunning, useChatViews, type ChatView, type PendingTurn } from "./chat-state";
import type { FileReference } from "../shared/file-links";
import { modelSpeed } from "./models";
import { ChatGroups } from "./chat-groups";
import { Composer } from "./composer";
import { ComposerStatus } from "./composer-status";
import { Settings } from "./settings";
import { WorkspacePanel, type PanelTab } from "./workspace-panel";
import { Icon } from "./icons";
import { UpdatePill } from "./update-pill";
import { findSecrets, maskSecrets } from "../shared/secrets";
import { ModelPicker, modelOptions } from "./models";
import logo from "./assets/logo.svg";

export const COMMUNITY_URL = "https://t.me/leonovlabs";

declare global {
  interface Window { vsemkod: DesktopApi }
}

const api = window.vsemkod;
const suggestions = ["Создать лендинг", "Найти баг", "Объяснить код", "Написать тесты"];
function catalogAge(date?: string) {
  if (!date) return "Загружаем каталог моделей";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60_000));
  if (minutes < 1) return "Каталог моделей обновлён только что";
  if (minutes < 60) return "Каталог моделей обновлён " + minutes + " мин назад";
  if (minutes < 24 * 60) return "Каталог моделей обновлён " + Math.floor(minutes / 60) + " ч назад";
  return "Каталог моделей обновлён " + new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(Date.parse(date));
}

function App() {
  const [initial, setInitial] = useState<InitialState>();
  const [catalog, setCatalog] = useState<CatalogState>();
  const [prefs, setPrefs] = useState<Preferences>();
  const [directory, setDirectory] = useState("");
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const sessionsRef = useRef<Conversation[]>([]);
  sessionsRef.current = sessions;
  const openChatRef = useRef<(session: Conversation) => Promise<void>>(undefined);
  const [chat, setChat] = useState<Conversation>();
  const [settings, setSettings] = useState(false);
  const [settingsModels, setSettingsModels] = useState(false);
  const [subscriptions, setSubscriptions] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleProject, setVisibleProject] = useState("");
  const [hiddenProjects, setHiddenProjects] = useState<string[]>([]);
  const [expandProject, setExpandProject] = useState<{ directory: string }>();
  const chatViews = useChatViews();
  const { current: cached, update: updateView, running, statuses, status: setStatus } = chatViews;
  const homeId = "home";
  const viewId = chat?.id ?? homeId;
  const view = chatViews.views[viewId] ?? emptyView;
  const { draft, files, parts, permissions, changes, questions, usage, reverted, planReady, progress, failure: failed,
    model, provider: routeProvider, variant, loading: loadingChat } = view;
  const access = view.access ?? prefs?.defaultAccess ?? "ask";
  const status = chat && running[chat.id];
  const busy = isRunning(status) || !!view.loading && !chat;
  function editView(patch: Partial<ChatView>) { updateView(viewId, () => patch); }
  const setDraft = (draft: string) => editView({ draft });
  const setFiles = (apply: Attachment[] | ((files: Attachment[]) => Attachment[])) =>
    updateView(viewId, state => ({ files: typeof apply === "function" ? apply(state.files) : apply }));
  const setAccess = (access: AccessMode) => editView({ access });
  const setVariant = (variant: string) => editView({ variant });
  const setModel = (model?: string) => editView({ model, provider: undefined });
  const setRouteProvider = (provider?: string) => editView({ provider });
  const [accessMenu, setAccessMenu] = useState(0);
  const [variants, setVariants] = useState<string[]>([]);
  const [tools, setTools] = useState<ProjectTools>();
  const [routerStats, setRouterStats] = useState<RouterStats>();
  const [demoRemaining, setDemoRemaining] = useState<number>();
  const [preview, setPreview] = useState<FileReference>();
  const [panel, setPanel] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("changes");
  const [panelWidth, setPanelWidth] = useState<number>();
  const [modelMenu, setModelMenu] = useState(0);
  useEffect(() => {
    if (!settings && !subscriptions && chat && statuses.current[chat.id] === "ready") setStatus(chat.id);
  }, [chat?.id, settings, subscriptions]);
  const [systemTheme, setSystemTheme] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const searchInput = useRef<HTMLInputElement>(null);
  const lastEscape = useRef(0);
  const stopping = useRef(new Set<string>());
  const navigation = useRef(0);
  const [notice, setNotice] = useState<Notice>();
  const [updateReady, setUpdateReady] = useState<UpdateReady>();
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>();
  const [applyAfterReply, setApplyAfterReply] = useState(false);
  const [secretWarning, setSecretWarning] = useState(false);
  const secretBypass = useRef(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [connection, setConnection] = useState<Connection>();
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const currentDirectory = useRef(directory);
  currentDirectory.current = directory;
  const activeChat = useRef<string | undefined>(undefined);
  const preferenceRevision = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const liveCatalog = useRef(catalog);
  const chatVisible = useRef(false);
  chatVisible.current = !settings && !subscriptions;
  liveCatalog.current = catalog;

  const notify = useCallback((next: Notice) => {
    setNotice(next);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), next.connect ? 12_000 : 6500);
  }, []);
  const showError = useCallback((error: unknown) => notify({ text: readableError(error), tone: "error" }), [notify]);

  useEffect(() => {
    let mounted = true;
    let live = false;
    let liveUpdate = false;
    const stopCatalog = api.onCatalog(state => { live = true; setCatalog(state); });
    const stopNotice = api.onNotice(notify);
    const stopUpdate = api.onUpdate(update => { liveUpdate = true; setUpdateReady(update); });
    const stopProgress = api.onUpdateProgress?.(setUpdateProgress);
    const stopFocus = api.onChatFocus?.(id => {
      const target = sessionsRef.current.find(item => item.id === id);
      if (target) void openChatRef.current?.(target);
    });
    void api.initial().then(info => {
      if (!mounted) return;
      setInitial(info);
      if (!live) setCatalog(info);
      if (!liveUpdate) setUpdateReady(info.update);
      setPrefs(info.preferences);
      setDirectory(info.preferences.directory);
      setVisibleProject(info.preferences.directory);
      setHiddenProjects(info.hiddenProjects ?? []);
      setRecentProjects(info.projects ?? []);
    }).catch(showError);
    return () => { mounted = false; stopCatalog(); stopNotice(); stopUpdate(); stopProgress?.(); stopFocus?.(); clearTimeout(noticeTimer.current); };
  }, [notify, showError]);

  useEffect(() => api.onChat((event: ChatEvent) => {
    const session = event.sessionId;
    const previous = cached.current[session];
    updateView(session, value => applyChatEvent(value, event));
    const updated = cached.current[session];
    if (event.type === "turn-status") setStatus(session, event.status);
    if (event.type === "permission" || event.type === "permission-resolved" || event.type === "question" || event.type === "question-resolved") {
      setStatus(session, updated.permissions.length ? "permission" : updated.questions.length ? "question" : "working");
    }
    if (event.type === "reply-speed" && event.modelSpeed) {
      const speed = event.modelSpeed;
      setCatalog(state => state && { ...state, speeds: [
        ...(state.speeds ?? []).filter(item => item.modelId !== speed.modelId || item.providerId !== speed.providerId), speed
      ] });
    }
    if (event.type === "route") {
      if (event.previousModelId && (previous?.provider !== event.providerId || previous?.routedModel !== event.modelId) &&
          activeChat.current === session && chatVisible.current) {
        const names = liveCatalog.current?.catalog;
        const modelName = (id: string) => names?.models.find(model => model.id === id)?.name ?? id;
        const providerName = (id: string) => names?.providers.find(provider => provider.id === id)?.name ?? id;
        const sameModel = event.previousModelId === event.modelId && event.previousProviderId;
        const next = sameModel ? providerName(event.providerId) : modelName(event.modelId);
        const prior = sameModel ? providerName(sameModel) : modelName(event.previousModelId);
        notify({ text: "Переключился на " + next + (event.reason === "quota"
          ? " — у " + prior + " кончилась квота" : " — " + prior + " временно недоступен") });
      }
      setCatalog(state => state && { ...state,
        latencies: [...(state.latencies ?? []).filter(item => item.modelId !== event.modelId || item.providerId !== event.providerId),
          { modelId: event.modelId, providerId: event.providerId, averageMs: event.averageMs }]
      });
    }
  }), [notify]);

  const connectionsKey = catalog && [...catalog.connected, ...catalog.personal].join("/");
  useEffect(() => {
    const load = api.routerStats;
    if (!load || connectionsKey === undefined) return;
    let revision = 0;
    let current = true;
    const stop = api.onRouterStats?.(stats => { revision++; setRouterStats(stats); });
    const refresh = () => {
      const read = ++revision;
      void load().then(stats => { if (current && read === revision) setRouterStats(stats); }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { current = false; stop?.(); clearInterval(timer); };
  }, [connectionsKey]);
  useEffect(() => api.onDemoQuota?.(setDemoRemaining), []);

  useEffect(() => {
    if (!initial) return;
    let current = true;
    void api.sessions().then(list => {
      if (current) setSessions(previous => [...new Map([...list, ...previous].map(item => [item.id, item])).values()]);
    }).catch(error => { if (current) showError(error); });
    return () => { current = false; };
  }, [initial, showError]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const theme = prefs?.theme && prefs.theme !== "system" ? prefs.theme : systemTheme;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.fontSize = prefs?.fontSize ?? "normal";
  }, [theme, prefs?.fontSize]);
  useEffect(() => {
    if (!directory) return;
    let current = true;
    setTools(undefined);
    void api.tools(directory).then(value => { if (current) setTools(value); }).catch(() => {});
    return () => { current = false; };
  }, [directory]);

  const options = catalog ? modelOptions(catalog) : [];
  const personal = catalog?.personalModels ?? [];
  const zen = catalog?.zenModels ?? [];
  const ownModels = [...personal, ...zen];
  const available = options.filter(item => item.available.length);
  const ownModel = ownModels.find(item => item.id === model);
  const preferred = catalog && defaultModel(catalog.catalog);
  const selected = available.find(item => item.model.id === model) ?? available.find(item => item.model.id === preferred?.id) ??
    available.find(item => item.model.tier !== "new") ?? available[0];
  const modelId = ownModel?.id ?? selected?.model.id;
  const currentProviderId = routeProvider ?? ownModel?.providerId ?? selected?.available[0]?.provider.id;

  const vision = ownModel?.vision ?? selected?.model.capabilities.includes("vision") ?? false;
  const contextWindow = ownModel?.context ?? selected?.model.contextWindow;
  useEffect(() => {
    let current = true;
    setVariants([]);
    if (directory && modelId) void api.modelVariants(directory, modelId).then(items => {
      if (current) { setVariants(items); updateView(viewId, old => ({ variant: items.includes(old.variant) ? old.variant : "" })); }
    }).catch(() => {});
    return () => { current = false; };
  }, [directory, modelId, viewId]);

  function revealChat(session: Conversation) {
    activeChat.current = session.id;
    chatVisible.current = true;
    setChat(session);
    setDirectory(session.directory);
    setVisibleProject(session.directory);
    setSettings(false);
    setSubscriptions(false);
    setPreview(undefined);
    if (statuses.current[session.id] === "ready") setStatus(session.id);
  }

  function showHome(folder = directory) {
    navigation.current++;
    activeChat.current = undefined;
    setChat(undefined);
    setSettings(false);
    setSubscriptions(false);
    setPreview(undefined);
    setDirectory(folder);
    setVisibleProject(folder);
    chatViews.reset(homeId);
  }

  const projectDirectories = [...new Set([directory, ...recentProjects, ...sessions.map(item => item.directory), prefs?.directory]
    .filter((path): path is string => !!path && !hiddenProjects.includes(path)))];

  async function chooseDirectory(asDefault = false, openForComposer = false) {
    try {
      const chosen = await api.chooseDirectory();
      if (!chosen) return;
      setRecentProjects(list => [chosen, ...list.filter(path => path !== chosen)]);
      setHiddenProjects(list => list.filter(path => path !== chosen));
      setExpandProject({ directory: chosen });
      if (asDefault) {
        setPrefs(await api.preferences({ directory: chosen }));
        if (!chat) {
          setDirectory(chosen);
          setFiles([]);
        }
      } else if (openForComposer && chosen !== currentDirectory.current) {
        void startChat(chosen);
      } else {
        setQuery("");
        setVisibleProject(chosen);
        if (!chat && !cached.current[homeId]?.loading) {
          navigation.current++;
          setDirectory(chosen);
          setFiles([]);
        }
      }
    } catch (error) { showError(error); }
  }

  function acceptAttachments(added: Attachment[], target: string) {
    if (currentDirectory.current !== target || (activeChat.current ?? homeId) !== viewId) return;
    if (!vision && added.some(file => file.image)) showError("Выбранная модель не принимает изображения.");
    setFiles(current => [...current, ...added.filter(file => vision || !file.image)].slice(0, 10));
  }

  async function chooseFiles() {
    try { acceptAttachments(await api.chooseFiles(directory), directory); }
    catch (error) { showError(error); }
  }

  async function captureFiles(added: File[]) {
    try {
      const data = await Promise.all(added.slice(0, 10).map(async file => {
        if (file.size > 2 * 1024 * 1024) throw new Error("Можно прикрепить файлы размером до 2 МБ.");
        const path = api.filePath(file);
        return { path: path || undefined, data: path ? undefined : new Uint8Array(await file.arrayBuffer()), name: file.name, mime: file.type };
      }));
      acceptAttachments(await api.captureFiles(directory, data), directory);
    } catch (error) { showError(error); }
  }

  async function checkUpdates() {
    setCheckingUpdates(true);
    try {
      const result = await api.checkUpdates();
      if (typeof result === "object") {
        setNotice(undefined);
        setUpdateReady(result);
      } else {
        const messages = {
          disabled: "Проверка обновлений доступна в установленном приложении.",
          current: "У вас последняя версия.",
          downloading: "Обновление загружается в фоне."
        };
        notify({ text: messages[result] });
      }
    } catch { notify({ text: "Не удалось проверить обновления.", tone: "error" }); }
    finally { setCheckingUpdates(false); }
  }

  openChatRef.current = session => openChat(session);
  async function openChat(session: Conversation) {
    navigation.current++;
    revealChat(session);
    const id = session.id;
    const existing = cached.current[id];
    if (existing?.loaded || existing?.loading || isRunning(statuses.current[id])) return;
    updateView(id, () => ({ loading: true, access: session.access, model: session.modelId, variant: session.variant ?? "" }));
    try {
      const history = await api.history(id);
      updateView(id, () => ({ ...applyHistory(history),
        planReady: session.access === "read" && history.parts.findLast(part => part.kind !== "turn")?.kind === "text" }));
    } catch (error) { if (activeChat.current === id) showError(error); }
    finally { updateView(id, () => ({ loading: false })); }
  }

  async function runTurn(turn: PendingTurn) {
    let session = chat;
    if (session && isRunning(statuses.current[session.id])) return;
    if (!session && cached.current[homeId]?.loading) return;
    const nav = navigation.current;
    const started = Date.now();
    const localId = "local:" + crypto.randomUUID();
    try {
      if (!session) {
        updateView(homeId, () => ({ loading: true }));
        const title = turn.text.replace(/\s+/g, " ").split(/(?<=[.!?])\s/, 1)[0].slice(0, 72) || turn.files[0]?.name.slice(0, 72) || "Новый чат";
        try { session = await api.create(directory, title); }
        finally {
          if (navigation.current === nav) updateView(homeId, () => ({ loading: false }));
        }
        updateView(session.id, () => ({ loaded: true, model: turn.modelId, variant: turn.options.variant ?? "", access: turn.options.access }));
        if (navigation.current === nav) revealChat(session);
      }
      const sessionId = session.id;
      const current = { ...session, access: turn.options.access, variant: turn.options.variant, modelId: turn.modelId, updatedAt: Date.now() };
      if (activeChat.current === sessionId) setChat(current);
      setSessions(list => [current, ...list.filter(item => item.id !== sessionId)]);
      setStatus(sessionId, "working");
      updateView(sessionId, value => ({ loaded: true, failure: undefined, progress: { started, since: started },
        planReady: false, provider: undefined, liveSpeed: undefined, parts: turn.options.compact ? value.parts : [...value.parts, {
          id: localId, kind: "user", text: turn.text, files: turn.files.map(file => file.name)
        }] }));
      const result = await api.send(sessionId, turn.text, turn.modelId, turn.files.map(file => file.id), turn.options);
      const history = await api.history(sessionId).catch(() => undefined);
      const cachedParts = cached.current[sessionId]?.parts ?? [];
      const visibleParts = !history || result.stopped && cachedParts.at(-1)?.id === localId && history.parts.length < cachedParts.length
        ? cachedParts : history.parts;
      const ended = visibleParts.at(-1)?.kind === "turn" ? visibleParts : [...visibleParts, {
        id: "work:" + localId, kind: "turn" as const, seconds: (Date.now() - (cached.current[sessionId]?.progress?.started ?? started)) / 1000, stopped: result.stopped
      }];
      updateView(sessionId, () => ({ ...(history && applyHistory(history)), parts: ended, changes: result.changes,
        planReady: !result.stopped && !turn.options.compact && turn.options.access === "read" &&
          ended.findLast(part => part.kind !== "turn")?.kind === "text" }));
      const visible = activeChat.current === sessionId && chatVisible.current;
      setStatus(sessionId, !result.stopped && !visible ? "ready" : undefined);
      if (visible && result.stopped) notify({ text: "Ответ остановлен" });
      if (!visible && !result.stopped && document.hasFocus()) {
        const title = (session?.title ?? turn.text).slice(0, 60);
        notify({ text: "«" + title + "» — готово", open: sessionId });
      }
    } catch (error) {
      const message = readableError(error);
      if (!session || activeChat.current === session.id && chatVisible.current) notify({ text: message, tone: "error" });
      if (session) {
        const id = session.id;
        const history = await api.history(id).catch(() => undefined);
        updateView(id, () => ({ ...(history && applyHistory(history)), failure: { message, turn } }));
        setStatus(id, "error");
      }
      if (!turn.options.compact && (session || navigation.current === nav)) updateView(session?.id ?? homeId, value => ({
        draft: value.draft || turn.text, files: value.files.length ? value.files : turn.files
      }));
    } finally {
      if (session) updateView(session.id, () => ({ progress: undefined, permissions: [], questions: [], liveSpeed: undefined }));
    }
  }

  function retryFailed() {
    if (!failed || !modelId || busy || loadingChat) return;
    if (!vision && failed.turn.files.some(file => file.image)) {
      showError("Выбранная модель не принимает изображения.");
      return;
    }
    if (draft === failed.turn.text) setDraft("");
    if (files === failed.turn.files) setFiles([]);
    void runTurn({ ...failed.turn, modelId, options: { ...failed.turn.options, variant: variant || undefined } });
  }

  function stop() {
    const id = activeChat.current;
    if (!id || !isRunning(statuses.current[id]) || stopping.current.has(id)) return;
    stopping.current.add(id);
    void api.stop(id).catch(showError).finally(() => stopping.current.delete(id));
  }

  async function exportChats(sessionId?: string) {
    try {
      const saved = await api.exportChats(sessionId);
      if (saved) notify({ text: sessionId ? "Чат экспортирован" : "Сохранено чатов: " + saved });
    } catch (error) { showError(error); }
  }

  async function startChat(folder?: string) {
    const next = folder || visibleProject || directory || prefs?.directory;
    if (!next) return;
    const nav = ++navigation.current;
    setExpandProject({ directory: next });
    try {
      const session = await api.create(next, "Новый чат");
      chatViews.reset(session.id, { loaded: true, model, variant });
      setSessions(list => [session, ...list.filter(item => item.id !== session.id)]);
      if (nav !== navigation.current) return;
      revealChat(session);
      requestAnimationFrame(() => draftInput.current?.focus());
    } catch (error) { showError(error); }
  }

  async function removeProject(path: string) {
    try {
      await api.projectRemove?.(path);
      setRecentProjects(list => list.filter(item => item !== path));
      setHiddenProjects(list => [...list, path]);
      const fallback = projectDirectories.find(item => item !== path) ?? "";
      if (directory === path) showHome(fallback);
      else if (visibleProject === path) setVisibleProject(fallback);
    } catch (error) { showError(error); }
  }

  function quickCommand(name: string) {
    if (name === "new") {
      void startChat(directory);
    } else if (name === "plan") setAccess("read");
    else if (name === "model") setModelMenu(value => value + 1);
    else if (name === "export") {
      if (chat) void exportChats(chat.id);
      else showError("Сначала откройте чат.");
    } else return false;
    setDraft("");
    return true;
  }

  function submit(text = draft, readyFiles = files, mode = access, replayMessageId: string | null | undefined = view.replayId) {
    if ((!text.trim() && !readyFiles.length && !replayMessageId) || !directory || loadingChat) return;
    const message = text.trim();
    const command = slashCommand(message);
    if (command && quickCommand(command.name)) return;
    if (busy) return;
    if (command?.name === "compact") {
      if (compactContext(mode)) setDraft("");
      return;
    }
    if (!modelId) return;
    if (!secretBypass.current && findSecrets(message).length) { setSecretWarning(true); return; }
    secretBypass.current = false;
    setSecretWarning(false);
    if (!vision && readyFiles.some(file => file.image)) {
      showError("Выбранная модель не принимает изображения.");
      return;
    }
    const skill = command && tools?.skills.find(item => command.name === "skill." + item.name);
    const custom = command && tools?.commands.find(item => item.name === command.name);
    const turn: PendingTurn = {
      modelId, files: readyFiles,
      text: skill ? command?.args.trim() || "Примени навык «" + skill.name + "» к текущей задаче." : message,
      options: { access: mode, replayMessageId: replayMessageId ?? undefined, variant: variant || undefined,
        command: command && custom ? { name: command.name, args: command.args } : undefined,
        skill: skill ? skill.id : undefined }
    };
    setDraft("");
    setFiles([]);
    editView({ replayId: undefined });
    void runTurn(turn);
  }

  function compactContext(mode = access) {
    if (!chat) { showError("Сначала откройте чат."); return false; }
    if (!modelId || !directory || loadingChat || busy) return false;
    void runTurn({ modelId, files: [], text: "/compact", options: { compact: true, access: mode, variant: variant || undefined } });
    return true;
  }

  function selectAccess(next: AccessMode, confirmed = false) {
    if (!confirmed) { setAccess(next); return; }
    void api.preferences({ fullAccessConfirmed: true }).then(saved => {
      setPrefs(value => value ? { ...value, fullAccessConfirmed: saved.fullAccessConfirmed } : saved);
      setAccess(next);
    }).catch(showError);
  }

  function cycleAccess() {
    const next = accessModes[(accessModes.indexOf(access) + 1) % accessModes.length];
    if (next === "full" && !prefs?.fullAccessConfirmed) {
      setAccess(accessModes[0]);
      setAccessMenu(value => value + 1);
    } else setAccess(next);
  }

  async function changeChat(session: Conversation, action: ChatAction) {
    try {
      const next = await api.chatAction(session.id, action);
      setSessions(list => next ? [next, ...list.filter(item => item.id !== next.id)] : list.filter(item => item.id !== session.id));
      if (action.type === "fork" && next) await openChat(next);
      else if (activeChat.current === session.id) {
        if (!next || next.archived) showHome(session.directory);
        else setChat(next);
      }
    } catch (error) { showError(error); }
  }

  async function restoreHistory(load: (id: string) => ReturnType<DesktopApi["history"]>, draft?: Extract<ChatPart, { kind: "user" | "text" }>) {
    if (!chat || busy || loadingChat) return;
    const id = chat.id;
    updateView(id, () => ({ loading: true }));
    try {
      const history = await load(id);
      updateView(id, () => ({ ...applyHistory(history), planReady: false, ...(draft && {
        draft: draft.text, replayId: draft.files?.length ? draft.id : undefined
      }) }));
      if (draft && activeChat.current === id) requestAnimationFrame(() => draftInput.current?.focus());
    } catch (error) { showError(error); }
    finally { updateView(id, () => ({ loading: false })); }
  }

  function revertMessage(message?: string) {
    if (!busy && (!message || window.confirm("Откатить чат и вернуть файлы к состоянию перед этим сообщением?"))) {
      void restoreHistory(id => api.revert(id, message));
    }
  }

  function editMessage(part: Extract<ChatPart, { kind: "user" | "text" }>) {
    if (!busy && window.confirm("Вернуть историю и файлы к этому сообщению, чтобы отредактировать его?")) {
      void restoreHistory(id => api.revert(id, part.id), part);
    }
  }

  function revertFile(file: string) {
    if (!busy && window.confirm("Отменить изменения файла «" + file + "»?")) void restoreHistory(id => api.revertFile(id, file));
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.key === "Escape" && busy) {
        const time = Date.now();
        if (time - lastEscape.current < 900) { stop(); lastEscape.current = 0; }
        else lastEscape.current = time;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.code;
      if (!["KeyN", "KeyK", "KeyB", "KeyJ", "Comma"].includes(key)) return;
      event.preventDefault();
      if (key === "KeyN") void startChat();
      if (key === "KeyK") searchInput.current?.focus();
      if (key === "KeyB") setPanel(value => !value);
      if (key === "KeyJ") { setSettings(false); setSubscriptions(false); setPanelTab("terminal"); setPanel(true); }
      if (key === "Comma") { setSettingsModels(false); setSettings(value => subscriptions || !value); setSubscriptions(false); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  function updatePrefs(patch: Partial<Preferences>) {
    const revision = ++preferenceRevision.current;
    setPrefs(current => current && { ...current, ...patch });
    void api.preferences(patch).then(saved => {
      if (revision === preferenceRevision.current) setPrefs(saved);
    }).catch(error => {
      showError(error);
      void api.initial().then(info => {
        if (revision === preferenceRevision.current) setPrefs(info.preferences);
      }).catch(() => {});
    });
  }

  async function disconnect(id: ConnectionId) {
    try {
      setCatalog(await api.disconnect(id));
      if (id === "groq-api") setPrefs(current => current && { ...current, voiceGroq: false });
      setRouteProvider(undefined);
    } catch (error) { showError(error); }
  }

  function connectFromNotice() {
    if (!notice?.connect || !catalog) return;
    const { modelId, providerId } = notice.connect;
    const model = catalog.catalog.models.find(model => model.id === modelId);
    const provider = catalog.catalog.providers.find(provider => provider.id === providerId);
    if (model && provider) {
      if (catalog.connected.includes(provider.id)) {
        setModel(model.id);
        setRouteProvider(undefined);
      }
      else setConnection(catalogConnection(provider, model));
      setNotice(undefined);
    }
  }

  function openPreview(ref: FileReference) {
    setPreview(ref);
    setPanelTab("preview");
    setPanel(true);
  }

  const anyRunning = Object.values(running).some(isRunning);
  useEffect(() => {
    if (applyAfterReply && updateReady && !anyRunning) { setApplyAfterReply(false); void api.applyUpdate().catch(showError); }
  }, [applyAfterReply, updateReady, anyRunning, showError]);
  const panelShown = Boolean(directory && panel && !settings && !subscriptions);
  const panelSize = panelWidth ?? prefs?.panelWidth ?? 360;
  useEffect(() => {
    document.documentElement.style.setProperty("--panel-offset", panelShown ? panelSize + "px" : "0px");
  }, [panelShown, panelSize]);
  const capacity = usage?.context ?? contextWindow;
  const typical = modelId && currentProviderId ? modelSpeed(modelId, ownModel?.providerId ?? selected?.available[0]?.provider.id ?? currentProviderId, catalog?.speeds, catalog?.benchmarks) : undefined;
  const demo = !!api.onDemoQuota;
  const composer = <>
    {secretWarning && <div className="secret-warning" role="alert">
      <span>Похоже, в сообщении ключ или пароль. Бесплатные провайдеры могут хранить запросы.</span>
      <button type="button" className="small-button" onClick={() => { setSecretWarning(false); setDraft(maskSecrets(draft)); }}>Заменить на ***</button>
      <button type="button" className="composer-control" onClick={() => { secretBypass.current = true; setSecretWarning(false); submit(); }}>Отправить как есть</button>
    </div>}
    <Composer key={chat?.id ?? directory} preferences={prefs} updatePreferences={updatePrefs} active={!!chat} input={draftInput} draft={draft} change={setDraft} directory={directory} busy={busy}
      projects={projectDirectories} switchProject={path => { if (!busy && path !== directory) void startChat(path); }}
      canSend={!!modelId && !!directory && !loadingChat} attachments={files} remove={id => setFiles(items => items.filter(file => file.id !== id))}
      add={value => void captureFiles(value)} pick={() => void chooseFiles()} choose={() => void chooseDirectory(false, true)}
      access={access} accessMenu={accessMenu} selectAccess={selectAccess} cycle={cycleAccess} submit={submit} stop={stop} selectCommand={quickCommand} tools={tools} vision={vision} onError={showError}
      modelControls={<ModelPicker selected={modelId} catalog={catalog?.catalog} options={options} personal={personal} zen={zen} auto={prefs?.auto ?? true} latencies={catalog?.latencies} speeds={catalog?.speeds} benchmarks={catalog?.benchmarks}
          variant={variant} variants={variants} onVariant={setVariant}
          openSignal={modelMenu} onSelect={id => editView({ model: id, variant: "", provider: undefined })}
          onAuto={auto => updatePrefs({ auto })} onConnect={setConnection} onSubscriptions={() => setSubscriptions(true)} />} />
    <ComposerStatus key={"stats:" + (chat?.id ?? directory)} state={catalog} providerId={currentProviderId} usage={usage}
      capacity={capacity} speed={view.liveSpeed ?? view.speed} typical={!demo ? typical : undefined} cache={view.cache} stats={routerStats} demo={demo} demoRemaining={demoRemaining}
      onCompact={chat && !demo && !loadingChat && !busy ? () => compactContext() : undefined} onConnect={setConnection} onDisconnect={disconnect}
      onOpen={url => void api.openExternal(url).catch(showError)} onSettings={() => { setSettingsModels(true); setSettings(true); }} />
  </>;

  return <>
    <div className="app">
      <header className="titlebar" onDoubleClick={() => void api.windowAction("maximize")}>
        <span className="window-name"><img src={logo} width="14" height="14" alt="" />vsemkod</span>
        <div className="window-controls">
          <button className="window-control" type="button" aria-label="Свернуть" onClick={() => void api.windowAction("minimize")}><Icon name="minus" /></button>
          <button className="window-control" type="button" aria-label="Развернуть или восстановить" onClick={() => void api.windowAction("maximize")}><Icon name="maximize" /></button>
          <button className="window-control window-close" type="button" aria-label="Закрыть окно" onClick={() => void api.windowAction("close")}><Icon name="close" /></button>
        </div>
      </header>
      <aside className="sidebar" aria-label="Чаты и настройки">
        <button type="button" className="wordmark" onClick={() => showHome(visibleProject || directory)}>
          <img src={logo} width="18" height="18" alt="" /><span>vsem<span className="wordmark-suffix">kod</span></span>
        </button>
        <button className="sidebar-row sidebar-row--new" type="button" onClick={() => void startChat()}><Icon name="newChat" />Новый чат</button>
        <label className="sidebar-row search">
          <Icon name="search" /><input ref={searchInput} type="search" value={query} aria-label="Поиск чатов" placeholder="Поиск чатов" onChange={event => setQuery(event.target.value)} />
        </label>
        <ChatGroups sessions={sessions} projects={projectDirectories} selectedProject={visibleProject} query={query}
          active={!settings && !subscriptions ? chat?.id : undefined} running={running} expand={expandProject}
          addProject={() => void chooseDirectory()} selectProject={path => {
            setVisibleProject(path);
            if (!activeChat.current && !cached.current[homeId]?.loading) {
              setDirectory(path);
              setFiles([]);
            }
          }} start={path => void startChat(path)}
          openProject={api.projectOpen ? path => void api.projectOpen?.(path).catch(showError) : undefined}
          removeProject={api.projectRemove ? path => void removeProject(path) : undefined}
          open={session => void openChat(session)} perform={changeChat} />
        <div className="sidebar-end">
          <button type="button" className="sidebar-row community-row" title="Telegram-канал сообщества: раздачи моделей, промпты и помощь"
            onClick={() => void api.openExternal(COMMUNITY_URL).catch(showError)}><Icon name="telegram" />Сообщество вайб‑кодеров</button>
          <button type="button" className="sidebar-row" aria-current={settings || subscriptions ? "page" : undefined}
            onClick={() => { setSettingsModels(false); setSettings(subscriptions || !settings); setSubscriptions(false); }}><Icon name="settings" />Настройки</button>
          <p className="catalog-note">{catalogAge(catalog?.catalog.generatedAt)}</p>
        </div>
      </aside>
      <div className="workspace-layout">
        {subscriptions ? <ConnectionsPage state={catalog} close={() => setSubscriptions(false)} connect={setConnection} />
          : settings ? <Settings state={catalog} prefs={prefs} version={initial?.version} directory={directory} choose={() => void chooseDirectory(true)} showModels={settingsModels}
            update={updatePrefs} subscriptionsPage={() => setSubscriptions(true)} connect={setConnection} disconnect={disconnect}
            checkUpdates={() => void checkUpdates()} checkingUpdates={checkingUpdates}
            open={url => void api.openExternal(url).catch(showError)} onError={showError} onNotice={text => notify({ text })}
            onCatalog={setCatalog} exportAll={() => void exportChats()} />
          : chat ? <Chat key={chat.id} title={chat.title} parts={parts} permissions={permissions} questions={questions} changeCount={changes.length}
            busy={busy || !!loadingChat} status={status} progress={progress} failure={failed?.message}
             directory={directory} preview={openPreview} onError={showError}
            retryFailed={retryFailed} chooseModel={() => setModelMenu(value => value + 1)} panel={panel} openPanel={() => { if (!panel) setPanelTab("changes"); setPanel(value => !value); }}
            answer={(id, decision) => api.answer(chat.id, id, decision)} answerQuestion={(id, value) => api.answerQuestion(chat.id, id, value)}
            copy={text => void api.copyText(text).then(() => notify({ text: "Скопировано" })).catch(showError)}
            edit={part => void editMessage(part)} revert={message => void revertMessage(message)} retry={part => submit(part.text, [], access, part.files?.length ? part.id : null)}
            reverted={!!reverted} executePlan={planReady ? () => {
              const mode = prefs?.defaultAccess === "edit" ? "edit" : "ask";
              setAccess(mode);
              submit("Выполни план", [], mode, null);
            } : undefined}>
            {composer}
          </Chat> : <main className="workspace workspace--home">
            <button className="composer-control home-panel-toggle" type="button" aria-label="Правая панель" aria-expanded={panel}
              title="Правая панель · Ctrl+B" onClick={() => setPanel(value => !value)}><Icon name="panel" /></button>
            <div className="home">
              <h1>Чем займёмся?</h1>
              {composer}
              <div className="suggestions" aria-label="Подсказки">
                {suggestions.map(suggestion => <button type="button" className="suggestion" key={suggestion} onClick={() => {
                  setDraft(suggestion);
                  draftInput.current?.focus();
                }}>{suggestion}</button>)}
              </div>
            </div>
          </main>}
        {directory && <WorkspacePanel key={directory} directory={directory} tab={panelTab} setTab={setPanelTab} preview={preview} openPreview={openPreview} visible={panel && !settings && !subscriptions}
          width={panelWidth ?? prefs?.panelWidth ?? 360} resize={(width, final) => {
            const next = Math.max(260, Math.min(700, window.innerWidth - 490, Math.round(width)));
            if (final) { updatePrefs({ panelWidth: next }); setPanelWidth(undefined); }
            else setPanelWidth(next);
          }} close={() => setPanel(false)} parts={parts} changes={changes} revert={file => void revertFile(file)} busy={busy || !!loadingChat}
          theme={theme} onError={showError}
          insertDraft={text => { setDraft((draft.trim() ? draft.trimEnd() + "\n\n" : "") + text); draftInput.current?.focus(); }}
          notify={text => notify({ text })} />}
      </div>
    </div>
    {connection && <ConnectDialog key={connection.id + "/" + (connection.model?.id ?? "")} connection={connection}
      clipboard={prefs?.clipboard ?? false} close={() => setConnection(undefined)} connected={state => {
        setCatalog(state);
        if (connection.model) setModel(connection.model.id);
        setRouteProvider(undefined);
        setConnection(undefined);
        notify({ text: "Подключено: " + connection.name });
      }} />}
    {notice && <div className={"toast" + (notice.tone === "error" ? " toast--error" : "")}
      role={notice.tone === "error" ? "alert" : "status"}><span className="status-dot" />
      <span>{notice.text}</span>
      {notice.connect && <button type="button" className="connect-label" onClick={connectFromNotice}>Подключить</button>}
      {notice.open && <button type="button" className="connect-label" onClick={() => {
        const target = sessions.find(item => item.id === notice.open);
        setNotice(undefined);
        if (target) void openChat(target);
      }}>Открыть</button>}
      <button className="composer-control attach" type="button" aria-label="Закрыть уведомление" onClick={() => setNotice(undefined)}><Icon name="close" /></button>
    </div>}
    <UpdatePill ready={updateReady} downloading={updateProgress} busy={Object.values(statuses.current).some(isRunning)}
      apply={() => void api.applyUpdate().catch(showError)} applyAfterReply={() => setApplyAfterReply(true)} />
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
