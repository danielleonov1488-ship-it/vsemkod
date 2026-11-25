import type { Catalog, ProviderId } from "./catalog-schema";
import type { KeyId, NativeId, PersonalId, PersonalModel } from "./providers";

export type Conversation = { id: string; title: string; directory: string; updatedAt: number; modelId?: string };
export type PermissionDecision = "once" | "always" | "reject";
export type Permission = { id: string; action: string; resources: string[]; save?: string[] };
export type FileChange = { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" };
export type ChatPart =
  | { id: string; kind: "user" | "text"; text: string; files?: string[] }
  | { id: string; kind: "tool"; tool: string; target: string; status: "running" | "completed" | "error"; output?: string; diff?: FileChange };

export type ChatEvent =
  | { type: "part"; sessionId: string; part: ChatPart }
  | { type: "delta"; sessionId: string; partId: string; delta: string }
  | { type: "permission"; sessionId: string; permission: Permission }
  | { type: "permission-resolved"; sessionId: string; id: string }
  | { type: "route"; sessionId: string; modelId: string; previousModelId?: string; providerId: KeyId; reason?: "quota" | "unavailable" };

export type Preferences = { directory: string; auto: boolean; clipboard: boolean; catalogUpdates: boolean };
export type SubscriptionId = Exclude<NativeId, "opencode">;
export type ConnectionId = KeyId | SubscriptionId;
export type ConnectEvent = { id: string } & (
  { type: "clipboard"; key: string } | { type: "clipboard-expired" } |
  { type: "waiting"; code?: string; url?: string }
);
export type CatalogState = {
  catalog: Catalog; connected: ProviderId[]; personal: PersonalId[]; subscriptions: SubscriptionId[];
  personalModels: PersonalModel[]; zenModels: PersonalModel[];
};
export type Notice = { text: string; tone?: "error"; connect?: { modelId: string; providerId: ProviderId } };
export type UpdateReady = { version: string; action: "restart" | "download" };
export type UpdateCheck = UpdateReady | "disabled" | "current" | "downloading";
export type InitialState = CatalogState & { preferences: Preferences; version: string; update?: UpdateReady };

export interface DesktopApi {
  initial(): Promise<InitialState>;
  sessions(directory: string): Promise<Conversation[]>;
  create(directory: string, title: string): Promise<Conversation>;
  history(sessionId: string): Promise<{ parts: ChatPart[]; changes: FileChange[] }>;
  send(sessionId: string, text: string, modelId: string, files: string[]): Promise<{ changes: FileChange[]; stopped?: boolean }>;
  stop(sessionId: string): Promise<void>;
  answer(sessionId: string, id: string, decision: PermissionDecision): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseFiles(directory: string): Promise<string[]>;
  preferences(patch: Partial<Preferences>): Promise<Preferences>;
  connect(id: string, provider: ConnectionId, input?: { key: string; baseUrl?: string }): Promise<CatalogState>;
  cancelConnection(id: string): Promise<void>;
  watchClipboard(id: string, provider: KeyId, enabled: boolean): Promise<void>;
  disconnect(id: ConnectionId): Promise<CatalogState>;
  checkUpdates(): Promise<UpdateCheck>;
  applyUpdate(): Promise<void>;
  openExternal(url: string): Promise<void>;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
  onChat(listener: (event: ChatEvent) => void): () => void;
  onCatalog(listener: (catalog: CatalogState) => void): () => void;
  onNotice(listener: (notice: Notice) => void): () => void;
  onUpdate(listener: (update?: UpdateReady) => void): () => void;
  onConnect(listener: (event: ConnectEvent) => void): () => void;
}
