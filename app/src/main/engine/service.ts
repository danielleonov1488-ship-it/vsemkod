import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { rankedModels } from "../../shared/catalog";
import type { Catalog } from "../../shared/catalog-schema";
import type { ChatEvent, ChatPart, FileChange, Permission, PermissionDecision, TurnOptions } from "../../shared/api";
import { nativeIdSchema, type PersonalModel } from "../../shared/providers";
import type { Router } from "../router";
import { readJson, writeJson } from "../storage";
import { applyFileChanges } from "./revert-files";
import { sessionAccess } from "./access";
import { EngineAdapter, type EngineModel } from "./adapter";
import { TurnQueue } from "./turn-queue";

const changeSchema = z.object({
  file: z.string(), patch: z.string(), additions: z.number(), deletions: z.number(),
  status: z.enum(["added", "deleted", "modified"])
});
const diffsSchema = z.record(z.string(), z.union([changeSchema, z.array(changeSchema)]).transform(value => Array.isArray(value) ? value : [value]));
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

export const enableOpenCodeZenFree = process.env.ENABLE_OPENCODE_ZEN_FREE === "true";

const filePermissions = sessionAccess("ask").permissions;

export class EngineService {
  private child?: ChildProcess;
  private client?: EngineAdapter;
  private starting?: Promise<EngineAdapter>;
  private queue = new TurnQueue();
  private active = new Map<string, { stopRequested: boolean; pending: Map<string, Permission>; approvals: Approval[]; saves: Promise<unknown> }>();
  private catalogVersion?: string;
  private configuredModels = new Set<string>();
  private authorizing = 0;
  keepBackground = () => false;
  get runningClient() { return this.client; }

  routerActivity(sessionId: string) { this.client?.routerActivity(sessionId); }

  constructor(
    private readonly executable: string,
    private readonly data: string,
    private readonly catalog: () => Catalog,
    private readonly router: Router,
    private readonly emit: (event: ChatEvent) => void,
    private readonly personalModels: () => PersonalModel[] = () => [],
    private readonly settings: () => { agentSteps: number; webSearch: boolean; mcp: object } = () => ({ agentSteps: 0, webSearch: false, mcp: {} })
  ) {}

