import { basename, isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode, type SessionInfo, type SessionMessageAssistantTool } from "@opencode/client";
import type { ChatAction, ChatEvent, ChatHistory, ChatPart, Conversation, FileChange, McpConfig, PermissionDecision, ProjectTools, QuestionAnswer, SubscriptionId, TurnOptions, Usage } from "../../shared/api";
import { cachePercent, estimateTokens, replySpeed, tokenCharacters } from "../../shared/usage";
import { nativeNames, type PersonalModel } from "../../shared/providers";
import { modelReference } from "../connect-service";
import { accessModes, imageFile, pathMentions } from "../../shared/workspace";
import { ModelWatchdog } from "./model-watchdog";
import { sessionAccess } from "./access";
import { DiffTracker, fileTools, inside } from "./diff-tracker";

const request = () => ({ signal: AbortSignal.timeout(20_000) });
const nativeMethods = {
  "github-copilot": (method: { id: string }) => method.id === "device",
  openai: (method: { id: string }) => method.id === "chatgpt-token-sharing",
  xai: (method: { label: string }) => /SuperGrok/i.test(method.label)
} satisfies Record<SubscriptionId, (method: { id: string; label: string }) => boolean>;
const eventTypes = [
  "session.text.delta", "session.text.ended", "session.tool.input.started", "session.tool.called",
  "session.tool.success", "session.tool.failed", "permission.asked", "permission.replied",
  "session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended", "session.tool.input.delta",
  "session.retry.scheduled", "session.compaction.ended", "session.compaction.failed", "session.step.started", "session.step.streamed", "session.step.ended",
  "form.created", "form.replied", "form.cancelled", "session.execution.failed", "session.execution.interrupted", "session.execution.succeeded"
] as const;

function worktreeLabel(info: SessionInfo): Conversation["worktree"] {
  const origin = info.metadata?.vsemkodWorktreeOrigin;
  const branch = info.metadata?.vsemkodWorktreeBranch;
  if (typeof origin === "string" && typeof branch === "string") return { origin, branch };
}

function conversation(info: SessionInfo): Conversation {
  const worktree = worktreeLabel(info);
  return {
    ...(worktree && { worktree }),
    id: info.id, title: info.title ?? "Новый чат", directory: info.location.directory,
    updatedAt: info.time.updated, archived: Boolean(info.time.archived), pinned: info.metadata?.vsemkodPinned === true,
    variant: info.model?.variant, access: accessModes.find(mode => mode === info.metadata?.vsemkodAccess),
    modelId: info.model?.id === "relay" && info.model.providerID === "vsemkod" && typeof info.metadata?.vsemkodModel === "string" ? info.metadata.vsemkodModel :
      info.model && (info.model.providerID === "vsemkod" ? info.model.id : modelReference(info.model.providerID, info.model.id))
  };
}

function target(input: Record<string, unknown>, directory: string): string {
  for (const field of ["command", "path", "filePath", "file_path", "pattern", "description"]) {
    const value = input[field];
    if (typeof value !== "string") continue;
    if (field !== "command" && isAbsolute(value)) {
      const local = relative(directory, value);
      if (local && !local.startsWith("..") && !isAbsolute(local)) return local;
    }
    return value;
  }
  return "";
}

function mutationTargets(input: Record<string, unknown>, fallback: string): string[] {
  const patch = input.patchText ?? input.patch_text ?? input.patch;
  if (typeof patch === "string") {
    const paths = Array.from(patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm), match => match[1].trim());
    if (paths.length) return [...new Set(paths)];
  }
  return fallback ? [fallback] : [];
}

function outputText(content: readonly ({ type: "text"; text: string } | { type: "file" })[] | undefined) {
  const text = content?.flatMap(item => item.type === "text" ? [item.text] : []).join("\n").slice(0, 12_000);
  return text || undefined;
}

function toToolPart(tool: SessionMessageAssistantTool, directory: string): Extract<ChatPart, { kind: "tool" }> {
  const state = tool.state;
  return {
    id: tool.id, kind: "tool", tool: tool.name,
    target: typeof state.input === "string" ? "" : target(state.input, directory),
    status: state.status === "completed" ? "completed" : state.status === "error" ? "error" : "running",
    todos: state.status === "completed" && tool.name === "todowrite" ? readTodos(state.input.todos) : undefined,
    output: state.status === "completed" ? outputText(state.content) : state.status === "error" ? state.error.message : undefined
  };
}

function readTodos(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("content" in item) || typeof item.content !== "string") return [];
    const status = "status" in item && typeof item.status === "string" ? item.status : "pending";
    return [{ content: item.content, status }];
  });
}

