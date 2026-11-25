import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { rankedModels } from "../../shared/catalog";
import type { Catalog } from "../../shared/catalog-schema";
import type { ChatEvent, Permission, PermissionDecision } from "../../shared/api";
import type { Router } from "../router";
import { readJson, writeJson } from "../storage";
import { EngineAdapter, mergeChanges } from "./adapter";

const diffsSchema = z.record(z.string(), z.object({
  file: z.string(), patch: z.string(), additions: z.number(), deletions: z.number(),
  status: z.enum(["added", "deleted", "modified"])
}));
const approvalsSchema = z.array(z.object({ action: z.string(), patterns: z.array(z.string()) }));
type Approval = z.infer<typeof approvalsSchema>[number];

function matches(pattern: string, resource: string) {
  const normalize = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
  pattern = normalize(pattern);
  resource = normalize(resource);
  if (pattern.endsWith(" *") && resource === pattern.slice(0, -2)) return true;
  let patternIndex = 0;
  let resourceIndex = 0;
  let wildcard = -1;
  let restart = 0;
  while (resourceIndex < resource.length) {
    const character = pattern[patternIndex];
    if (character === "*") { wildcard = patternIndex++; restart = resourceIndex; }
    else if (character === "?" || character === resource[resourceIndex]) { patternIndex++; resourceIndex++; }
    else if (wildcard >= 0) { patternIndex = wildcard + 1; resourceIndex = ++restart; }
    else return false;
  }
  return /^\**$/.test(pattern.slice(patternIndex));
}

export function engineBinary(resources: string): string {
  return join(resources, "engine", process.platform + "-" + process.arch,
    process.platform === "win32" ? "opencode.exe" : "opencode");
}

const filePermissions = [
  { action: "*", resource: "*", effect: "deny" },
  ...["read", "glob", "grep", "list"].map(action => ({ action, resource: "*", effect: "allow" })),
  { action: "edit", resource: "*", effect: "ask" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "deny" }
] as const;

export class EngineService {
  private child?: ChildProcess;
  private client?: EngineAdapter;
  private starting?: Promise<EngineAdapter>;
  private active?: string;
  private stopRequested = false;
  private catalogVersion?: string;
  private pendingPermissions = new Map<string, Permission>();
  private approvals: Approval[] = [];

  constructor(
    private readonly executable: string,
    private readonly data: string,
    private readonly catalog: () => Catalog,
    private readonly router: Router,
    private readonly emit: (event: ChatEvent) => void
  ) {}

  async ready(): Promise<EngineAdapter> {
    if (this.client && (this.active || this.catalogVersion === this.catalog().generatedAt)) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async send(sessionId: string, directory: string, text: string, modelId: string, auto: boolean, files: string[]) {
    if (this.active) throw new Error("Агент уже отвечает в другом запросе.");
    const client = await this.ready();
    if (this.active) throw new Error("Агент уже отвечает в другом запросе.");
    this.active = sessionId;
    this.stopRequested = false;
    this.router.setTurn({ sessionId, auto });
    const path = this.sessionFile(sessionId, "diffs");
    const [previousDiffs, approvals] = await Promise.all([
      readJson(path, diffsSchema), readJson(this.sessionFile(sessionId, "approvals"), approvalsSchema)
    ]);
    const diffs = previousDiffs ?? {};
    this.approvals = approvals ?? [];
    let changed = false;
    try {
      const result = await client.send(sessionId, directory, text, modelId, files, event => {
        if (event.type === "permission") {
          const permission = event.permission;
          this.pendingPermissions.set(permission.id, permission);
          const allowed = permission.resources.length > 0 && permission.resources.every(resource =>
            this.approvals.some(approval => approval.action === permission.action && approval.patterns.some(pattern => matches(pattern, resource))));
          if (allowed) {
            void client.answer(sessionId, permission.id, "once").catch(() => {
              if (this.pendingPermissions.has(permission.id)) this.emit(event);
            });
            return;
          }
        }
        if (event.type === "permission-resolved") this.pendingPermissions.delete(event.id);
        if (event.type === "part" && event.part.kind === "tool" && event.part.diff) {
          diffs[event.part.id] = event.part.diff;
          changed = true;
        }
        this.emit(event);
      }, () => this.stopRequested);
      return { changes: mergeChanges(Object.values(diffs), result.changes), stopped: result.stopped };
    } finally {
      if (changed) await writeJson(path, diffs).catch(() => {});
      this.active = undefined;
      this.router.setTurn();
      this.pendingPermissions.clear();
    }
  }

  async history(sessionId: string, directory: string) {
    const client = await this.ready();
    return client.history(sessionId, directory, await readJson(this.sessionFile(sessionId, "diffs"), diffsSchema));
  }

  private sessionFile(sessionId: string, folder: "diffs" | "approvals") {
    return join(this.data, folder, createHash("sha256").update(sessionId).digest("hex") + ".json");
  }

  async answer(sessionId: string, id: string, decision: PermissionDecision) {
    const permission = this.pendingPermissions.get(id);
    if (!this.client || this.active !== sessionId || !permission) {
      throw new Error("Запрос разрешения уже закрыт.");
    }
    if (decision === "always") {
      const patterns = permission.save?.length ? permission.save : permission.resources;
      const approvals = [...this.approvals, { action: permission.action, patterns }];
      await writeJson(this.sessionFile(sessionId, "approvals"), approvals);
      this.approvals = approvals;
    }
    await this.client.answer(sessionId, id, decision === "always" ? "once" : decision);
  }

  async stop(sessionId: string) {
    if (this.active === sessionId) {
      this.stopRequested = true;
      await this.client?.stop(sessionId);
    }
  }

  async close() {
    const child = this.child;
    this.child = undefined;
    this.client = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill();
      await Promise.race([exited, delay(3_000, undefined, { ref: false })]);
    }
  }