  async ready(): Promise<EngineAdapter> {
    if (this.client && (this.active.size || this.authorizing || this.keepBackground() || this.catalogVersion === this.configVersion(this.catalog(), this.personalModels()))) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async withAuth<T>(run: (client: EngineAdapter) => Promise<T>): Promise<T> {
    const client = await this.ready();
    this.authorizing++;
    try { return await run(client); }
    finally { this.authorizing--; }
  }

  async send(sessionId: string, directory: string, text: string, modelId: string, auto: boolean, files: string[], native?: EngineModel, options: TurnOptions = {}) {
    if (!await this.queue.acquire(sessionId, () => this.emit({ type: "turn-status", sessionId, status: "queued" }))) {
      return { changes: (await this.history(sessionId, directory)).changes, stopped: true };
    }
    const startup = this.ready();
    const turn = { stopRequested: false, pending: new Map<string, Permission>(), approvals: [] as Approval[], saves: Promise.resolve() as Promise<unknown> };
    this.active.set(sessionId, turn);
    this.emit({ type: "turn-status", sessionId, status: "working" });
    const path = this.sessionFile(sessionId, "diffs");
    let diffs: Record<string, FileChange[]> = {};
    let changed = false;
    try {
      const [client, previousDiffs, approvals] = await Promise.all([startup, readJson(path, diffsSchema),
        readJson(this.sessionFile(sessionId, "approvals"), approvalsSchema)]);
      diffs = previousDiffs ?? {};
      turn.approvals = approvals ?? [];
      if (turn.stopRequested) return { changes: (await this.history(sessionId, directory)).changes, stopped: true };
      const lastUser = (await client.history(sessionId, directory, diffs)).parts.findLast(part => part.kind === "user");
      const nativeProvider = nativeIdSchema.safeParse(native?.providerID);
      const needsRelay = !native && modelId !== "auto" && !this.configuredModels.has(modelId);
      this.router.setTurn({ sessionId, auto, preferredModel: needsRelay ? modelId : undefined });
      const result = await client.send(sessionId, directory, text, native ?? { id: needsRelay ? "relay" : modelId, providerID: "vsemkod" }, files, event => {
        if (event.type === "permission") {
          const permission = event.permission;
          turn.pending.set(permission.id, permission);
          const allowed = permission.resources.length > 0 && permission.resources.every(resource =>
            turn.approvals.some(approval => approval.action === permission.action && approval.patterns.some(pattern => matches(pattern, resource))));
          if (allowed) {
            void client.answer(sessionId, permission.id, "once").catch(() => {
              if (turn.pending.has(permission.id)) this.emit(event);
            });
            return;
          }
        }
        if (event.type === "permission-resolved") turn.pending.delete(event.id);
        if (event.type === "part" && event.part.kind === "tool" && event.part.diff) {
          diffs[event.part.id] = event.part.diffs ?? [event.part.diff];
          changed = true;
        }
        this.emit(event);
      }, () => turn.stopRequested, { ...options, displayModelId: needsRelay ? modelId : undefined, webSearch: this.settings().webSearch, routerError: () => this.router.turnError(sessionId),
        nativeSpeed: nativeProvider.success ? (speed, live) => this.router.reportSpeed(sessionId, modelId, nativeProvider.data, speed, live) : undefined });
      const history = await client.history(sessionId, directory, diffs);
      const user = history.parts.findLast(part => part.kind === "user");
      const end = history.parts.at(-1);
      if (user && user.id !== lastUser?.id && end?.kind === "turn") {
        const nativeChanges = await client.changes(sessionId, user.id);
        const turnFiles = new Map([...result.artifacts, ...nativeChanges].map(change => [change.file.replaceAll("\\", "/"), change]));
        if (turnFiles.size) { diffs["turn:" + user.id] = [...turnFiles.values()]; changed = true; }
      }
      if (changed) { await writeJson(path, diffs); changed = false; }
      const reverted = await readJson(this.sessionFile(sessionId, "file-reverts"), z.record(z.string(), z.string()));
      if (reverted) history.changes = history.changes.filter(change => reverted[change.file] !== change.patch);
      return { changes: history.changes, stopped: result.stopped };
    } finally {
      if (changed) await writeJson(path, diffs).catch(() => {});
      await turn.saves;
      this.active.delete(sessionId);
      this.router.clearTurn(sessionId);
      this.queue.release(sessionId);
    }
  }

  async history(sessionId: string, directory: string) {
    const client = await this.ready();
    const [diffs, reverted] = await Promise.all([readJson(this.sessionFile(sessionId, "diffs"), diffsSchema),
      readJson(this.sessionFile(sessionId, "file-reverts"), z.record(z.string(), z.string()))]);
    const result = await client.history(sessionId, directory, diffs);
    if (reverted) result.changes = result.changes.filter(change => reverted[change.file] !== change.patch);
    return result;
  }

  get configDirectory() { return join(this.data, "config", "opencode"); }

  async openTerminal(directory: string, emit: (text: string) => void, close: () => void) {
    return (await this.ready()).openTerminal(directory, emit, close);
  }

  async revert(sessionId: string, directory: string, messageId?: string) {
    if (this.queue.has(sessionId)) throw new Error("Сначала остановите агента.");
    const client = await this.ready();
    const diffs = await readJson(this.sessionFile(sessionId, "diffs"), diffsSchema);
    const visible = await client.history(sessionId, directory, diffs);
    const boundary = messageId ? visible.parts.findIndex(part => part.id === messageId && part.kind === "user") : -1;
    if (messageId && boundary < 0) throw new Error("Сообщение для отката не найдено.");
    const git = await client.isGit(directory);
    if (git) await client.revert(sessionId, messageId);
    else {
      const full = await client.history(sessionId, directory, diffs, true);
      const previous = visible.reverted ? full.parts.slice(visible.parts.length) : [];
      const next = messageId ? full.parts.slice(boundary) : [];
      const changes = (parts: ChatPart[]) => parts.flatMap(part => part.kind === "tool" ? part.diffs ?? [] : []);
      await applyFileChanges(directory, [...changes(previous).map(change => ({ change, reverse: false })),
        ...changes(next).reverse().map(change => ({ change, reverse: true }))], () => client.revert(sessionId, messageId));
    }
    return client.history(sessionId, directory, diffs);
  }

  async revertFile(sessionId: string, directory: string, file: string) {
    if (this.queue.has(sessionId)) throw new Error("Сначала остановите агента.");
    const client = await this.ready();
    const path = this.sessionFile(sessionId, "diffs");
    const diffs = await readJson(path, diffsSchema) ?? {};
    const history = await client.history(sessionId, directory, diffs);
    const changes = history.parts.flatMap(part => part.kind === "tool" ? part.diffs?.filter(change => change.file === file) ?? [] : []);
    if (!(await this.history(sessionId, directory)).changes.some(change => change.file === file)) throw new Error("Изменение файла не найдено.");
    const native = (await client.changes(sessionId)).find(item => item.file === file);
    const patches = native ? [native] : changes.reverse();
    if (!patches.length) throw new Error("Изменение файла не найдено.");
    await applyFileChanges(directory, patches.map(change => ({ change, reverse: true })), async () => {
      await writeJson(path, Object.fromEntries(Object.entries(diffs).map(([id, changes]) => [id, changes.filter(change => change.file !== file)])));
      if (native) {
        const reverted = this.sessionFile(sessionId, "file-reverts");
        const previous = await readJson(reverted, z.record(z.string(), z.string()));
        await writeJson(reverted, { ...previous, [file]: native.patch }).catch(async error => { await writeJson(path, diffs); throw error; });
      }
    });
    return this.history(sessionId, directory);
  }

  private sessionFile(sessionId: string, folder: "diffs" | "approvals" | "file-reverts") {
    return join(this.data, folder, createHash("sha256").update(sessionId).digest("hex") + ".json");
  }

  async answer(sessionId: string, id: string, decision: PermissionDecision) {
    const turn = this.active.get(sessionId);
    const permission = turn?.pending.get(id);
    if (!this.client || !turn || !permission) {
      throw new Error("Запрос разрешения уже закрыт.");
    }
    if (decision === "always") {
      const patterns = permission.save?.length ? permission.save : permission.resources;
      const write = turn.saves.then(async () => {
        const approvals = [...turn.approvals, { action: permission.action, patterns }];
        await writeJson(this.sessionFile(sessionId, "approvals"), approvals);
        turn.approvals = approvals;
      });
      turn.saves = write.catch(() => {});
      await write;
    }
    await this.client.answer(sessionId, id, decision === "always" ? "once" : decision);
  }

  async stop(sessionId: string) {
    if (this.queue.cancel(sessionId)) return;
    const turn = this.active.get(sessionId);
    if (!turn) return;
    turn.stopRequested = true;
    await this.client?.stop(sessionId);
  }

  isWorking(sessionId: string) {
    const turn = this.active.get(sessionId);
    return !!turn && !turn.stopRequested;
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
    const temp = join(this.data, "tmp");
    const engineHome = join(this.data, "home");
    await Promise.all([mkdir(temp, { recursive: true }), mkdir(engineHome, { recursive: true })]);
    const catalog = this.catalog();
    const personal = this.personalModels();
    const password = randomBytes(32).toString("base64url");
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "SHELL", "LANG", "LC_ALL"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    Object.assign(env, {
      XDG_DATA_HOME: join(this.data, "data"),
      XDG_CONFIG_HOME: join(this.data, "config"),
      XDG_STATE_HOME: join(this.data, "state"),
      XDG_CACHE_HOME: join(this.data, "cache"),
      TEMP: temp, TMP: temp, TMPDIR: temp,
      OPENCODE_PASSWORD: password,
      OPENCODE_PURE: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      // OpenCode 2.4.1 resolves global .agents from Global.home, independently of XDG.
      OPENCODE_TEST_HOME: engineHome,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_TELEMETRY: "true",
      DO_NOT_TRACK: "1",
      OPENCODE_DISABLE_FREE_MODELS: enableOpenCodeZenFree ? "false" : "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(this.config(catalog, personal))
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
      console.info("[engine] OpenCode запущен: " + this.executable + " · " + url);
      this.catalogVersion = this.configVersion(catalog, personal);
      this.configuredModels = new Set([...catalog.models, ...personal].map(model => model.id));
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

  private configVersion(catalog: Catalog, personal: PersonalModel[]) {
    return JSON.stringify([catalog.generatedAt, catalog.models, personal, this.settings()]);
  }

  private config(catalog: Catalog, personal: PersonalModel[]) {
    const models = rankedModels(catalog);
    const entries = models.map(model => [model.id, {
      name: model.name,
      limit: { context: model.contextWindow, output: Math.min(8192, Math.floor(model.contextWindow / 4)) },
      capabilities: { tools: model.capabilities.includes("tools"), input: ["text", ...(model.capabilities.includes("vision") ? ["image"] : [])], output: ["text"] }
    }]);
    const personalEntries = personal.map(model => [model.id, {
      name: model.name,
      limit: { context: model.context ?? 32_768, output: model.output ?? Math.min(8192, Math.floor((model.context ?? 32_768) / 4)) },
      capabilities: { tools: true, input: ["text", ...(model.vision ? ["image"] : [])], output: ["text"] }
    }]);
    return {
      model: "vsemkod/auto",
      update: "disable",
      share: "disabled",
      formatter: false,
      lsp: false,
      snapshots: true,
      instructions: ["AGENTS.md"],
      skills: [join(this.configDirectory, "skills"), ".opencode/skills"],
      todo: true,
      websearch: this.settings().webSearch ? { provider: "tinyfish" } : false,
      compaction: { auto: true },
      policies: this.settings().webSearch ? [] : [{ action: "websearch.use", resource: "*", effect: "deny" }],
      mcp: this.settings().mcp,
      permissions: filePermissions,
      agents: {
        ...Object.fromEntries(["build", "plan", "general"].map(agent => [agent, { ...(this.settings().agentSteps ? { steps: this.settings().agentSteps } : {}), ...(agent === "plan" ? { permissions: sessionAccess("read").permissions } : {}) }])),
        title: { disabled: true }
      },
      plugins: [
        "-opencode.provider.kilo", "-opencode.provider.claude-agent", "-opencode.config.compatibility", "-opencode.skill", "-opencode.browser",
        ...(enableOpenCodeZenFree ? [] : ["-opencode.provider.opencode"])
      ],
      providers: {
        vsemkod: {
          name: "vsemkod",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: this.router.baseUrl, apiKey: this.router.token },
          models: Object.fromEntries([["auto", {
            name: "Автовыбор",
            limit: { context: Math.min(...models.filter(model => model.tier !== "basic" && model.origin !== "discovered").map(model => model.contextWindow), 128_000), output: 8192 },
            capabilities: { tools: true, input: ["text"], output: ["text"] }
          }], ["relay", {
            name: "vsemkod",
            limit: { context: 32_768, output: 8192 },
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] }
          }], ...entries, ...personalEntries])
        }
      }
    };
  }
}