function userError(error: { message: string; status?: number }): string {
  if (error.status === 429 || /quota|rate.limit/i.test(error.message)) return "Квота модели исчерпана. Попробуйте позже или выберите другую модель.";
  if (error.status === 401 || error.status === 403) return "Провайдер отклонил доступ к выбранной модели.";
  if (error.status === 503) return "Для этой модели сейчас нет доступной раздачи.";
  if (error.status === 408 || error.status === 504 || /timeout|timed out/i.test(error.message)) return "Провайдер не ответил вовремя. Повторите запрос или выберите другую модель.";
  if ((error.status ?? 0) >= 500 || /fetch|network/i.test(error.message)) return "Провайдер не ответил. Проверьте соединение или повторите позже.";
  return "Агент не смог выполнить запрос. " + error.message.slice(0, 400);
}

export type EngineModel = { id: string; providerID: string };
export type NativeModel = { model: PersonalModel; upstream: EngineModel };

export class EngineAdapter {
  private readonly client;
  private readonly sideSessions = new Set<string>();
  private readonly modelWaits = new Map<string, () => void>();

  constructor(private readonly url: string, auth: string) {
    this.client = OpenCode.make({ baseUrl: url, headers: { authorization: auth } });
  }

  info() { return this.client.server.info(request()); }

  routerActivity(sessionId: string) { this.modelWaits.get(sessionId)?.(); }

  async nativeConnections(directory: string) {
    const location = { directory };
    await this.client.model.list({ location }, request());
    const read = async () => (await this.client.integration.list({ location }, request())).data
      .filter(entry => Object.hasOwn(nativeMethods, entry.id));
    let integrations = await read();
    const settled = () => Object.entries(nativeMethods).every(([id, matches]) =>
      integrations.some(entry => String(entry.id) === id &&
        entry.methods.some(method => method.type === "oauth" && matches(method))));
    for (let attempt = 0; !settled() && attempt < 30; attempt++) {
      await delay(100);
      integrations = await read();
    }
    return integrations;
  }

  async nativeModels(directory: string, subscriptions: SubscriptionId[], zen: boolean): Promise<NativeModel[]> {
    const result = await this.client.model.list({ location: { directory } }, request());
    return result.data.flatMap(entry => {
      const providerId = String(entry.providerID);
      if (providerId !== "github-copilot" && providerId !== "openai" && providerId !== "opencode" && providerId !== "xai") return [];
      if (!entry.enabled || !entry.capabilities?.tools) return [];
      if (providerId === "opencode") {
        if (!zen || !entry.cost?.length || entry.cost.some(price => price.input !== 0 || price.output !== 0)) return [];
      } else if (!subscriptions.includes(providerId)) return [];
      return [{
        model: {
          id: modelReference(providerId, entry.id), name: entry.name, providerId, providerName: nativeNames[providerId],
          kind: providerId === "opencode" ? "zen" : "subscription",
          context: entry.limit?.context, output: entry.limit?.output, vision: entry.capabilities.input.includes("image")
        },
        upstream: { id: entry.id, providerID: providerId }
      }];
    });
  }

