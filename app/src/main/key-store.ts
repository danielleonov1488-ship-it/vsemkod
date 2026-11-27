import { safeStorage } from "electron";
import { z } from "zod";
import { cloudflareAccountId } from "../shared/cloudflare";
import { keyIdSchema, remoteModelsSchema, type KeyId } from "../shared/providers";
import { readJson, writeJson } from "./storage";

const profileSchema = z.object({ name: z.string().min(1).max(60).optional(), baseUrl: z.url(), models: remoteModelsSchema,
  accountId: z.string().regex(cloudflareAccountId).optional() });
type Profile = z.infer<typeof profileSchema>;
export type McpKeyId = `mcp:${string}`;
type StoredKeyId = KeyId | McpKeyId | "telegram-bot";
const mcpKeyId = z.custom<McpKeyId>(value => typeof value === "string" && /^mcp:[a-zA-Z0-9_-]{1,64}$/.test(value));
const storedKeys = z.partialRecord(z.union([keyIdSchema, mcpKeyId, z.literal("telegram-bot")]), z.union([
  z.string().min(1),
  profileSchema.extend({ encrypted: z.string().min(1) })
]));

export class KeyStore {
  private keys: z.infer<typeof storedKeys> = {};
  private writes = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    this.keys = await readJson(this.path, storedKeys) ?? {};
  }

  get(id: StoredKeyId): string | undefined {
    const entry = Object.hasOwn(this.keys, id) ? this.keys[id] : undefined;
    const encrypted = typeof entry === "string" ? entry : entry?.encrypted;
    if (!encrypted || !this.encryptionAvailable()) return;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch { return undefined; }
  }

  ids(): KeyId[] { return Object.keys(this.keys).filter(id => keyIdSchema.safeParse(id).success); }

  profile(id: KeyId): Profile | undefined {
    const entry = Object.hasOwn(this.keys, id) ? this.keys[id] : undefined;
    if (entry && typeof entry !== "string") return { name: entry.name, baseUrl: entry.baseUrl, models: entry.models, ...(entry.accountId ? { accountId: entry.accountId } : {}) };
  }

  set(id: StoredKeyId, key: string, profile?: Profile): Promise<void> {
    if (!this.encryptionAvailable()) throw new Error("Системное хранилище ключей недоступно.");
    const encrypted = safeStorage.encryptString(key).toString("base64");
    return this.update(id, profile ? { ...profile, encrypted } : encrypted);
  }

  remove(id: StoredKeyId): Promise<void> {
    return this.update(id);
  }

  private encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  }

  private update(id: StoredKeyId, entry?: (typeof this.keys)[StoredKeyId]): Promise<void> {
    const write = this.writes.then(async () => {
      const next = { ...this.keys };
      if (entry) next[id] = entry;
      else delete next[id];
      await writeJson(this.path, next);
      this.keys = next;
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
