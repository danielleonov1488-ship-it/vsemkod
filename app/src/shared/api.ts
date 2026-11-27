import type { BrowserApi } from "./browser";
import type { Benchmarks } from "./benchmarks";
import type { VoiceApi } from "./voice";
import type { z } from "zod";
import type { FormInfo } from "@opencode/client";
import type { preferencesSchema } from "../main/preferences";
import type { AccessMode } from "./workspace";
import type { RemoteModel } from "./providers";
import type { Catalog, ProviderId } from "./catalog-schema";
import type { KeyId, NativeId, PersonalId, PersonalModel } from "./providers";

export type Conversation = { id: string; title: string; directory: string; updatedAt: number; modelId?: string; variant?: string; access?: AccessMode; pinned?: boolean; archived?: boolean;
  /** Чат работает в отдельной копии проекта (git worktree): directory — путь копии, origin — исходный проект. */
  worktree?: { origin: string; branch: string } };
/** Отдельная копия проекта для параллельной задачи. */
export type Worktree = { path: string; branch: string; origin: string; base: string;
  /** Изменённых файлов, ещё не влитых в основную ветку (включая незакоммиченные). */
  changed: number; ahead: number };
export type WorktreeMerge = { merged: true } | { merged: false; conflicts: string[]; message: string };
/** Доступ с телефона: веб-интерфейс в локальной сети и Telegram-бот. */
export type RemoteAccess = {
  web: { enabled: boolean; urls: string[]; password?: string; error?: string };
  telegram: { connected: boolean; botName?: string; pairedUser?: string; pairCode?: string; project?: string; error?: string };
};
/** Задача по расписанию: в нужное время vsemkod сам открывает новый чат в проекте и отправляет задачу. */
export type ScheduleWhen = { type: "daily"; time: string; weekdays: number[] } | { type: "interval"; hours: number };
export type Schedule = { id: string; name: string; directory: string; prompt: string; when: ScheduleWhen; access: AccessMode;
  model?: string; enabled: boolean; lastRun?: { at: number; sessionId?: string; ok: boolean; error?: string }; nextRun?: number };
export type ScheduleInput = Omit<Schedule, "id" | "lastRun" | "nextRun"> & { id?: string };
/** Хук: после ответа агента запустить команду в папке проекта; если упала — попросить агента исправить. */
export type Hook = { id: string; name: string; directory?: string; command: string; onlyWhenFilesChanged: boolean;
  /** Сколько раз подряд просить агента исправить ошибку команды (0 — только показать результат). */
  fixAttempts: number; enabled: boolean; lastRun?: { at: number; exitCode: number; output: string } };
