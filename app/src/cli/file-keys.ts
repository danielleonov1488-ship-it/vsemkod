
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { cloudflareAccountId } from "../shared/cloudflare";
import type { KeyStore } from "../main/key-store";
import { writeJson } from "../main/storage";
import { keyIdSchema, remoteModelsSchema, type KeyId } from "../shared/providers";

const profileSchema = z.object({ name: z.string().min(1).max(60).optional(), baseUrl: z.url(), models: remoteModelsSchema,
  accountId: z.string().regex(cloudflareAccountId).optional() });
type Profile = z.infer<typeof profileSchema>;
const stored = z.partialRecord(keyIdSchema, z.union([z.string().min(1), profileSchema.extend({ key: z.string().min(1) })]));

export function keyVariable(id: KeyId) {
  return "VSEMKOD_" + id.toUpperCase().replaceAll("-", "_") + "_KEY";
}

const aliases: Partial<Record<KeyId, string>> = {
  openrouter: "OPENROUTER_API_KEY", groq: "GROQ_API_KEY", "groq-api": "GROQ_API_KEY"
};

export class FileKeys implements Pick<KeyStore, "load" | "get" | "ids" | "profile" | "set" | "remove"> {
  private keys: z.infer<typeof stored> = {};
  private writes = Promise.resolve();

  constructor(private readonly path: string, private readonly env = process.env) {}

  async load() {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw new Error("Не удалось прочитать keys.json.");
    });
    if (content === undefined) { this.keys = {}; return; }
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    try { this.keys = stored.parse(JSON.parse(content)); }
    catch { throw new Error("Файл keys.json повреждён. Проверьте его содержимое."); }
  }

  environment(id: KeyId) {
    const alias = Object.hasOwn(aliases, id) ? aliases[id] : undefined;
    return this.env[keyVariable(id)]?.trim() || (alias ? this.env[alias]?.trim() : undefined) || undefined;
  }

  get(id: KeyId) {
    const entry = Object.hasOwn(this.keys, id) ? this.keys[id] : undefined;
    const saved = typeof entry === "string" ? entry : entry?.key;
    return this.environment(id) ?? saved;
  }

  ids(): KeyId[] {
    return Object.keys(this.keys);
  }

  profile(id: KeyId): Profile | undefined {
    const entry = Object.hasOwn(this.keys, id) ? this.keys[id] : undefined;
    if (entry && typeof entry !== "string") return { name: entry.name, baseUrl: entry.baseUrl, models: entry.models, ...(entry.accountId ? { accountId: entry.accountId } : {}) };
  }

  set(id: KeyId, key: string, profile?: Profile) {
    return this.update(id, profile ? { ...profile, key } : key);
  }

  remove(id: KeyId) {
    return this.update(id);
  }

  private update(id: KeyId, entry?: (typeof this.keys)[KeyId]) {
    const write = this.writes.then(async () => {
      // Reload before saving so an earlier invocation's changes are retained.
      await this.load();
      const next = { ...this.keys };
      if (entry) next[id] = entry;
      else if (Object.hasOwn(next, id)) delete next[id];
      else return;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeJson(this.path, next);
      this.keys = next;
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
