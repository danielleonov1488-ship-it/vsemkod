import type { Attachment, CatalogState, ChatEvent, ChatHistory, Conversation, DesktopApi, FileChange, Notice, Preferences, ProjectEntry } from "../shared/api";
import { canOpenFile } from "../shared/file-links";
import type { Catalog, ProviderId } from "../shared/catalog-schema";
import { pathMentions } from "../shared/workspace";
import { replySpeed } from "../shared/usage";
import { version } from "../../package.json";
import { DemoError, startSession, status, streamChat, type DemoMessage, type DemoStatus } from "./transport";

export const project = "Демо-проект";
export const themeKey = "vsemkod-theme";
export type Theme = "dark" | "light";
export type Availability = { closed?: string; remaining?: number };

const files: Readonly<Record<string, string>> = {
  "README.md": "# Демо-проект\n\nНебольшое приложение с переключателем темы.\n",
  "package.json": '{\n  "name": "demo-project",\n  "private": true\n}\n',
  "src/App.tsx": 'export function App() {\n  return <main>Демо-проект</main>;\n}\n',
  "src/theme.ts": 'export type Theme = "light" | "dark";\nexport const defaultTheme: Theme = "dark";\n'
};
const entries: ProjectEntry[] = [
  { path: "src", type: "directory" },
  ...Object.keys(files).map(path => ({ path, type: "file" as const }))
];
// This provider exists only in the browser catalog and never reaches Electron or the worker.
const browserProvider = "browser-demo" as ProviderId;
const exampleModel = { id: "browser:example", name: "Kimi K3.1 Pro" };
const emptyCatalog: Catalog = { schemaVersion: 1, generatedAt: "", models: [], providers: [], offers: [], candidates: [] };

function browserCatalog(source: Catalog, model?: DemoStatus["model"], scenario = false): CatalogState {
  const date = source.generatedAt || new Date().toISOString();
  const url = location.origin;
  const demo: Catalog = model ? {
    ...source,
    models: [{ ...model, vendor: "vsemkod", description: "Бесплатно в браузере", tier: "top", contextWindow: 16_000,
      capabilities: ["code", "tools"], rank: 0 }, ...source.models],
    providers: [{ id: browserProvider, name: "браузере", api: "openai", baseUrl: url,
      auth: { type: "none" }, loginMethods: [], signupUrl: url, keyPageUrl: null, keyPattern: null, clicksToConnect: 0,
      freeLimits: {}, dataPolicy: "", termsUrl: url, notes: "" }, ...source.providers],
    offers: [{ modelId: model.id, providerId: browserProvider, providerModelId: model.id, free: true, promo: false,
      expiresAt: null, supportsTools: true, contextWindow: 16_000, limits: {}, status: "active", confidence: "structured",
      sources: [url], firstSeen: date, lastSeen: date, lastVerified: date }, ...source.offers]
  } : source;
  return { catalog: scenario && !demo.models.some(item => item.id === "browser:glm") ? {
    ...demo, models: [...demo.models, { id: "browser:glm", name: "GLM 5.3", vendor: "Z.ai",
      description: "Резервная модель", tier: "good", contextWindow: 16_000, capabilities: ["code"], rank: 1 }]
  } : demo, connected: model ? [browserProvider] : [], personal: [], subscriptions: [], personalModels: [], zenModels: [] };
}

function broadcast<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    emit(event: T) { for (const listener of listeners) listener(event); },
    listen(listener: (event: T) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}

export function readTheme(): Theme {
  try { if (localStorage.getItem(themeKey) === "light") return "light"; } catch {}
  return "dark";
}

type ScriptEvent = ChatEvent extends infer Event ? Event extends { sessionId: string } ? Omit<Event, "sessionId"> : never : never;
export type ScriptTurn = (emit: (event: ScriptEvent) => void, signal: AbortSignal) => Promise<FileChange[]>;
type Thread = { conversation: Conversation; history: ChatHistory; reverted?: ChatHistory };

