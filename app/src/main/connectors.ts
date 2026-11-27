import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ConnectorState, McpConfig, McpEntry } from "../shared/api";
import type { KeyStore, McpKeyId } from "./key-store";
import { readJson, writeJson } from "./storage";

export const mcpName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const mcpConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), command: z.array(z.string().min(1)).min(1).max(64), environment: z.record(z.string(), z.string()).optional(), disabled: z.boolean().optional() }),
  z.object({ type: z.literal("remote"), url: z.url({ protocol: /^https?$/ }), headers: z.record(z.string(), z.string()).optional(), disabled: z.boolean().optional() })
]);

const https = z.url({ protocol: /^https$/ }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password;
});
const dependency = z.enum(["node", "chrome"]);
type Dependency = z.infer<typeof dependency>;
const catalogEntry = z.object({
  id: mcpName, name: z.string().min(1), description: z.string().min(1),
  category: z.enum(["docs", "search", "browser", "code", "data", "deploy", "design", "work"]),
  auth: z.enum(["none", "oauth", "key"]), homepage: https,
  popular: z.boolean().optional(), readOnly: z.boolean().optional(), requires: z.array(dependency).optional(),
  keyLabel: z.string().min(1).optional(), keyPageUrl: https.optional()
});
export const connectorCatalogSchema = z.array(z.discriminatedUnion("transport", [
  catalogEntry.extend({ transport: z.literal("remote"), url: https }),
  catalogEntry.extend({
    transport: z.literal("local"), auth: z.literal("none"),
    command: z.string().regex(/^npx -y (?:@[a-z0-9-]+\/)?[a-z0-9-]+@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?: [a-z0-9-]+)*$/)
  })
])).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, "Повторяющийся id коннектора.")
  .refine(entries => entries.every(entry => entry.transport !== "local" || entry.requires?.includes("node")), "Локальному коннектору нужен Node.js.")
  .refine(entries => entries.every(entry => entry.auth !== "key" || (entry.keyLabel && entry.keyPageUrl)), "Нет инструкции для получения ключа.");

type CatalogEntry = z.infer<typeof connectorCatalogSchema>[number];
const keyId = (id: string): McpKeyId => "mcp:" + id as McpKeyId;

function hasChrome(): boolean {
  if (process.platform === "win32") {
    return [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
      .some(root => root && existsSync(join(root, "Google", "Chrome", "Application", "chrome.exe")));
  }
  if (process.platform === "darwin") {
    return ["/Applications", join(homedir(), "Applications")]
      .some(root => existsSync(join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")));
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].some(existsSync);
}

let nodeCheck: { expires: number; found: Promise<boolean> } | undefined;
function hasNode(): Promise<boolean> {
  if (!nodeCheck || nodeCheck.expires <= Date.now()) {
    nodeCheck = {
      expires: Date.now() + 60_000,
      found: new Promise(resolve => execFile("node", ["--version"], { timeout: 3000, windowsHide: true },
        (error, stdout) => resolve(!error && /^v\d+\.\d+\.\d+/.test(stdout.trim()))))
    };
  }
  return nodeCheck.found;
}

async function available(required: Dependency): Promise<boolean> {
  return required === "node" ? hasNode() : hasChrome();
}

export class Connectors {
  constructor(
    private readonly entries: CatalogEntry[],
    private readonly path: string,
    private readonly keys: Pick<KeyStore, "get" | "set" | "remove">,
    private configs: Record<string, McpConfig>,
    private readonly dependencyAvailable = available,
    private readonly platform = process.platform
  ) {}

  static async load(catalogPath: string, path: string, keys: KeyStore) {
    const [catalog, configs] = await Promise.all([
      readJson(catalogPath, connectorCatalogSchema),
      readJson(path, z.record(z.string(), mcpConfig))
    ]);
    return new Connectors(catalog ?? [], path, keys, configs ?? {});
  }

  entry(id: string): CatalogEntry {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new Error("Коннектор не найден в каталоге.");
    return entry;
  }

  get(name: string): McpConfig | undefined {
    return Object.hasOwn(this.configs, name) ? this.configs[name] : undefined;
  }

  engineConfig(name: string): McpConfig | undefined {
    const config = this.get(name);
    if (config?.type !== "remote") return config;
    const entry = this.entries.find(item => item.id === name && item.auth === "key");
    if (entry?.transport !== "remote" || config.url !== entry.url) return config;
    if (Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization")) return config;
    const key = this.keys.get(keyId(name));
    return key ? { ...config, headers: { ...config.headers, Authorization: "Bearer " + key } } : config;
  }

  engineConfigs(): Record<string, McpConfig | undefined> {
    return Object.fromEntries(Object.keys(this.configs).map(name => [name, this.engineConfig(name)]));
  }

  async list(statuses: McpEntry[]): Promise<ConnectorState[]> {
    const statusesByName = new Map(statuses.map(entry => [entry.name, entry]));
    const missing = new Map<Dependency, boolean>(await Promise.all(dependency.options.map(async type =>
      [type, !await this.dependencyAvailable(type)] as const)));
    return this.entries.map(entry => {
      const config = this.get(entry.id);
      const state = config ? statusesByName.get(entry.id) : undefined;
      return {
        ...entry,
        installed: !!config, status: config?.disabled ? "disabled" : state?.status, error: state?.error,
        missing: entry.requires?.filter(type => missing.get(type))
      };
    });
  }

  async change(name: string, action: "put" | "delete" | "enable" | "disable", config?: McpConfig) {
    const current = this.get(name);
    const next = { ...this.configs };
    if (action === "put" && config) {
      Object.defineProperty(next, name, { value: config, writable: true, configurable: true, enumerable: true });
    } else if (action === "delete" && current) delete next[name];
    else if ((action === "enable" || action === "disable") && current) next[name] = { ...current, disabled: action === "disable" };
    else throw new Error("Сервер MCP не найден.");
    await writeJson(this.path, next);
    this.configs = next;
  }

  async install(id: string, key?: string) {
    const entry = this.entry(id);
    for (const required of entry.requires ?? []) {
      if (await this.dependencyAvailable(required)) continue;
      throw new Error(required === "node" ? "Нужен Node.js: nodejs.org" : "Нужен Google Chrome: google.com/chrome");
    }
    let config: McpConfig;
    if (entry.transport === "local") {
      const command = entry.command.split(" ");
      // Windows installs npx as a .cmd shim; only catalog-validated arguments reach cmd.exe.
      config = { type: "local", command: this.platform === "win32" ? ["cmd.exe", "/d", "/c", ...command] : command };
    } else config = { type: "remote", url: entry.url };

    if (entry.auth !== "key") return this.change(id, "put", config);
    if (!key?.trim()) throw new Error("Вставьте ключ для подключения к " + entry.name + ".");
    const slot = keyId(id);
    const previous = this.keys.get(slot);
    await this.keys.set(slot, key.trim());
    try {
      await this.change(id, "put", config);
    } catch (error) {
      if (previous) await this.keys.set(slot, previous);
      else await this.keys.remove(slot);
      throw error;
    }
  }

  async clearKey(id: string) {
    if (this.entries.some(entry => entry.id === id && entry.auth === "key")) await this.keys.remove(keyId(id));
  }
}
