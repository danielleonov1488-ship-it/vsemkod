import { safeStorage } from "electron";
import { z } from "zod";
import { providerIdSchema, type ProviderId } from "../shared/catalog-schema";
import { readJson, writeJson } from "./storage";

const storedKeys = z.partialRecord(providerIdSchema, z.string().min(1));

export class KeyStore {
  private keys: z.infer<typeof storedKeys> = {};
  private writes = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    this.keys = await readJson(this.path, storedKeys) ?? {};
  }

  get(id: ProviderId): string | undefined {
    const encrypted = this.keys[id];
    if (!encrypted || !this.encryptionAvailable()) return;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch { return undefined; }
  }

  set(id: ProviderId, key: string): Promise<void> {
    if (!this.encryptionAvailable()) throw new Error("Системное хранилище ключей недоступно.");
    return this.update(id, safeStorage.encryptString(key).toString("base64"));
  }

  remove(id: ProviderId): Promise<void> {
    return this.update(id);
  }

  private encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  }

  private update(id: ProviderId, encrypted?: string): Promise<void> {
    const write = this.writes.then(async () => {
      const next = { ...this.keys };
      if (encrypted) next[id] = encrypted;
      else delete next[id];
      await writeJson(this.path, next);
      this.keys = next;
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