  async signIn(
    directory: string, id: SubscriptionId, present: (url: string, code?: string) => Promise<void>, signal: AbortSignal
  ) {
    const entry = (await this.nativeConnections(directory)).find(item => String(item.id) === id);
    const method = entry?.methods.filter(method => method.type === "oauth").find(nativeMethods[id]);
    if (!method) {
      throw new Error("Штатный вход недоступен в этой сборке OpenCode.");
    }
    const location = { directory };
    const attempt = await this.client.integration.oauth.connect({
      integrationID: id, methodID: method.id, location, ...(id === "github-copilot" ? { answer: { deploymentType: "github.com" } } : {})
    }, request()).catch(() => {
      throw new Error("Не удалось начать вход. Проверьте соединение и попробуйте ещё раз.");
    });
    const input = { integrationID: id, attemptID: attempt.data.attemptID, location };
    let complete = false;
    try {
      signal.throwIfAborted();
      const code = id === "xai" ? /enter code:\s*([a-z0-9-]+)/i.exec(attempt.data.instructions)?.[1]
        : id === "github-copilot" ? /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/i.exec(attempt.data.instructions)?.[0] : undefined;
      if (id === "github-copilot" && !code) throw new Error("GitHub не вернул код устройства. Попробуйте ещё раз.");
      await present(attempt.data.url, code);
      while (!signal.aborted && Date.now() < attempt.data.time.expires) {
        const { data } = await this.client.integration.oauth.status(input, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        }).catch(() => {
          throw new Error("Не удалось проверить вход. Проверьте соединение и попробуйте ещё раз.");
        });
        if (data.status === "complete") { complete = true; return; }
        if (data.status === "failed") throw new Error(id === "github-copilot"
          ? "GitHub не подтвердил вход. Проверьте доступ к Copilot и повторите попытку."
          : id === "openai" ? "ChatGPT не подтвердил вход. Проверьте доступ Plus или Pro и повторите попытку."
          : "SuperGrok не подтвердил вход. Проверьте подписку и повторите попытку.");
        if (data.status === "expired") break;
        await delay(1000, undefined, { signal });
      }
      throw new Error("Время входа истекло. Попробуйте ещё раз.");
    } finally {
      if (!complete) await this.client.integration.oauth.cancel(input, request()).catch(() => {});
    }
  }

  async disconnect(directory: string, id: SubscriptionId) {
    const entry = (await this.nativeConnections(directory)).find(item => String(item.id) === id);
    for (const connection of entry?.connections ?? []) {
      if (connection.type === "credential") await this.client.credential.remove({ credentialID: connection.id }, request());
    }
  }

  async list(directory?: string): Promise<Conversation[]> {
    const chats: Conversation[] = [];
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      do {
        const page = await this.client.session.list({ directory, archived, limit: 100, cursor }, request());
        chats.push(...page.data.filter(info => !info.metadata?.vsemkodSide && !this.sideSessions.has(info.id)).map(conversation));
        cursor = page.cursor?.next ?? undefined;
      } while (cursor);
    }
    return chats;
  }

  async create(directory: string, title: string, worktree?: Conversation["worktree"]): Promise<Conversation> {
    const metadata = worktree && { vsemkodWorktreeOrigin: worktree.origin, vsemkodWorktreeBranch: worktree.branch };
    return conversation(await this.client.session.create({ location: { directory }, title, metadata }, request()));
  }

  async createSide(directory: string, parent?: string) {
    const access = sessionAccess("read");
    const session = parent
      ? await this.client.session.fork({ sessionID: parent }, request())
      : await this.client.session.create({ location: { directory }, title: "Боковой чат",
          metadata: { vsemkodSide: true }, agent: access.agent, permissions: access.permissions }, request());
    const sessionID = session.id;
    this.sideSessions.add(sessionID);
    try {
      if (parent) await this.client.session.update({ sessionID, permissions: access.permissions,
        metadata: { ...session.metadata, vsemkodSide: true } }, request());
      return sessionID;
    } catch (error) {
      await this.removeSide(sessionID).catch(() => {});
      throw error;
    }
  }

  async removeSide(sessionID: string) {
    await this.client.session.remove({ sessionID }, request());
    this.sideSessions.delete(sessionID);
  }

  async shellTasks(directory: string) {
    return (await this.client.shell.list({ location: { directory } }, request())).data;
  }

  async backgroundJobs() {
    return this.client.experimental.job.list({ kind: "shell" }, request());
  }

  async persistentTasks(sessionID: string) {
    return this.client.experimental.persistentPty.list({ sessionID }, request());
  }

  async persistentOutput(ptyID: string) {
    return (await this.client.experimental.persistentPty.snapshot({ ptyID }, request())).text;
  }

  async removePersistentTask(ptyID: string) {
    await this.client.experimental.persistentPty.remove({ ptyID }, request());
  }

  async startBackground(directory: string, command: string) {
    return (await this.client.shell.create({ command, cwd: directory, location: { directory } }, request())).data;
  }

  async backgroundInfo(directory: string, id: string) {
    return (await this.client.shell.get({ id, location: { directory } }, request())).data;
  }

  async backgroundOutput(directory: string, id: string, cursor: number) {
    return (await this.client.shell.output({ id, location: { directory }, cursor, limit: 65536 }, request())).data;
  }

  async stopBackground(directory: string, shellId: string, jobId?: string) {
    if (jobId) await this.client.experimental.job.cancel({ id: jobId }, request());
    else await this.client.shell.remove({ id: shellId, location: { directory } }, request());
  }

  async chatAction(sessionId: string, action: ChatAction) {
    const sessionID = sessionId;
    if (action.type === "delete") {
      await this.client.session.remove({ sessionID }, request());
      return null;
    }
    const info = await this.client.session.get({ sessionID }, request());
    if (action.type === "fork") {
      const fork = await this.client.session.fork({ sessionID }, request());
      const worktree = worktreeLabel(info);
      if (!worktree || worktreeLabel(fork)) return conversation(fork);
      const metadata = { ...fork.metadata, vsemkodWorktreeOrigin: worktree.origin, vsemkodWorktreeBranch: worktree.branch };
      const forkId = fork.id;
      await this.client.session.update({ sessionID: forkId, metadata }, request());
      return conversation({ ...fork, metadata });
    }
    await this.client.session.update({
      sessionID,
      ...(action.type === "rename" ? { title: action.title } : action.type === "archive" ? { archived: action.value }
        : action.type === "pin" ? { metadata: { ...info.metadata, vsemkodPinned: action.value } } : {})
    }, request());
    return conversation(await this.client.session.get({ sessionID }, request()));
  }

  async revert(sessionID: string, messageID?: string) {
    if (messageID) await this.client.session.revert.stage({ sessionID, messageID, files: true }, request());
    else await this.client.session.revert.clear({ sessionID }, request());
  }

  async isGit(directory: string) {
    const info = await this.client.location.get({ location: { directory } }, request());
    return (await this.client.project.list({}, request())).some(project => project.id === info.project.id && project.vcs === "git");
  }

  async tools(directory: string): Promise<ProjectTools> {
    const location = { directory };
    const [commands, skills] = await Promise.all([
      this.client.command.list({ location }, request()), this.client.skill.list({ location }, request())
    ]);
    return { commands: commands.data, skills: skills.data.map(({ id, name, description, path }) => ({ id, name, description, path })) };
  }

  async findFiles(directory: string, query: string) {
    return (await this.client.file.find({ location: { directory }, query, limit: 12 }, request())).data;
  }

  async listFiles(directory: string, path?: string) {
    return (await this.client.file.list({ location: { directory }, path }, request())).data;
  }

  async readFile(directory: string, path: string) {
    const content = await this.client.file.read({ location: { directory }, path }, request());
    if (content.includes(0)) throw new Error("Для двоичного файла нет текстового просмотра.");
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  }

  async answerQuestion(sessionID: string, formID: string, answer?: QuestionAnswer) {
    if (answer) await this.client.session.form.reply({ sessionID, formID, answer }, request());
    else await this.client.session.form.cancel({ sessionID, formID }, request());
  }

  async modelInfo(directory: string, model: EngineModel) {
    const { data } = await this.client.model.list({ location: { directory } }, request());
    return data.find(item => item.id === model.id && item.providerID === model.providerID);
  }

  async mcpList(directory: string) {
    return (await this.client.mcp.list({ location: { directory } }, request())).data;
  }

  async mcpCheck(directory: string, server: string, config?: McpConfig) {
    const location = { directory };
    if (config?.disabled) return;
    if (config && !(await this.mcpList(directory)).some(item => item.name === server)) {
      await this.mcpSet(directory, server, config);
    }
    await this.client.experimental.mcp.connect({ location, server }, request());
  }

  async mcpSet(directory: string, server: string, config?: McpConfig) {
    const location = { directory };
    if (config) {
      await this.client.experimental.mcp.add({ location, server, config }, request());
    } else if ((await this.mcpList(directory)).some(item => item.name === server)) {
      await this.client.experimental.mcp.remove({ location, server }, request());
    }
  }

  async mcpAuthorize(directory: string, server: string, present: (url: string) => Promise<void>, signal: AbortSignal) {
    const location = { directory };
    const options = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    const status = async () => (await this.client.mcp.list({ location }, options())).data.find(item => item.name === server);
    const current = await status();
    if (current?.status.status === "connected") return;
    if (!current?.integrationID || current.status.status === "disabled") throw new Error("Вход для этого коннектора недоступен.");
    const integrationID = current.integrationID;
    const { data: integration } = await this.client.integration.get({ integrationID, location }, options());
    const method = integration.methods.find(item => item.type === "oauth");
    if (!method || method.form) throw new Error("Этот коннектор не поддерживает автоматический вход в OpenCode.");

    let attempt;
    try {
      ({ data: attempt } = await this.client.integration.oauth.connect({ integrationID, methodID: method.id, location }, options()));
    } catch (error) {
      signal.throwIfAborted();
      throw new Error("OpenCode не смог начать вход для этого коннектора. " + (error instanceof Error ? error.message : ""));
    }
    const input = { integrationID, attemptID: attempt.attemptID, location };
    let complete = false;
    try {
      signal.throwIfAborted();
      if (attempt.mode === "code") throw new Error("Сервер запрашивает ручной ввод кода.");
      await present(attempt.url);
      while (Date.now() < attempt.time.expires) {
        const { data } = await this.client.integration.oauth.status(input, options());
        if (data.status === "expired") return;
        if (data.status === "failed") {
          if (/access[_ ]denied|cancel(?:led|ed)|denied the request/i.test(data.message)) return;
          throw new Error("Сервер не подтвердил вход. Попробуйте ещё раз.");
        }
        if (data.status === "complete") { complete = true; break; }
        await delay(500, undefined, { signal });
      }
      while (complete) {
        const serverStatus = (await status())?.status.status;
        if (serverStatus === "connected") return;
        await delay(500, undefined, { signal });
      }
    } finally {
      if (!complete) await this.client.integration.oauth.cancel(input, { signal: AbortSignal.timeout(2_000) }).catch(() => {});
    }
  }

  async mcpLogout(directory: string, server: string) {
    const location = { directory };
    const integrationID = (await this.mcpList(directory)).find(item => item.name === server)?.integrationID;
    if (!integrationID) return;
    const { data } = await this.client.integration.get({ integrationID, location }, request());
    for (const connection of data.connections) {
      if (connection.type === "credential") await this.client.credential.remove({ credentialID: connection.id }, request());
    }
  }

  async openTerminal(directory: string, onData: (text: string) => void, onClose: () => void) {
    const location = { directory };
    const { data } = await this.client.pty.create({ location, cwd: directory }, request());
    const ptyID = data.id;
    const input = { location, ptyID };
    const remove = () => this.client.pty.remove(input, request()).catch(() => {});
    try {
      const { data: { ticket } } = await this.client.pty.connect.token({ ...input, "x-opencode-ticket": "1" }, request());
      const endpoint = new URL("/api/pty/" + encodeURIComponent(ptyID) + "/connect", this.url);
      endpoint.protocol = "ws:";
      endpoint.search = new URLSearchParams({ "location[directory]": directory, ticket, cursor: "0" }).toString();
      const socket = new WebSocket(endpoint);
      socket.addEventListener("message", event => { if (typeof event.data === "string") onData(event.data); });
      socket.addEventListener("close", () => { onClose(); void remove(); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error("Терминал не ответил.")); }, 7000);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Не удалось подключить терминал.")); }, { once: true });
      });
      return {
        input: (text: string) => { if (socket.readyState === WebSocket.OPEN) socket.send(text); },
        resize: (cols: number, rows: number) => this.client.pty.update({ ...input, size: { cols, rows } }, request()).then(() => {}),
        close: () => { socket.close(); return remove(); }
      };
    } catch (error) {
      await remove();
      throw error;
    }
  }

  async history(sessionId: string, directory: string, toolDiffs: Record<string, FileChange[]> = {}, includeReverted = false): Promise<ChatHistory> {
    const parts: ChatPart[] = [];
    const session = await this.client.session.get({ sessionID: sessionId }, request());
    let cursor: string | undefined;
    let tokens: Usage | undefined;
    let hidden = false;
    let turnStarted: number | undefined;
    let userId: string | undefined;
    do {
      const page = await this.client.message.list({
        sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: "asc" })
      }, request());
      for (const message of page.data) {
        if (!includeReverted && message.id === session.revert?.messageID) hidden = true;
        if (hidden) break;
        if (message.type === "user") {
          turnStarted = message.time.created;
          userId = message.id;
          parts.push({ id: message.id, kind: "user", text: message.text, files: message.files?.map(file => file.name ?? "") });
        } else if (message.type === "assistant") {
          turnStarted ??= message.time.created;
          tokens = message.tokens ?? tokens;
          for (const [index, item] of message.content.entries()) {
            const id = message.id + "/" + index;
            if (item.type === "text") parts.push({ id, kind: "text", text: item.text });
            if (item.type === "tool") {
              const diffs = toolDiffs[item.id];
              parts.push({ ...toToolPart(item, directory), diff: diffs?.[0], diffs });
            }
            if (item.type === "reasoning") parts.push({ id, kind: "reasoning", text: item.text,
              seconds: item.time && Math.round((item.time.completed ?? item.time.created) - item.time.created) / 1000 });
          }
        } else if (message.type === "compaction" && message.status === "completed") {
          parts.push({ id: message.id, kind: "note", text: "Контекст сжат" });
          tokens = message.tokens ?? tokens;
        } else if (message.type === "idle" && turnStarted !== undefined) {
          parts.push({ id: message.id, kind: "turn", seconds: Math.max(0, (message.time.created - turnStarted) / 1000),
            stopped: message.outcome === "interrupted", files: userId ? toolDiffs["turn:" + userId] : undefined });
          turnStarted = undefined;
          userId = undefined;
        }
      }
      cursor = hidden ? undefined : page.cursor?.next ?? undefined;
    } while (cursor);
    const visibleDiffs = parts.flatMap(part => part.kind === "tool" ? part.diffs ?? [] : []);
    return { parts, reverted: Boolean(session.revert), usage: tokens, changes: mergeChanges(visibleDiffs, await this.changes(sessionId)) };
  }

  async changes(sessionId: string, from?: string, to?: string) {
    return this.client.session.diff({ sessionID: sessionId, from, to }, request()).catch(() => []);
  }

  async providerIds(directory: string): Promise<string[]> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await this.client.model.list({ location: { directory } }, request());
      const active = [...new Set(result.data.filter(model => model.enabled).map(model => model.providerID))];
      if (active.includes("vsemkod")) return active;
      await delay(100);
    }
    return [];
  }

  async send(
    sessionId: string,
    directory: string,
    text: string,
    model: EngineModel,
    files: string[],
    emit: (event: ChatEvent) => void,
    interrupted: () => boolean,
    options: TurnOptions & { webSearch?: boolean; routerError?: () => string | undefined; displayModelId?: string; nativeSpeed?: (speed: NonNullable<ReturnType<typeof replySpeed>>, live: boolean) => void } = {}
  ) {
    const signal = new AbortController();
    const events = this.client.event.subscribe({ types: eventTypes, signal: signal.signal })[Symbol.asyncIterator]();
    const tools = new Map<string, Extract<ChatPart, { kind: "tool" }>>();
    const toolTodos = new Map<string, ReturnType<typeof readTodos>>();
    const tracker = new DiffTracker(directory);
    const reasoning = new Map<string, number>();
    const runningTools = new Set<string>();
    const blockers = new Set<string>();
    let watchdog!: ModelWatchdog;
    const timeout = new Promise<never>((_, reject) => {
      watchdog = new ModelWatchdog(since => emit({ type: "model-wait", sessionId, since }), reject);
    });
    void timeout.catch(() => {});
    const waitForModel = () => { if (!runningTools.size && !blockers.size) watchdog.wait(); };
    let context: number | undefined;
    let step: { id: string; started: number; first?: number; cyrillic: number; other: number } | undefined;
    let speedTimer: ReturnType<typeof setInterval> | undefined;
    const count = (id: string, delta: string) => {
      if (step?.id !== id || !options.nativeSpeed) return;
      const chars = tokenCharacters(delta);
      step.cyrillic += chars.cyrillic;
      step.other += chars.other;
    };
    const firstToken = (id: string, time: number) => { if (step?.id === id) step.first ??= time; };
    const update = (part: ChatPart) => emit({ type: "part", sessionId, part });
    let queued = false;
    let error: string | undefined;
    let stopped = false;
    const connectionTimeout = setTimeout(() => signal.abort(), 10_000);
    try {
      const connected = await events.next();
      if (connected.done || connected.value.type !== "server.connected") throw new Error("Не удалось подключиться к потоку событий OpenCode.");
    } catch (error) {
      signal.abort();
      await events.return?.().catch(() => {});
      throw error;
    } finally { clearTimeout(connectionTimeout); }
    const collect = async () => {
      while (true) {
        const next = await events.next();
        if (next.done) throw new Error("Поток событий OpenCode прервался.");
        const event = next.value;
        if (event.type === "form.created") {
          const { form } = event.data;
          if (form.sessionID === sessionId) {
            blockers.add(form.id);
            watchdog.pause();
            emit({ type: "question", sessionId, question: form });
          }
          continue;
        }
        if (!("sessionID" in event.data) || event.data.sessionID !== sessionId) continue;
        switch (event.type) {
          case "form.replied":
          case "form.cancelled":
            blockers.delete(event.data.id);
            waitForModel();
            emit({ type: "question-resolved", sessionId, id: event.data.id });
            break;
          case "session.reasoning.started":
            reasoning.set(event.data.assistantMessageID + "/" + event.data.ordinal, event.created);
            break;
          case "session.reasoning.delta": {
            if (event.data.delta) {
              firstToken(event.data.assistantMessageID, event.created);
              count(event.data.assistantMessageID, event.data.delta);
              waitForModel();
            }
            emit({ type: "delta", sessionId, partId: event.data.assistantMessageID + "/" + event.data.ordinal,
              delta: event.data.delta, kind: "reasoning" });
            break;
          }
          case "session.reasoning.ended": {
            const id = event.data.assistantMessageID + "/" + event.data.ordinal;
            update({ id, kind: "reasoning", text: event.data.text,
              seconds: Math.max(0, Math.round((event.created - (reasoning.get(id) ?? event.created)) / 1000)) });
            break;
          }
          case "session.step.started":
            step = { id: event.data.assistantMessageID, started: event.created, cyrillic: 0, other: 0 };
            clearInterval(speedTimer);
            if (options.nativeSpeed && !options.compact) speedTimer = setInterval(() => {
              if (!step) return;
              const speed = replySpeed(estimateTokens(step.cyrillic, step.other), 0, step.started, step.first, Date.now());
              if (speed) options.nativeSpeed?.({ ...speed, estimated: true }, true);
            }, 1000);
            waitForModel();
            break;
          case "session.step.streamed":
            firstToken(event.data.assistantMessageID, event.created);
            break;
          case "session.step.ended": {
            const tokens = event.data.tokens;
            const timing = step?.id === event.data.assistantMessageID ? step : undefined;
            if (timing && options.nativeSpeed && !options.compact && event.data.finish !== "error") {
              const estimated = !(tokens.output + tokens.reasoning);
              const output = estimated ? estimateTokens(timing.cyrillic, timing.other) : tokens.output + tokens.reasoning;
              const speed = replySpeed(output, 0, timing.started, timing.first, event.created);
              if (speed) options.nativeSpeed({ ...speed, estimated }, false);
            }
            const nativeCachePercent = model.providerID !== "vsemkod"
              ? (tokens.cache.read > 0 ? cachePercent(tokens.input, tokens.cache.read) : undefined) ?? null : undefined;
            emit({ type: "usage", sessionId, usage: { ...tokens, context }, nativeCachePercent });
            if (timing) { clearInterval(speedTimer); step = undefined; }
            break;
          }
          case "session.compaction.ended":
            update({ id: event.id, kind: "note", text: "Контекст сжат" });
            if (event.data.tokens) emit({ type: "usage", sessionId, usage: { ...event.data.tokens, context } });
            if (options.compact) return;
            break;
          case "session.compaction.failed":
            if (options.compact) { error = "Не удалось сжать контекст."; return; }
            break;
          case "session.text.delta":
          case "session.text.ended": {
            const id = event.data.assistantMessageID + "/" + event.data.ordinal;
            if (event.type === "session.text.delta") {
              if (event.data.delta) {
                firstToken(event.data.assistantMessageID, event.created);
                count(event.data.assistantMessageID, event.data.delta);
                waitForModel();
              }
              emit({ type: "delta", sessionId, partId: id, delta: event.data.delta });
            } else update({ id, kind: "text", text: event.data.text });
            break;
          }
          case "session.tool.input.started": {
            const { id, name } = event.data;
            const tool = { id, kind: "tool", tool: name, target: "", status: "running" } as const;
            tools.set(id, tool);
            waitForModel();
            update(tool);
            break;
          }
          case "session.tool.input.delta":
            if (event.data.delta) waitForModel();
            break;
          case "session.tool.called": {
            const { id, input } = event.data;
            const name = tools.get(id)?.tool ?? "tool";
            runningTools.add(id);
            watchdog.pause();
            const paths = mutationTargets(input, target(input, directory));
            const tool = { id, kind: "tool", tool: name, target: paths.join(", "), status: "running",
              background: ["shell", "bash"].includes(name) && input.background === true || undefined } as const;
            tools.set(id, tool);
            if (tool.tool === "todowrite") toolTodos.set(id, readTodos(input.todos));
            update(tool);
            if (fileTools.has(tool.tool)) await tracker.capture(id, paths);
            break;
          }
          case "session.tool.success":
          case "session.tool.failed": {
            const id = event.data.id;
            runningTools.delete(id);
            const tool = tools.get(id);
            if (tool) {
              tool.status = event.type === "session.tool.success" ? "completed" : "error";
              if (tool.status === "completed" && tool.tool === "todowrite") tool.todos = toolTodos.get(tool.id);
              tool.output = event.type === "session.tool.success" ? outputText(event.data.content) : event.data.error.message;
              if (tool.status === "completed" && fileTools.has(tool.tool)) {
                tool.diffs = await tracker.finish(tool.id, tool.target, tool.output);
                tool.diff = tool.diffs[0];
              }
              update({ ...tool });
            }
            waitForModel();
            break;
          }
          case "permission.asked": {
            const { id, action, resources, save } = event.data;
            blockers.add(id);
            watchdog.pause();
            if (action === "edit" && event.data.source?.id) await tracker.capture(event.data.source.id, resources);
            emit({ type: "permission", sessionId, permission: { id, action, resources, save } });
            break;
          }
          case "permission.replied":
            blockers.delete(event.data.requestID);
            waitForModel();
            emit({ type: "permission-resolved", sessionId, id: event.data.requestID });
            break;
          case "session.retry.scheduled":
            throw new Error(options.routerError?.() ?? userError(event.data.error));
          case "session.execution.failed":
            error = options.routerError?.() ?? userError(event.data.error);
            return;
          case "session.execution.interrupted":
            stopped = true;
            return;
          case "session.execution.succeeded":
            return;
        }
      }
    };
    const stream = collect();
    void stream.catch(() => {});
    try {
      const info = await this.client.session.get({ sessionID: sessionId }, request());
      const access = options.access ?? "ask";
      const { agent, permissions } = sessionAccess(access, options.webSearch && !info.metadata?.vsemkodSide);
      if (info.metadata?.vsemkodSide) permissions.push({ action: "question", resource: "*", effect: "deny" });
      await this.client.session.update({
        sessionID: sessionId, permissions, metadata: { ...info.metadata, vsemkodAccess: access, ...(options.displayModelId && { vsemkodModel: options.displayModelId }) }
      }, request());
      if (info.agent !== agent) await this.client.session.switchAgent({ sessionID: sessionId, agent }, request());
      const selection = await this.modelInfo(directory, model).catch(() => undefined);
      context = selection?.limit.context;
      await this.client.session.switchModel({ sessionID: sessionId, model: { ...model, variant: options.variant } }, request());
      if (interrupted()) return { changes: await this.changes(sessionId), stopped: true, artifacts: [] };
      queued = true;
      const replay = options.replayMessageId
        ? await this.client.session.message.get({ sessionID: sessionId, messageID: options.replayMessageId }, request()) : undefined;
      const originalFiles = replay?.type === "user" ? replay.files?.filter(file => !file.mention) ?? [] : [];
      if (originalFiles.some(file => file.mime.startsWith("image/")) && !selection?.capabilities.input.includes("image")) {
        throw new Error("Выбранная модель не принимает изображения.");
      }
      const attachments = [
        ...originalFiles.map(file => ({ uri: "data:" + file.mime + ";base64," + file.data, name: file.name, description: file.description })),
        ...files.map(path => ({ uri: pathToFileURL(path).href, name: basename(path) })),
        ...await Promise.all(pathMentions(text).map(async ({ path, ...mention }) => {
          const target = await realpath(resolve(directory, path)).catch(() => undefined);
          if (!target || !inside(directory, target)) throw new Error("Файл или папка из упоминания недоступны: " + path);
          if (imageFile(target) && !selection?.capabilities.input.includes("image")) throw new Error("Выбранная модель не принимает изображения.");
          return { uri: pathToFileURL(target).href, name: basename(target), mention };
        }))
      ];
      this.modelWaits.set(sessionId, waitForModel);
      waitForModel();
      if (options.compact) await this.client.session.compact({ sessionID: sessionId }, request());
      else if (options.command) await this.client.session.command({
        sessionID: sessionId, name: options.command.name, text: options.command.args, files: attachments
      }, request());
      else {
        if (options.skill) await this.client.experimental.session.skill({ sessionID: sessionId, id: options.skill, resume: false }, request());
        await this.client.session.prompt({ sessionID: sessionId, text, files: attachments }, request());
      }
      if (interrupted()) {
        await this.stop(sessionId);
        return { changes: await this.changes(sessionId), stopped: true, artifacts: [] };
      }
      await Promise.race([stream, timeout]);
      if (error) throw new Error(error);
      return { changes: mergeChanges(tracker.results(), await this.changes(sessionId)), stopped, artifacts: tracker.artifacts() };
    } catch (failure) {
      const routed = options.routerError?.();
      if (queued) await this.stop(sessionId).catch(() => {});
      if (routed) throw new Error(routed);
      throw failure;
    } finally {
      this.modelWaits.delete(sessionId);
      clearInterval(speedTimer);
      watchdog.pause();
      signal.abort();
      await events.return?.().catch(() => {});
    }
  }

  async stop(sessionId: string): Promise<void> {
    await this.client.session.interrupt({ sessionID: sessionId }, request());
  }

  answer(sessionId: string, id: string, decision: PermissionDecision) {
    return this.client.permission.reply({ sessionID: sessionId, requestID: id, decision }, request());
  }
}

export function mergeChanges(local: FileChange[], engine: FileChange[]): FileChange[] {
  return [...new Map([...local, ...engine].map(change => [change.file.replaceAll("\\", "/"), change])).values()];
}
