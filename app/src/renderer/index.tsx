import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Attachment, ChatAction, ChatHistory, ProjectTools, Question, TurnOptions, Usage, CatalogState, ChatEvent, ChatPart, ConnectionId, Conversation, DesktopApi, FileChange, InitialState, Notice, Permission, Preferences, UpdateReady } from "../shared/api";
import type { ReplySpeed, RouterStats } from "../shared/api";
import { Chat } from "./chat";
import { catalogConnection, ConnectDialog, ConnectionsPage, readableError, type Connection } from "./connections";
import { accessModes, enqueue, dequeue, slashCommand, type AccessMode } from "../shared/workspace";
import { defaultModel } from "../shared/catalog";
import type { ChatStatus } from "./turns";
import { ChatGroups } from "./chat-groups";
import { Composer } from "./composer";
import { ComposerStatus } from "./composer-status";
import { Settings } from "./settings";
import { WorkspacePanel, type PanelTab } from "./workspace-panel";
import { Icon } from "./icons";
import { ModelPicker, modelOptions } from "./models";
import logo from "./assets/logo.svg";

declare global {
  interface Window { vsemkod: DesktopApi }
}

const api = window.vsemkod;
const suggestions = ["Создать лендинг", "Найти баг", "Объяснить код", "Написать тесты"];
type PendingTurn = { id: string; text: string; modelId: string; files: Attachment[]; options: TurnOptions; target?: string };

function catalogAge(date?: string) {
  if (!date) return "Загружаем каталог моделей";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60_000));
  if (minutes < 1) return "Каталог моделей обновлён только что";
  if (minutes < 60) return "Каталог моделей обновлён " + minutes + " мин назад";
  if (minutes < 24 * 60) return "Каталог моделей обновлён " + Math.floor(minutes / 60) + " ч назад";
  return "Каталог моделей обновлён " + new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(Date.parse(date));
}

function replacePart(parts: ChatPart[], part: ChatPart) {
  const index = parts.findIndex(item => item.id === part.id);
  if (index < 0) return [...parts, part];
  return parts.map((item, position) => position === index ? part : item);
}