  private async launch(): Promise<EngineAdapter> {
    await this.close();
    await access(this.executable).catch(() => { throw new Error("Бинарник OpenCode отсутствует. Выполните npm run fetch:engine."); });
    await mkdir(this.data, { recursive: true });
    const catalog = this.catalog();
    const password = randomBytes(32).toString("base64url");
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "SHELL", "LANG", "LC_ALL"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    Object.assign(env, {
      XDG_DATA_HOME: join(this.data, "data"),
      XDG_CONFIG_HOME: join(this.data, "config"),
      XDG_STATE_HOME: join(this.data, "state"),
      XDG_CACHE_HOME: join(this.data, "cache"),
      OPENCODE_PASSWORD: password,
      OPENCODE_PURE: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_TELEMETRY: "true",
      DO_NOT_TRACK: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(this.config(catalog))
    });
    const child = spawn(this.executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: this.data, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.resume();
    child.once("close", () => {
      if (this.child === child) {
        this.child = undefined;
        this.client = undefined;
      }
    });
    const lines = createInterface({ input: child.stdout });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("OpenCode не запустился вовремя.")), 20_000);
        child.once("error", reject);
        child.once("close", code => reject(new Error("OpenCode завершился при запуске. Код " + code + ".")));
        lines.on("line", line => {
          const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/i.exec(line);
          if (match) resolve(match[1]);
        });
      });
      const client = new EngineAdapter(url, "Basic " + Buffer.from("opencode:" + password).toString("base64"));
      await client.info();
      this.catalogVersion = catalog.generatedAt;
      this.client = client;
      return client;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdout.resume();
    }
  }

  private config(catalog: Catalog) {
    const models = rankedModels(catalog);
    const entries = models.map(model => [model.id, {
      name: model.name,
      limit: { context: model.contextWindow, output: Math.min(8192, Math.floor(model.contextWindow / 4)) },
      capabilities: { tools: model.capabilities.includes("tools"), input: ["text", ...(model.capabilities.includes("vision") ? ["image"] : [])], output: ["text"] }
    }]);
    return {
      model: "vsemkod/auto",
      update: "disable",
      share: "disabled",
      formatter: false,
      lsp: false,
      snapshots: true,
      permissions: filePermissions,
      agents: {
        ...Object.fromEntries(["build", "plan", "general"].map(agent => [agent, { permissions: filePermissions }])),
        title: { disabled: true }
      },
      plugins: ["-opencode.models.dev", "-opencode.provider.opencode", "-opencode.provider.kilo"],
      providers: {
        vsemkod: {
          name: "vsemkod",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: this.router.baseUrl, apiKey: this.router.token },
          models: Object.fromEntries([["auto", {
            name: "Автовыбор",
            limit: { context: Math.min(...models.filter(model => model.tier !== "basic").map(model => model.contextWindow), 128_000), output: 8192 },
            capabilities: { tools: true, input: ["text"], output: ["text"] }
          }], ...entries])
        }
      }
    };
  }
}
