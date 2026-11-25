import type { z } from "zod";
import type { FormInfo } from "@opencode/client";
import type { preferencesSchema } from "../main/preferences";
import type { AccessMode } from "./workspace";
import type { RemoteModel } from "./providers";
import type { Catalog, ProviderId } from "./catalog-schema";
import type { KeyId, NativeId, PersonalId, PersonalModel } from "./providers";

export type Conversation = { id: string; title: string; directory: string; updatedAt: number; modelId?: string; variant?: string; access?: AccessMode; pinned?: boolean; archived?: boolean };
export type PermissionDecision = "once" | "always" | "reject";
export type Permission = { id: string; action: string; resources: string[]; save?: string[] };
export type FileChange = { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" };
export type ChatPart =
  | { id: string; kind: "user" | "text"; text: string; files?: string[] }
  | { id: string; kind: "reasoning" | "note"; text: string; seconds?: number }
  | { id: string; kind: "turn"; seconds: number; stopped?: boolean }
  | { id: string; kind: "tool"; tool: string; target: string; status: "running" | "completed" | "error"; diffs?: FileChange[]; output?: string; todos?: { content: string; status: string }[]; diff?: FileChange };

export type ChatEvent =
  | { type: "part"; sessionId: string; part: ChatPart }
  | { type: "delta"; sessionId: string; partId: string; delta: string; kind?: "text" | "reasoning" }
  | { type: "model-wait"; sessionId: string; since: number | null }
  | { type: "permission"; sessionId: string; permission: Permission }
  | { type: "permission-resolved"; sessionId: string; id: string }
  | { type: "question"; sessionId: string; question: Question }
  | { type: "question-resolved"; sessionId: string; id: string }
  | { type: "usage"; sessionId: string; usage: Usage }
  | { type: "route"; sessionId: string; modelId: string; previousModelId?: string; previousProviderId?: KeyId;
    providerId: KeyId; averageMs: number; reason?: "quota" | "unavailable" };

export type Preferences = z.infer<typeof preferencesSchema>;
export type Attachment = { id: string; name: string; image: boolean; preview?: string };
export type TurnOptions = { access?: AccessMode; variant?: string; compact?: boolean; replayMessageId?: string; command?: { name: string; args: string }; skill?: string };
export type ChatHistory = { parts: ChatPart[]; changes: FileChange[]; reverted?: boolean; usage?: Usage };
export type Usage = { input: number; output: number; reasoning: number; cache: { read: number; write: number }; context?: number };
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
export type TerminalEvent = { id: string; text?: string; closed?: boolean };
export type ChatAction = { type: "rename"; title: string } | { type: "pin" | "archive"; value: boolean } | { type: "fork" | "delete" };

export type SubscriptionId = Exclude<NativeId, "opencode">;
export type ConnectionId = KeyId | SubscriptionId;
export type ConnectEvent = { id: string } & (
  { type: "clipboard"; key: string } | { type: "clipboard-expired" } |
  { type: "waiting"; code?: string; url?: string }
);
export type ModelLatency = { modelId: string; providerId: KeyId; averageMs: number };

export type CatalogState = {
  catalog: Catalog; connected: ProviderId[]; personal: PersonalId[]; subscriptions: SubscriptionId[];
  personalModels: PersonalModel[]; zenModels: PersonalModel[]; latencies?: ModelLatency[];
};
export type Notice = { text: string; tone?: "error"; connect?: { modelId: string; providerId: ProviderId } };
export type UpdateReady = { version: string; action: "restart" | "download" };
export type UpdateCheck = UpdateReady | "disabled" | "current" | "downloading";
export type InitialState = CatalogState & { projects?: string[]; preferences: Preferences; version: string; update?: UpdateReady };

export interface DesktopApi {
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
  connect(id: string, provider: ConnectionId, input?: { key: string; baseUrl?: string; models?: RemoteModel[] }): Promise<CatalogState>;
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
  onConnect(listener: (event: ConnectEvent) => void): () => void;
}