function App() {
  const [initial, setInitial] = useState<InitialState>();
  const [catalog, setCatalog] = useState<CatalogState>();
  const [prefs, setPrefs] = useState<Preferences>();
  const [directory, setDirectory] = useState("");
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [chat, setChat] = useState<Conversation>();
  const [settings, setSettings] = useState(false);
  const [settingsModels, setSettingsModels] = useState(false);
  const [subscriptions, setSubscriptions] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [replayId, setReplayId] = useState<string>();
  const [files, setFiles] = useState<Attachment[]>([]);
  const [parts, setParts] = useState<ChatPart[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [queue, setQueue] = useState<PendingTurn[]>([]);
  const [access, setAccess] = useState<AccessMode>("ask");
  const [variant, setVariant] = useState("");
  const [variants, setVariants] = useState<string[]>([]);
  const [tools, setTools] = useState<ProjectTools>();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [usage, setUsage] = useState<Usage>();
  const [replyStats, setReplyStats] = useState<Record<string, { speed?: ReplySpeed; cache?: number }>>({});
  const [routerStats, setRouterStats] = useState<RouterStats>();
  const [demoRemaining, setDemoRemaining] = useState<number>();
  const [reverted, setReverted] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  const [panel, setPanel] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("changes");
  const [panelWidth, setPanelWidth] = useState<number>();
  const [modelMenu, setModelMenu] = useState(0);
  const [systemTheme, setSystemTheme] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const searchInput = useRef<HTMLInputElement>(null);
  const lastEscape = useRef(0);
  const stopping = useRef<Promise<void> | undefined>(undefined);
  const stopPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ started: number; since: number | null }>();
  const [failures, setFailures] = useState<Record<string, { message: string; turn: PendingTurn }>>({});
  const [loadingChat, setLoadingChat] = useState(false);
  const [model, setModel] = useState<string>();
  const [routeProvider, setRouteProvider] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [updateReady, setUpdateReady] = useState<UpdateReady>();
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [connection, setConnection] = useState<Connection>();
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const currentDirectory = useRef(directory);
  currentDirectory.current = directory;
  const activeChat = useRef<string | undefined>(undefined);
  const requestPending = useRef(false);
  const preferenceRevision = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const liveCatalog = useRef(catalog);
  const lastRoute = useRef<string | undefined>(undefined);
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
    void api.initial().then(info => {
      if (!mounted) return;
      setInitial(info);
      if (!live) setCatalog(info);
      if (!liveUpdate) setUpdateReady(info.update);
      setPrefs(info.preferences);
      setAccess(info.preferences.defaultAccess);
      setDirectory(info.preferences.directory);
      setRecentProjects(info.projects ?? []);
    }).catch(showError);
    return () => { mounted = false; stopCatalog(); stopNotice(); stopUpdate(); clearTimeout(noticeTimer.current); };
  }, [notify, showError]);

  useEffect(() => api.onChat((event: ChatEvent) => {
    if (event.sessionId !== activeChat.current) return;
    if (event.type === "part") setParts(value => replacePart(value, event.part));
    if (event.type === "delta") setParts(value => {
      const kind = event.kind ?? "text";
      const part = value.find(part => part.id === event.partId);
      return replacePart(value, { id: event.partId, kind, text: (part?.kind === kind ? part.text : "") + event.delta });
    });
    if (event.type === "model-wait") setProgress(value => value && { ...value, since: event.since });
    if (event.type === "permission") setPermissions(value => [...value.filter(item => item.id !== event.permission.id), event.permission]);
    if (event.type === "permission-resolved") setPermissions(value => value.filter(item => item.id !== event.id));
    if (event.type === "question") setQuestions(current => [...current.filter(item => item.id !== event.question.id), event.question]);
    if (event.type === "question-resolved") setQuestions(current => current.filter(item => item.id !== event.id));
    if (event.type === "usage") {
      setUsage(event.usage);
      if (event.speed || event.nativeCachePercent !== undefined) setReplyStats(state => {
        const previous = state[event.sessionId];
        return { ...state, [event.sessionId]: {
          speed: event.speed ?? previous?.speed,
          cache: event.nativeCachePercent === undefined ? previous?.cache : event.nativeCachePercent ?? undefined
        } };
      });
    }
    if (event.type === "reply-cache") setReplyStats(state => ({
      ...state, [event.sessionId]: { ...state[event.sessionId], cache: event.cachePercent }
    }));
    if (event.type === "route") {
      setRouteProvider(event.providerId);
      const route = event.modelId + "/" + event.providerId;
      if (event.previousModelId && lastRoute.current !== route) {
        const names = liveCatalog.current?.catalog;
        const modelName = (id: string) => names?.models.find(model => model.id === id)?.name ?? id;
        const providerName = (id: string) => names?.providers.find(provider => provider.id === id)?.name ?? id;
        const previousProvider = event.previousModelId === event.modelId ? event.previousProviderId : undefined;
        const next = previousProvider ? providerName(event.providerId) : modelName(event.modelId);
        const previous = previousProvider ? providerName(previousProvider) : modelName(event.previousModelId);
        notify({ text: "Переключился на " + next + (event.reason === "quota"
          ? " — у " + previous + " кончилась квота" : " — " + previous + " временно недоступен") });
      }
      if (event.averageMs !== undefined) setCatalog(state => state && { ...state,
        latencies: [...(state.latencies ?? []).filter(item => item.modelId !== event.modelId || item.providerId !== event.providerId),
          { modelId: event.modelId, providerId: event.providerId, averageMs: event.averageMs }]
      });
      lastRoute.current = route;
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
      if (current) { setVariants(items); setVariant(value => items.includes(value) ? value : ""); }
    }).catch(() => {});
    return () => { current = false; };
  }, [directory, modelId]);

  function resetChat() {
    activeChat.current = undefined;
    setChat(undefined);
    setSettings(false);
    setSubscriptions(false);
    setParts([]);
    setChanges([]);
    setPermissions([]);
    setFiles([]);
    setDraft("");
    setRouteProvider(undefined);
    setQuestions([]);
    setUsage(undefined);
    setReverted(false);
    setPlanReady(false);
    setAccess(prefs?.defaultAccess ?? "ask");
    setQueue([]);
    setReplayId(undefined);
  }

  const projectDirectories = [...new Set([directory, ...recentProjects, ...sessions.map(item => item.directory), prefs?.directory]
    .filter((path): path is string => Boolean(path)))];
  const failed = chat && failures[chat.id];
  const status: ChatStatus | undefined = permissions.length ? "permission" : questions.length ? "question"
    : failed ? "error" : busy ? "working" : undefined;

  async function chooseDirectory(asDefault = false) {
    try {
      const chosen = await api.chooseDirectory();
      if (!chosen) return;
      setRecentProjects(list => [chosen, ...list.filter(path => path !== chosen)]);
      if (asDefault) {
        setPrefs(await api.preferences({ directory: chosen }));
        if (!chat) {
          setDirectory(chosen);
          setFiles([]);
        }
      } else if (chosen !== directory || settings || subscriptions) {
        setQuery("");
        startChat(chosen);
      }
    } catch (error) { showError(error); }
  }

  function acceptAttachments(added: Attachment[], target: string) {
    if (currentDirectory.current !== target) return;
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

  async function openChat(session: Conversation) {
    if (busy || loadingChat) return;
    setLoadingChat(true);
    try {
      const history = await api.history(session.id);
      resetChat();
      activeChat.current = session.id;
      setChat(session);
      setDirectory(session.directory);
      setAccess(session.access ?? prefs?.defaultAccess ?? "ask");
      setPlanReady(session.access === "read" && history.parts.findLast(part => part.kind !== "turn")?.kind === "text");
      setModel(session.modelId);
      setVariant(session.variant ?? "");
      showHistory(history);
    } catch (error) { showError(error); }
    finally { setLoadingChat(false); }
  }

  function showHistory(history: ChatHistory) {
    setParts(history.parts);
    setChanges(history.changes);
    setReverted(Boolean(history.reverted));
    setUsage(history.usage);
  }

  async function runTurn(turn: PendingTurn) {
    requestPending.current = true;
    stopPending.current = false;
    const started = Date.now();
    setBusy(true);
    setProgress({ started, since: started });
    setPlanReady(false);
    lastRoute.current = undefined;
    let session = chat;
    try {
      if (turn.target && turn.target !== chat?.id) throw new Error("Чат для сообщения уже закрыт.");
      if (!session) {
        const title = turn.text.replace(/\s+/g, " ").split(/(?<=[.!?])\s/, 1)[0].slice(0, 72) || turn.files[0]?.name.slice(0, 72) || "Новый чат";
        session = await api.create(directory, title);
        activeChat.current = session.id;
        setChat(session);
      }
      if (stopPending.current) {
        notify({ text: "Ответ остановлен" });
        return;
      }
      const sessionId = session.id;
      setFailures(list => {
        if (!list[sessionId]) return list;
        const next = { ...list };
        delete next[sessionId];
        return next;
      });
      const current = { ...session, access: turn.options.access, variant: turn.options.variant, modelId: turn.modelId, updatedAt: Date.now() };
      setChat(current);
      setSessions(list => [current, ...list.filter(item => item.id !== current.id)]);
      if (!turn.options.compact) setParts(list => [...list, { id: "local:" + turn.id, kind: "user", text: turn.text, files: turn.files.map(file => file.name) }]);
      const result = await api.send(session.id, turn.text, turn.modelId, turn.files.map(file => file.id), turn.options);
      setChanges(result.changes);
      const history = await api.history(session.id);
      showHistory(history);
      if (history.parts.at(-1)?.kind !== "turn") setParts(list => [...list, {
        id: "work:" + turn.id, kind: "turn", seconds: (Date.now() - started) / 1000, stopped: result.stopped
      }]);
      setPlanReady(!result.stopped && !turn.options.compact && turn.options.access === "read" &&
        history.parts.findLast(part => part.kind !== "turn")?.kind === "text");
      if (result.stopped) notify({ text: "Ответ остановлен" });
    } catch (error) {
      const message = readableError(error);
      notify({ text: message, tone: "error" });
      if (session) {
        const id = session.id;
        setFailures(list => ({ ...list, [id]: { message, turn: { ...turn, target: id } } }));
        const history = await api.history(id).catch(() => undefined);
        if (history) showHistory(history);
      }
      if (!turn.options.compact) { setDraft(value => value || turn.text); setFiles(value => value.length ? value : turn.files); }
    } finally {
      await stopping.current;
      setPermissions([]);
      setQuestions([]);
      requestPending.current = false;
      setProgress(undefined);
      setBusy(false);
    }
  }

  function retryFailed() {
    if (!failed || !modelId || requestPending.current || loadingChat) return;
    if (!vision && failed.turn.files.some(file => file.image)) {
      showError("Выбранная модель не принимает изображения.");
      return;
    }
    if (draft === failed.turn.text) setDraft("");
    if (files === failed.turn.files) setFiles([]);
    void runTurn({ ...failed.turn, id: crypto.randomUUID(), modelId,
      options: { ...failed.turn.options, variant: variant || undefined } });
  }

  function stop() {
    if (!requestPending.current || stopping.current) return;
    stopPending.current = true;
    if (!activeChat.current) return;
    const task = api.stop(activeChat.current).catch(showError).finally(() => { stopping.current = undefined; });
    stopping.current = task;
  }

  async function exportChats(sessionId?: string) {
    try {
      const saved = await api.exportChats(sessionId);
      if (saved) notify({ text: sessionId ? "Чат экспортирован" : "Сохранено чатов: " + saved });
    } catch (error) { showError(error); }
  }

  function startChat(folder?: string) {
    if (requestPending.current || loadingChat) return;
    resetChat();
    const next = folder ?? (directory || prefs?.directory || "");
    setDirectory(next);
    if (next) setRecentProjects(list => [next, ...list.filter(path => path !== next)]);
    requestAnimationFrame(() => draftInput.current?.focus());
  }

  function quickCommand(name: string) {
    if (name === "new") {
      if (requestPending.current) { showError("Дождитесь окончания работы агента."); return true; }
      startChat(directory);
    } else if (name === "plan") setAccess("read");
    else if (name === "model") setModelMenu(value => value + 1);
    else if (name === "export") {
      if (chat) void exportChats(chat.id);
      else showError("Сначала откройте чат.");
    } else return false;
    setDraft("");
    return true;
  }

  function submit(intervene = false, text = draft, readyFiles = files, mode = access, replayMessageId: string | null | undefined = replayId) {
    if ((!text.trim() && !readyFiles.length && !replayMessageId) || !directory || loadingChat) return;
    const message = text.trim();
    const command = slashCommand(message);
    if (command && quickCommand(command.name)) return;
    if (command?.name === "compact") {
      if (compactContext(intervene, mode)) setDraft("");
      return;
    }
    if (!modelId) return;
    if (!vision && readyFiles.some(file => file.image)) {
      showError("Выбранная модель не принимает изображения.");
      return;
    }
    const skill = command && tools?.skills.find(item => command.name === "skill." + item.name);
    const custom = command && tools?.commands.find(item => item.name === command.name);
    const turn: PendingTurn = {
      id: crypto.randomUUID(), modelId, files: readyFiles, target: chat?.id,
      text: skill ? command?.args.trim() || "Примени навык «" + skill.name + "» к текущей задаче." : message,
      options: { access: mode, replayMessageId: replayMessageId ?? undefined, variant: variant || undefined,
        command: command && custom ? { name: command.name, args: command.args } : undefined,
        skill: skill ? skill.id : undefined }
    };
    setDraft("");
    setFiles([]);
    setReplayId(undefined);
    scheduleTurn(turn, intervene);
  }

  function compactContext(intervene = false, mode = access) {
    if (!chat) { showError("Сначала откройте чат."); return false; }
    if (!modelId || !directory || loadingChat) return false;
    scheduleTurn({ id: crypto.randomUUID(), modelId, files: [], target: chat.id, text: "/compact",
      options: { compact: true, access: mode, variant: variant || undefined } }, intervene);
    return true;
  }

  function scheduleTurn(turn: PendingTurn, intervene: boolean) {
    if (requestPending.current || queue.length) {
      const interrupt = intervene || prefs?.busyEnter === "interrupt";
      setQueue(value => enqueue(value, turn, interrupt));
      if (interrupt) stop();
    } else void runTurn(turn);
  }

  useEffect(() => {
    if (busy || requestPending.current || !queue.length) return;
    const [next, rest] = dequeue(queue);
    setQueue(rest);
    if (next) void runTurn(next);
  }, [busy, queue]);

  function confirmFull() {
    return prefs?.fullAccessConfirmed || window.confirm("Включить полный доступ? Агент сможет изменять файлы и выполнять команды без подтверждения, в том числе за пределами проекта.");
  }

  function cycleAccess() {
    const next = accessModes[(accessModes.indexOf(access) + 1) % accessModes.length];
    if (next === "full" && !prefs?.fullAccessConfirmed) {
      if (!confirmFull()) return;
      void api.preferences({ fullAccessConfirmed: true }).then(saved => { setPrefs(saved); setAccess(next); }).catch(showError);
    } else setAccess(next);
  }

  async function changeChat(session: Conversation, action: ChatAction) {
    try {
      const next = await api.chatAction(session.id, action);
      setSessions(list => next ? [next, ...list.filter(item => item.id !== next.id)] : list.filter(item => item.id !== session.id));
      if (action.type === "fork" && next) await openChat(next);
      else if (chat?.id === session.id) {
        if (!next || next.archived) startChat(session.directory);
        else setChat(next);
      }
    } catch (error) { showError(error); }
  }

  async function revertMessage(message?: string) {
    if (!chat || requestPending.current || (message && !window.confirm("Откатить чат и вернуть файлы к состоянию перед этим сообщением?"))) return;
    setLoadingChat(true);
    try {
      showHistory(await api.revert(chat.id, message));
      setPlanReady(false);
    } catch (error) { showError(error); }
    finally { setLoadingChat(false); }
  }

  async function editMessage(part: Extract<ChatPart, { kind: "user" | "text" }>) {
    if (!chat || requestPending.current || !window.confirm("Вернуть историю и файлы к этому сообщению, чтобы отредактировать его?")) return;
    setLoadingChat(true);
    try {
      showHistory(await api.revert(chat.id, part.id));
      setDraft(part.text);
      setReplayId(part.files?.length ? part.id : undefined);
      setPlanReady(false);
      requestAnimationFrame(() => draftInput.current?.focus());
    } catch (error) { showError(error); }
    finally { setLoadingChat(false); }
  }

  async function revertFile(file: string) {
    if (!chat || requestPending.current || !window.confirm("Отменить изменения файла «" + file + "»?")) return;
    setLoadingChat(true);
    try { showHistory(await api.revertFile(chat.id, file)); }
    catch (error) { showError(error); }
    finally { setLoadingChat(false); }
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
      if (key === "KeyN") startChat();
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

  const capacity = usage?.context ?? contextWindow;
  const reply = chat ? replyStats[chat.id] : undefined;
  const demo = !!api.onDemoQuota;
  const composer = <>
    {queue.length > 0 && <ul className="message-queue" aria-label="Очередь сообщений">
      {queue.map(item => <li key={item.id}><span className="subtle">В очереди</span><span>{item.text || item.files.map(file => file.name).join(", ")}</span>
        <button className="composer-control attach" type="button" aria-label="Убрать из очереди" onClick={() => setQueue(value => value.filter(turn => turn.id !== item.id))}>
          <Icon name="close" />
        </button></li>)}
    </ul>}
    <Composer key={chat?.id ?? directory} preferences={prefs} updatePreferences={updatePrefs} active={!!chat} input={draftInput} draft={draft} change={setDraft} directory={directory} busy={busy}
      projects={projectDirectories} switchProject={path => { if (path !== directory) startChat(path); }}
      canSend={!!modelId && !!directory && !loadingChat} attachments={files} remove={id => setFiles(items => items.filter(file => file.id !== id))}
      add={value => void captureFiles(value)} pick={() => void chooseFiles()} choose={() => void chooseDirectory()}
      access={access} cycle={cycleAccess} submit={submit} stop={stop} selectCommand={quickCommand} tools={tools} vision={vision} onError={showError}
      modelControls={<ModelPicker selected={modelId} catalog={catalog?.catalog} options={options} personal={personal} zen={zen} auto={prefs?.auto ?? true} latencies={catalog?.latencies}
          variant={variant} variants={variants} onVariant={setVariant}
          openSignal={modelMenu} onSelect={id => { setModel(id); setVariant(""); setRouteProvider(undefined); }}
          onAuto={auto => updatePrefs({ auto })} onConnect={setConnection} onSubscriptions={() => setSubscriptions(true)} />} />
    <ComposerStatus key={"stats:" + (chat?.id ?? directory)} state={catalog} providerId={currentProviderId} usage={usage}
      capacity={capacity} speed={reply?.speed} cache={reply?.cache} stats={routerStats} demo={demo} demoRemaining={demoRemaining}
      onCompact={chat && !demo && !loadingChat ? () => compactContext() : undefined} onConnect={setConnection} onDisconnect={disconnect}
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
        <button type="button" className="wordmark" disabled={busy || loadingChat} onClick={() => startChat()}>
          <img src={logo} width="18" height="18" alt="" /><span>vsem<span className="wordmark-suffix">kod</span></span>
        </button>
        <button className="sidebar-row sidebar-row--new" type="button" disabled={busy || loadingChat} onClick={() => startChat()}><Icon name="newChat" />Новый чат</button>
        <label className="sidebar-row search">
          <Icon name="search" /><input ref={searchInput} type="search" value={query} aria-label="Поиск чатов" placeholder="Поиск чатов" onChange={event => setQuery(event.target.value)} />
        </label>
        <ChatGroups sessions={sessions} projects={projectDirectories} selectedProject={directory} query={query}
          active={!settings && !subscriptions ? chat?.id : undefined} statusChat={chat?.id} status={status}
          errors={Object.keys(failures)} addProject={() => void chooseDirectory()}
          disabled={busy || loadingChat} start={startChat} open={session => void openChat(session)} perform={changeChat} />
        <div className="sidebar-end">
          <button type="button" className="sidebar-row" aria-current={settings || subscriptions ? "page" : undefined} disabled={loadingChat}
            onClick={() => { setSettingsModels(false); setSettings(subscriptions || !settings); setSubscriptions(false); }}><Icon name="settings" />Настройки</button>
          <p className="catalog-note">{catalogAge(catalog?.catalog.generatedAt)}</p>
        </div>
      </aside>
      <div className="workspace-layout">
        {subscriptions ? <ConnectionsPage state={catalog} close={() => setSubscriptions(false)} connect={setConnection} />
          : settings ? <Settings state={catalog} prefs={prefs} version={initial?.version} directory={directory} choose={() => void chooseDirectory(true)} showModels={settingsModels}
            update={patch => {
              if (patch.defaultAccess === "full") {
                if (!confirmFull()) return;
                patch = { ...patch, fullAccessConfirmed: true };
              }
              updatePrefs(patch);
              if (!chat && patch.defaultAccess) setAccess(patch.defaultAccess);
            }} subscriptionsPage={() => setSubscriptions(true)} connect={setConnection} disconnect={disconnect}
            checkUpdates={() => void checkUpdates()} checkingUpdates={checkingUpdates}
            open={url => void api.openExternal(url).catch(showError)} onError={showError} onNotice={text => notify({ text })}
            onCatalog={setCatalog} exportAll={() => void exportChats()} />
          : chat ? <Chat key={chat.id} title={chat.title} parts={parts} permissions={permissions} questions={questions} changeCount={changes.length}
            busy={busy || loadingChat} status={status} progress={progress} failure={failed?.message}
            retryFailed={retryFailed} chooseModel={() => setModelMenu(value => value + 1)} panel={panel} openPanel={() => { if (!panel) setPanelTab("changes"); setPanel(value => !value); }}
            answer={(id, decision) => api.answer(chat.id, id, decision)} answerQuestion={(id, value) => api.answerQuestion(chat.id, id, value)}
            copy={text => void api.copyText(text).then(() => notify({ text: "Скопировано" })).catch(showError)}
            edit={part => void editMessage(part)} revert={message => void revertMessage(message)} retry={part => submit(false, part.text, [], access, part.files?.length ? part.id : null)}
            reverted={reverted} executePlan={planReady ? () => {
              const mode = prefs?.defaultAccess === "edit" ? "edit" : "ask";
              setAccess(mode);
              submit(false, "Выполни план", [], mode, null);
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
        {directory && <WorkspacePanel key={directory} directory={directory} tab={panelTab} setTab={setPanelTab} visible={panel && !settings && !subscriptions}
          width={panelWidth ?? prefs?.panelWidth ?? 360} resize={(width, final) => {
            const next = Math.max(260, Math.min(700, window.innerWidth - 490, Math.round(width)));
            if (final) { updatePrefs({ panelWidth: next }); setPanelWidth(undefined); }
            else setPanelWidth(next);
          }} close={() => setPanel(false)} parts={parts} changes={changes} revert={file => void revertFile(file)} busy={busy || loadingChat}
          theme={theme} onError={showError} />}
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
    {(notice || updateReady) && <div className={"toast" + (notice?.tone === "error" ? " toast--error" : "")}
      role={notice?.tone === "error" ? "alert" : "status"}><span className="status-dot" />
      <span>{notice?.text ?? (updateReady?.action === "download" ? "Вышла новая версия" : "Доступна версия " + updateReady?.version)}</span>
      {notice?.connect && <button type="button" className="connect-label" onClick={connectFromNotice}>Подключить</button>}
      {!notice && updateReady && <button type="button" className="connect-label"
        onClick={() => void api.applyUpdate().catch(showError)}>{updateReady.action === "download" ? "Скачать" : "Перезапустить"}</button>}
      <button className="composer-control attach" type="button" aria-label="Закрыть уведомление" onClick={() => {
        if (notice) setNotice(undefined);
        else setUpdateReady(undefined);
      }}><Icon name="close" /></button>
    </div>}
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
