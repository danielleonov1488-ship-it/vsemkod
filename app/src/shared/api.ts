import type { Catalog, ProviderId } from "./catalog-schema";

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
  | { type: "route"; sessionId: string; modelId: string; previousModelId?: string; providerId: ProviderId };

export type Preferences = { directory: string; auto: boolean; clipboard: boolean };
export type CatalogState = { catalog: Catalog; connected: ProviderId[] };
export type Notice = { text: string; connect?: { modelId: string; providerId: ProviderId } };
export type InitialState = CatalogState & { preferences: Preferences; version: string };

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
  disconnect(id: ProviderId): Promise<CatalogState>;
  openExternal(url: string): Promise<void>;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
  onChat(listener: (event: ChatEvent) => void): () => void;
  onCatalog(listener: (catalog: CatalogState) => void): () => void;
  onNotice(listener: (notice: Notice) => void): () => void;
}