export type HookInput = Omit<Hook, "id" | "lastRun"> & { id?: string };
export type PermissionDecision = "once" | "always" | "reject";
export type Permission = { id: string; action: string; resources: string[]; save?: string[] };
export type FileChange = { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" };
export type ChatPart =
  | { id: string; kind: "user" | "text"; text: string; files?: string[] }
  | { id: string; kind: "reasoning" | "note"; text: string; seconds?: number }
  | { id: string; kind: "turn"; seconds: number; stopped?: boolean; files?: FileChange[] }
  | { id: string; kind: "tool"; tool: string; target: string; status: "running" | "completed" | "error"; diffs?: FileChange[]; output?: string; background?: boolean; todos?: { content: string; status: string }[]; diff?: FileChange };

export type ChatEvent =
  | { type: "turn-status"; sessionId: string; status: "queued" | "working" }
  | { type: "reply-speed"; sessionId: string; speed: ReplySpeed; live?: boolean; modelSpeed?: ModelSpeed }
  | { type: "part"; sessionId: string; part: ChatPart }
  | { type: "delta"; sessionId: string; partId: string; delta: string; kind?: "text" | "reasoning" }
  | { type: "model-wait"; sessionId: string; since: number | null }
  | { type: "permission"; sessionId: string; permission: Permission }
  | { type: "permission-resolved"; sessionId: string; id: string }
  | { type: "question"; sessionId: string; question: Question }
  | { type: "question-resolved"; sessionId: string; id: string }
  | { type: "usage"; sessionId: string; usage: Usage; speed?: ReplySpeed; nativeCachePercent?: number | null }
  | { type: "reply-cache"; sessionId: string; cachePercent?: number }
  | { type: "route-exhausted"; sessionId: string; modelId: string; providerId: KeyId }
  | { type: "route"; sessionId: string; modelId: string; previousModelId?: string; previousProviderId?: KeyId;
    providerId: KeyId; averageMs: number; reason?: "quota" | "unavailable"; midStream?: boolean }
  /** Все бесплатные источники на паузе: роутер ждёт до until (мс) и сам повторит. null — ожидание закончилось. */
  | { type: "route-wait"; sessionId: string; until: number | null }
  /** Хук запустил команду после ответа агента. */
  | { type: "hook"; sessionId: string; hook: string; command: string; status: "running" | "passed" | "failed"; exitCode?: number; output?: string };

export type Preferences = z.infer<typeof preferencesSchema>;
export type Attachment = { id: string; name: string; image: boolean; preview?: string };
export type TurnOptions = { access?: AccessMode; variant?: string; compact?: boolean; replayMessageId?: string; command?: { name: string; args: string }; skill?: string };
export type ChatHistory = { parts: ChatPart[]; changes: FileChange[]; reverted?: boolean; usage?: Usage; speed?: ReplySpeed };
export type Usage = { input: number; output: number; reasoning: number; cache: { read: number; write: number }; context?: number;
  breakdown?: { system: number; tools: number; messages: number } };
export type ReplySpeed = { tokensPerSecond: number; firstTokenMs: number; estimated?: boolean };
export type ModelSpeed = { modelId: string; providerId: KeyId | NativeId; tokensPerSecond: number };
export type FileInfo = { path: string; relativePath: string; name: string; directory: string; image: boolean; svg: boolean; html: boolean; canOpen: boolean };
export type FilePreview = { info: FileInfo; image?: string; text?: string; truncated?: boolean };
export type FileAction = "open" | "reveal" | "browser";
export type QuotaPeriod = "hour" | "day" | "minute";
export type RequestQuota = { limit: number; remaining: number; resetAt?: number; period?: QuotaPeriod; source: "headers" | "local" };
export type KeyCredits = { usage: number; limit: number | null; remaining?: number | null; isFreeTier: boolean };
export type RouterStats = Partial<Record<KeyId, {
  requests?: RequestQuota; tokens?: { limit?: number; remaining?: number; resetAt?: number }; credits?: KeyCredits;
  ready?: boolean; limited?: boolean; failures?: number;
}>>;
export type ProjectEntry = { path: string; type: "file" | "directory" };
export type SkillSummary = { id: string; name: string; description?: string; path: string };
export type ProjectTools = { commands: { name: string; description?: string }[]; skills: SkillSummary[] };
export type Question = Pick<FormInfo, "id" | "title" | "fields">;
export type QuestionAnswer = Record<string, string | number | boolean | string[]>;
export type McpConfig = {
  type: "local"; command: string[]; environment?: Record<string, string>; disabled?: boolean;
} | {
  type: "remote"; url: string; headers?: Record<string, string>; disabled?: boolean;
};
export type McpEntry = { name: string; status: "connected" | "disabled" | "failed" | "pending" | "needs_auth"; error?: string; managed: boolean };
/** Готовый коннектор из каталога (resources/connectors.json). */
export type Connector = {
  id: string; name: string; description: string;
  category: "docs" | "search" | "browser" | "code" | "data" | "deploy" | "design" | "work";
  transport: "remote" | "local"; auth: "none" | "oauth" | "key";
  keyLabel?: string; keyPageUrl?: string; homepage: string; requires?: ("node" | "chrome")[];
  /** Что именно запустится или куда подключимся — показываем перед установкой. */
  command?: string; url?: string; readOnly?: boolean; popular?: boolean;
};
export type ConnectorState = Connector & {
  installed: boolean; status?: McpEntry["status"]; error?: string;
  /** Чего не хватает на компьютере: node, chrome. */
  missing?: ("node" | "chrome")[];
};
/** Готовый навык из каталога (resources/skills-catalog). */
export type SkillEntry = { id: string; name: string; description: string; category: "design" | "code" | "docs" | "process";
  source: string; license: string; installed: boolean };
export type BackgroundTask = {
  id: string; directory: string; sessionId?: string; command: string; started: number;
  ended?: number; exitCode?: number; output: string;
};
export type SideReply = { text: string; sessionId: string };
export type TerminalEvent = { id: string; text?: string; closed?: boolean };
export type ChatAction = { type: "rename"; title: string } | { type: "pin" | "archive"; value: boolean } | { type: "fork" | "delete" };

export type SubscriptionId = Exclude<NativeId, "opencode">;
export type ConnectionId = KeyId | SubscriptionId;
export type ConnectEvent = { id: string } & (
  { type: "clipboard"; key: string } | { type: "clipboard-expired" } |
  { type: "waiting"; code?: string; url?: string }
);
export type ModelLatency = { modelId: string; providerId: KeyId; averageMs: number };
/** Свой OpenAI-совместимый поставщик. Ключ в состояние не попадает. */
export type CustomProvider = { id: string; name: string; baseUrl: string; models: RemoteModel[] };

export type CatalogState = {
  catalog: Catalog; connected: ProviderId[]; personal: PersonalId[]; subscriptions: SubscriptionId[];
  personalModels: PersonalModel[]; zenModels: PersonalModel[]; latencies?: ModelLatency[]; speeds?: ModelSpeed[]; benchmarks?: Benchmarks; customProviderUrl?: string;
  customProviders?: CustomProvider[];
};
export type Notice = { text: string; tone?: "error"; connect?: { modelId: string; providerId: ProviderId }; open?: string; download?: string };
export type UpdateReady = { version: string; action: "restart" | "download" };
export type UpdateProgress = { version: string; percent?: number };
export type UpdateCheck = UpdateReady | "disabled" | "current" | "downloading";
export type InitialState = CatalogState & { projects?: string[]; hiddenProjects?: string[]; preferences: Preferences; version: string; update?: UpdateReady };

export interface DesktopApi {
  voice?: VoiceApi;
  projectBranch?(directory: string): Promise<string | null>;
  tasks?(): Promise<BackgroundTask[]>;
  startTask?(directory: string, command: string, sessionId?: string): Promise<void>;
  stopTask?(id: string): Promise<void>;
  onTasks?(listener: (tasks: BackgroundTask[]) => void): () => void;
  askSide?(id: string, directory: string, parent: string | undefined, text: string, model: string, variant?: string): Promise<SideReply>;
  closeSide?(id: string): Promise<void>;
  testNotification?(): Promise<void>;
  onNotificationSound?(listener: () => void): () => void;
  setVisibleChat?(id?: string): Promise<void>;
  clipboardKey?(provider: KeyId): Promise<string | undefined>;
  fileStat?(directory: string, path: string): Promise<FileInfo | null>;
  filePreview?(directory: string, path: string): Promise<FilePreview>;
  fileAction?(directory: string, path: string, action: FileAction): Promise<void>;
  projectOpen?(directory: string): Promise<void>;
  /** Создать проект из шаблона в папке по умолчанию; возвращает путь новой папки. */
  createFromTemplate?(templateId: string, name: string): Promise<string>;
  projectRemove?(directory: string): Promise<void>;
  routerStats?(): Promise<RouterStats>;
  worktreeCreate?(origin: string, title: string): Promise<{ directory: string; worktree: Worktree }>;
  worktreeInfo?(directory: string): Promise<Worktree | null>;
  /** Закоммитить всё в копии и влить её ветку в текущую ветку исходного проекта. */
  worktreeMerge?(directory: string, message: string): Promise<WorktreeMerge>;
  /** Удалить копию и её ветку (незакоммиченное пропадёт). */
  worktreeRemove?(directory: string): Promise<void>;
  remoteAccess?(): Promise<RemoteAccess>;
  setRemoteWeb?(enabled: boolean): Promise<RemoteAccess>;
  /** Токен бота от @BotFather; null — отключить бота. */
  setTelegramBot?(token: string | null, project?: string): Promise<RemoteAccess>;
  onRemoteAccess?(listener: (state: RemoteAccess) => void): () => void;
  schedules?(): Promise<Schedule[]>;
  saveSchedule?(input: ScheduleInput): Promise<Schedule[]>;
  removeSchedule?(id: string): Promise<Schedule[]>;
  runSchedule?(id: string): Promise<Schedule[]>;
  hooks?(): Promise<Hook[]>;
  saveHook?(input: HookInput): Promise<Hook[]>;
  removeHook?(id: string): Promise<Hook[]>;
  connectors?(directory: string): Promise<ConnectorState[]>;
  /** Установить коннектор (для auth "key" — с ключом). Для OAuth после установки вызывается authorizeConnector. */
  installConnector?(directory: string, id: string, input?: { key?: string }): Promise<ConnectorState[]>;
  /** Вход OAuth: открывает браузер, промис завершается, когда вход прошёл или отменён. */
  authorizeConnector?(directory: string, id: string): Promise<ConnectorState[]>;
  removeConnector?(directory: string, id: string): Promise<ConnectorState[]>;
  skillCatalog?(): Promise<SkillEntry[]>;
  installSkill?(id: string): Promise<SkillEntry[]>;
  removeSkill?(id: string): Promise<SkillEntry[]>;
  /** Список моделей своего поставщика: по адресу и ключу (новый) или по id (уже сохранённый, ключ берётся из хранилища). */
  customProviderModels?(input: { baseUrl: string; key: string } | { id: string }): Promise<RemoteModel[]>;
  /** Создать (без id, ключ обязателен) или изменить (с id, без ключа — оставить прежний) своего поставщика. */
  saveCustomProvider?(input: { id?: string; name: string; baseUrl: string; key?: string; models: RemoteModel[] }): Promise<CatalogState>;
  onRouterStats?(listener: (stats: RouterStats) => void): () => void;
  onDemoQuota?(listener: (remaining?: number) => void): () => void;
  initial(): Promise<InitialState>;
  sessions(directory?: string): Promise<Conversation[]>;
  create(directory: string, title: string): Promise<Conversation>;
  history(sessionId: string): Promise<ChatHistory>;
  send(sessionId: string, text: string, modelId: string, files: string[], options?: TurnOptions): Promise<{ changes: FileChange[]; stopped?: boolean }>;
  stop(sessionId: string): Promise<void>;
  answer(sessionId: string, id: string, decision: PermissionDecision): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseFiles(directory: string): Promise<Attachment[]>;
  preferences(patch: Partial<Preferences>): Promise<Preferences>;
  connect(id: string, provider: ConnectionId, input?: { key: string; baseUrl?: string; models?: RemoteModel[]; accountId?: string }): Promise<CatalogState>;
  cancelConnection(id: string): Promise<void>;
  watchClipboard(id: string, provider: KeyId, enabled: boolean): Promise<void>;
  disconnect(id: ConnectionId): Promise<CatalogState>;
  checkUpdates(): Promise<UpdateCheck>;
  applyUpdate(): Promise<void>;
  openExternal(url: string): Promise<void>;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
  chatAction(sessionId: string, action: ChatAction): Promise<Conversation | null>;
  revert(sessionId: string, messageId?: string): Promise<ChatHistory>;
  revertFile(sessionId: string, path: string): Promise<ChatHistory>;
  exportChats(sessionId?: string): Promise<number>;
  filePath(file: File): string;
  captureFiles(directory: string, files: { data?: Uint8Array; path?: string; name: string; mime: string }[]): Promise<Attachment[]>;
  tools(directory: string): Promise<ProjectTools>;
  findFiles(directory: string, query: string): Promise<ProjectEntry[]>;
  listFiles(directory: string, path?: string): Promise<ProjectEntry[]>;
  readFile(directory: string, path: string): Promise<string>;
  answerQuestion(sessionId: string, formId: string, answer?: QuestionAnswer): Promise<void>;
  modelVariants(directory: string, model: string): Promise<string[]>;
  readInstructions(): Promise<string>;
  saveInstructions(text: string): Promise<void>;
  mcpList(directory: string): Promise<McpEntry[]>;
  mcpChange(directory: string, name: string, action: "put" | "delete" | "enable" | "disable" | "check", config?: McpConfig): Promise<McpEntry[]>;
  openFolder(folder: "data" | "logs" | "skills"): Promise<void>;
  clearCatalog(): Promise<void>;
  refreshCatalog(): Promise<CatalogState>;
  copyText(text: string): Promise<void>;
  customModels(input?: { key: string; baseUrl: string }): Promise<RemoteModel[]>;
  saveCustomModels(models: RemoteModel[]): Promise<CatalogState>;
  openTerminal(directory: string, id: string): Promise<void>;
  terminalInput(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminal(listener: (event: TerminalEvent) => void): () => void;
  onChat(listener: (event: ChatEvent) => void): () => void;
  onCatalog(listener: (catalog: CatalogState) => void): () => void;
  onNotice(listener: (notice: Notice) => void): () => void;
  onUpdate(listener: (update?: UpdateReady) => void): () => void;
  onUpdateProgress?(listener: (progress?: UpdateProgress) => void): () => void;
  onChatFocus?(listener: (sessionId: string) => void): () => void;
  onNewChat?(listener: () => void): () => void;
  onUpdateInstalling?(listener: (version: string) => void): () => void;
  browser?: BrowserApi;
  onConnect(listener: (event: ConnectEvent) => void): () => void;
}