export function createDemo({ scenario, showDesktop, setAvailability }: {
  scenario: boolean; showDesktop: () => void; setAvailability: (state: Availability) => void;
}) {
  const chats = new Map<string, Thread>();
  const requests = new Map<string, AbortController>();
  const chat = broadcast<ChatEvent>();
  const notices = broadcast<Notice>();
  const quota = broadcast<number | undefined>();
  const noSubscription = () => () => {};
  const desktop = async () => { showDesktop(); };
  const prefs: Preferences = {
    directory: project, theme: readTheme(), auto: scenario, clipboard: false, catalogUpdates: true, fontSize: "normal",
    defaultAccess: "ask", fullAccessConfirmed: false, busyEnter: "queue", notifications: true, notificationSound: true,
    keepAwake: false, panelWidth: 360, agentSteps: 0, webSearch: false
  };
  let demoModel = scenario ? exampleModel : undefined;
  let catalogState = browserCatalog(emptyCatalog, demoModel, scenario);
  let initialization: Promise<void> | undefined;
  let session: Awaited<ReturnType<typeof startSession>> | undefined;
  let availability: Availability = {};
  let scriptTurn: ScriptTurn | undefined;
  const feedback = (state: Availability) => { availability = state; setAvailability(state); quota.emit(state.remaining); };
  const offline = "Живой чат временно недоступен.";

  async function initialize() {
    const [catalog, online] = await Promise.allSettled([
      fetch(new URL("../catalog.json", location.href), { signal: AbortSignal.timeout(8000) }).then(response => {
        if (!response.ok) throw new Error("Не удалось загрузить каталог.");
        return response.json() as Promise<Catalog>;
      }),
      scenario ? undefined : status()
    ]);
    if (online.status === "fulfilled" && online.value) {
      const { model, open, remaining } = online.value;
      if (model?.name && model.id) demoModel = { id: "browser:" + model.id, name: model.name };
      if (!open) feedback({ remaining: 0, closed: "Дневная квота демо исчерпана." });
      else if (!demoModel) feedback({ closed: offline });
      else if (remaining !== undefined) feedback({ remaining });
    } else if (!scenario) feedback({ closed: offline });
    const source = catalog.status === "fulfilled" ? catalog.value : emptyCatalog;
    catalogState = browserCatalog(source, demoModel, scenario);
    if (catalog.status === "rejected") notices.emit({ text: "Не удалось загрузить каталог моделей.", tone: "error" });
    if (availability.closed) notices.emit({ text: availability.closed, tone: "error" });
  }

  function thread(id: string) {
    const stored = chats.get(id);
    if (!stored) throw new Error("Чат уже закрыт.");
    return stored;
  }

  function publish(id: string, history: ChatHistory, event: ScriptEvent) {
    if (event.type === "part") {
      const index = history.parts.findIndex(part => part.id === event.part.id);
      if (index < 0) history.parts.push(event.part);
      else history.parts[index] = event.part;
    }
    if (event.type === "delta") {
      const index = history.parts.findIndex(part => part.id === event.partId);
      const previous = history.parts[index];
      const kind = event.kind ?? "text";
      const part = { id: event.partId, kind, text: (previous?.kind === kind ? previous.text : "") + event.delta };
      if (index < 0) history.parts.push(part);
      else history.parts[index] = part;
    }
    if (event.type === "usage") history.usage = event.usage;
    if (event.type === "part" && event.part.kind === "tool" && event.part.diff) {
      const diff = event.part.diff;
      history.changes = [...history.changes.filter(change => change.file !== diff.file), diff];
    }
    chat.emit({ ...event, sessionId: id });
  }

  function applyTheme(theme: Theme, broadcastTheme: boolean) {
    prefs.theme = theme;
    document.documentElement.dataset.theme = theme;
    if (!broadcastTheme) return;
    try { localStorage.setItem(themeKey, theme); } catch {}
    if (parent !== window) parent.postMessage({ type: "vsemkod:theme", theme }, location.origin);
  }

  function mockFile(path: string) {
    if (!Object.hasOwn(files, path)) return null;
    const parts = path.split("/");
    return { path, relativePath: path, name: parts.pop()!, directory: parts.join("/"),
      image: false, svg: false, html: false, canOpen: canOpenFile(path) };
  }

  const api: DesktopApi = {
    async fileStat(directory, path) { return directory === project ? mockFile(path) : null; },
    async filePreview(directory, path) {
      const info = directory === project && mockFile(path);
      if (!info) throw new Error("В демо нет такого файла.");
      return { info, text: files[path] };
    },
    async fileAction() { await desktop(); },
    async initial() {
      await (initialization ??= initialize());
      return { ...catalogState, projects: [project], preferences: { ...prefs }, version };
    },
    async sessions(directory) {
      return [...chats.values()].map(item => item.conversation).filter(item => !directory || item.directory === directory);
    },
    async create(directory, title) {
      const conversation = { id: scenario ? "example-thread" : crypto.randomUUID(), title, directory, updatedAt: Date.now(), modelId: demoModel?.id };
      chats.set(conversation.id, { conversation, history: { parts: [], changes: [] } });
      return conversation;
    },
    async history(id) { return structuredClone(thread(id).history); },
    async send(id, text, modelId, attachments, options) {
      if (modelId !== demoModel?.id) throw new Error("Эта модель доступна в приложении.");
      if (!text.trim() || text.length > 2000) throw new Error("Введи сообщение до 2000 символов.");
      if (options?.compact || options?.command || options?.skill) {
        showDesktop();
        throw new Error("Эта команда работает в приложении.");
      }
      if (!scenario && availability.closed) throw new Error(availability.closed);
      if (requests.has(id)) throw new Error("Ответ уже отправляется.");
      const stored = thread(id);
      const history = structuredClone(stored.history);
      const started = Date.now();
      const controller = new AbortController();
      const { signal } = controller;
      requests.set(id, controller);
      const emit = (event: ScriptEvent) => publish(id, history, event);
      const user = { id: crypto.randomUUID(), kind: "user" as const, text, files: attachments };
      const partId = crypto.randomUUID();
      history.parts.push(user);
      history.reverted = false;
      let stopped = false;
      try {
        if (scenario) {
          if (!scriptTurn) throw new Error("Сценарий ещё загружается.");
          history.changes = await scriptTurn(emit, signal);
        } else {
          const messages = history.parts.flatMap<DemoMessage>(part => part.kind === "user" || part.kind === "text"
            ? [{ role: part.kind === "user" ? "user" : "assistant", content: part.text }]
            : []).slice(-8);
          const mentions = pathMentions(text).map(({ path }) => Object.hasOwn(files, path) ? path + "\n" + files[path] : "");
          const context = mentions.filter(Boolean).join("\n\n");
          if (context && text.length < 1970) messages.at(-1)!.content += ("\n\nФайлы демо-проекта:\n" + context).slice(0, 2000 - text.length);
          const liveSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
          const request = async () => {
            if (!session || session.expiresAt <= Date.now()) {
              session = await startSession(liveSignal);
              feedback({ remaining: session.remaining });
            }
            if (session.remaining <= 0) throw new DemoError("limit", "Сообщения закончились.");
            const start = performance.now();
            let first: number | undefined;
            const result = await streamChat(session.token, messages, liveSignal, delta => {
              if (delta) first ??= performance.now();
              emit({ type: "delta", partId, delta });
            });
            if (result.usage) {
              const { output, reasoning } = result.usage;
              emit({ type: "usage", usage: result.usage, speed: replySpeed(output, reasoning, start, first, performance.now()) });
            }
            return result.remaining;
          };
          let remaining: number;
          try {
            remaining = await request();
          } catch (error) {
            if (!(error instanceof DemoError) || error.code !== "auth") throw error;
            session = undefined;
            if (history.parts.some(part => part.id === partId)) emit({ type: "part", part: { id: partId, kind: "text", text: "" } });
            remaining = await request();
          }
          if (session) session.remaining = remaining;
          feedback(remaining > 0 ? { remaining } : { remaining, closed: "Сообщения в демо закончились." });
          if (availability.closed) notices.emit({ text: availability.closed });
        }
      } catch (error) {
        if (signal.aborted) stopped = true;
        else {
          if (error instanceof DemoError && error.code === "auth") session = undefined;
          if (error instanceof DemoError && (error.code === "limit" || error.code === "closed")) feedback({ remaining: 0, closed: error.message });
          if (error instanceof TypeError) throw new Error(offline);
          if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("Сервер отвечает слишком долго. Попробуй ещё раз.");
          throw error;
        }
      } finally {
        requests.delete(id);
      }
      history.parts.push({ id: crypto.randomUUID(), kind: "turn", seconds: (Date.now() - started) / 1000, stopped });
      stored.history = history;
      stored.reverted = undefined;
      stored.conversation = { ...stored.conversation, updatedAt: Date.now(), modelId, access: options?.access };
      return { changes: history.changes, stopped };
    },
    onDemoQuota(listener) { listener(availability.remaining); return quota.listen(listener); },
    async stop(id) { requests.get(id)?.abort(); },
    async answer(id, permissionId) { chat.emit({ type: "permission-resolved", sessionId: id, id: permissionId }); },
    async answerQuestion(id, formId) { chat.emit({ type: "question-resolved", sessionId: id, id: formId }); },
    async chooseDirectory() { await desktop(); return null; },
    async chooseFiles() { await desktop(); return []; },
    filePath() { return ""; },
    async captureFiles(): Promise<Attachment[]> { await desktop(); return []; },
    async preferences(patch) {
      if (patch.theme === "dark" || patch.theme === "light") applyTheme(patch.theme, prefs.theme !== patch.theme);
      if (patch.panelWidth !== undefined) prefs.panelWidth = patch.panelWidth;
      if (patch.fullAccessConfirmed !== undefined) prefs.fullAccessConfirmed = patch.fullAccessConfirmed;
      if (patch.defaultAccess && (patch.defaultAccess !== "full" || prefs.fullAccessConfirmed)) prefs.defaultAccess = patch.defaultAccess;
      return { ...prefs };
    },
    async connect() { await desktop(); throw new Error("Подключение доступно в приложении."); },
    async cancelConnection() {},
    async watchClipboard() {},
    async disconnect() { await desktop(); return catalogState; },
    async checkUpdates() { return "disabled"; },
    async applyUpdate() { await desktop(); },
    async openExternal(url) {
      if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    },
    async windowAction() {},
    async chatAction(id, action) {
      const stored = thread(id);
      const current = stored.conversation;
      switch (action.type) {
        case "delete": chats.delete(id); return null;
        case "rename": current.title = action.title; break;
        case "archive": current.archived = action.value; break;
        case "pin": current.pinned = action.value; break;
        case "fork": {
          const fork = await api.create(current.directory, current.title + " · копия");
          thread(fork.id).history = structuredClone(stored.history);
          return fork;
        }
      }
      return { ...current };
    },
    async revert(id, message) {
      const stored = thread(id);
      if (!message && stored.reverted) {
        stored.history = stored.reverted;
        stored.reverted = undefined;
      } else if (message) {
        const index = stored.history.parts.findIndex(part => part.id === message);
        if (index >= 0) {
          stored.reverted = stored.history;
          const parts = stored.history.parts.slice(0, index);
          stored.history = { parts, reverted: true, changes: parts.flatMap(part => part.kind === "tool" && part.diff ? [part.diff] : []) };
        }
      }
      return api.history(id);
    },
    async revertFile(id) { await desktop(); return api.history(id); },
    async exportChats() { await desktop(); return 0; },
    async tools() { return { commands: [], skills: scenario ? [{
      id: "review", name: "review", description: "Проверка изменений перед завершением работы", path: ".vsemkod/skills/review/SKILL.md"
    }] : [] }; },
    async findFiles(_directory, query) { return entries.filter(entry => entry.path.toLowerCase().includes(query.toLowerCase())); },
    async listFiles(_directory, path) { return entries.filter(entry => (entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "") === (path ?? "")); },
    async readFile(_directory, path) {
      if (!Object.hasOwn(files, path)) throw new Error("В демо нет такого файла.");
      return files[path];
    },
    async modelVariants() { return []; },
    async readInstructions() { return ""; },
    saveInstructions: desktop,
    async mcpList() { return scenario ? [{ name: "project-tools", status: "connected", managed: true }] : []; },
    async mcpChange(directory) { await desktop(); return api.mcpList(directory); },
    openFolder: desktop,
    clearCatalog: desktop,
    async refreshCatalog() { return catalogState; },
    async copyText(text) { await navigator.clipboard.writeText(text); },
    async customModels() { await desktop(); return []; },
    async saveCustomModels() { await desktop(); return catalogState; },
    async openTerminal() {},
    async terminalInput() {},
    async terminalResize() {},
    async closeTerminal() {},
    onTerminal: noSubscription,
    onCatalog: noSubscription,
    onNotice: notices.listen,
    onChat: chat.listen,
    onUpdate: noSubscription,
    onConnect: noSubscription
  };

  return { api, applyTheme, notices, theme: () => prefs.theme, setScript(turn: ScriptTurn) { scriptTurn = turn; },
    stopScript() { for (const current of requests.values()) current.abort(); } };
}
