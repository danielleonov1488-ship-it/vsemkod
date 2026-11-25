import { basename, isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode, type SessionInfo, type SessionMessageAssistantTool } from "@opencode/client";
import type { ChatEvent, ChatPart, Conversation, FileChange, PermissionDecision, SubscriptionId } from "../../shared/api";
import { nativeNames, type PersonalModel } from "../../shared/providers";
import { modelReference } from "../connect-service";
import { DiffTracker, fileTools } from "./diff-tracker";

const request = () => ({ signal: AbortSignal.timeout(20_000) });
const nativeMethods: Record<SubscriptionId, string> = { "github-copilot": "device", openai: "chatgpt-token-sharing" };
const eventTypes = [
  "session.text.delta", "session.text.ended", "session.tool.input.started", "session.tool.called",
  "session.tool.success", "session.tool.failed", "permission.asked", "permission.replied",
  "session.execution.failed", "session.execution.interrupted", "session.execution.succeeded"
] as const;

function conversation(info: SessionInfo): Conversation {
  return {
    id: info.id, title: info.title ?? "Новый чат", directory: info.location.directory,
    updatedAt: info.time.updated,
    modelId: info.model && (info.model.providerID === "vsemkod" ? info.model.id : modelReference(info.model.providerID, info.model.id))
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
    output: state.status === "completed" ? outputText(state.content) : state.status === "error" ? state.error.message : undefined
  };
}

function userError(error: { message: string; status?: number }): string {
  if (error.status === 429 || /quota|rate.limit/i.test(error.message)) return "Квота модели исчерпана. Попробуйте позже или выберите другую модель.";
  if (error.status === 401 || error.status === 403) return "Провайдер отклонил доступ к выбранной модели.";
  if (error.status === 503) return "Для этой модели сейчас нет доступной раздачи.";
  if ((error.status ?? 0) >= 500 || /fetch|network|timeout|timed out/i.test(error.message)) return "Провайдер не ответил. Проверьте соединение или повторите позже.";
  return "Агент не смог выполнить запрос. " + error.message.slice(0, 400);
}

export type EngineModel = { id: string; providerID: string };
export type NativeModel = { model: PersonalModel; upstream: EngineModel };

export class EngineAdapter {
  private readonly client;

  constructor(url: string, auth: string) {
    this.client = OpenCode.make({ baseUrl: url, headers: { authorization: auth } });
  }

  info() { return this.client.server.info(request()); }

  async nativeConnections(directory: string) {
    const location = { directory };
    await this.client.model.list({ location }, request());
    const read = async () => (await this.client.integration.list({ location }, request())).data
      .filter(entry => entry.id === "github-copilot" || entry.id === "openai");
    let integrations = await read();
    const settled = () => Object.entries(nativeMethods).every(([id, methodID]) =>
      integrations.some(entry => String(entry.id) === id &&
        entry.methods.some(method => method.type === "oauth" && String(method.id) === methodID)));
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
      if (providerId !== "github-copilot" && providerId !== "openai" && providerId !== "opencode") return [];
      if (!entry.enabled || !entry.capabilities?.tools) return [];
      if (providerId === "opencode") {
        if (!zen || !entry.cost?.length || entry.cost.some(price => price.input !== 0 || price.output !== 0)) return [];
      } else if (!subscriptions.includes(providerId)) return [];
      return [{
        model: {
          id: modelReference(providerId, entry.id), name: entry.name, providerId, providerName: nativeNames[providerId],
          context: entry.limit?.context, vision: entry.capabilities.input.includes("image")
        },
        upstream: { id: entry.id, providerID: providerId }
      }];
    });
  }

  async signIn(
    directory: string, id: SubscriptionId, present: (url: string, code?: string) => Promise<void>, signal: AbortSignal
  ) {
    const methodID = nativeMethods[id];
    const entry = (await this.nativeConnections(directory)).find(item => String(item.id) === id);
    if (!entry?.methods.some(method => method.type === "oauth" && String(method.id) === methodID)) {
      throw new Error("Штатный вход недоступен в этой сборке OpenCode.");
    }
    const location = { directory };
    const attempt = await this.client.integration.oauth.connect({
      integrationID: id, methodID, location, ...(id === "github-copilot" ? { answer: { deploymentType: "github.com" } } : {})
    }, request()).catch(() => {
      throw new Error("Не удалось начать вход. Проверьте соединение и попробуйте ещё раз.");
    });
    const input = { integrationID: id, attemptID: attempt.data.attemptID, location };
    let complete = false;
    try {
      signal.throwIfAborted();
      const code = id === "github-copilot" ? /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/i.exec(attempt.data.instructions)?.[0] : undefined;
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
          : "ChatGPT не подтвердил вход. Проверьте доступ Plus или Pro и повторите попытку.");
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

  async list(directory: string): Promise<Conversation[]> {
    const result = await this.client.session.list({ directory, parentID: null, limit: 100 }, request());
    return result.data.map(conversation);
  }

  async create(directory: string, title: string): Promise<Conversation> {
    const info = await this.client.session.create({ location: { directory }, title }, request());
    return conversation(info);
  }

  async history(sessionId: string, directory: string, toolDiffs: Record<string, FileChange> = {}) {
    const parts: ChatPart[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.message.list({
        sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: "asc" })
      }, request());
      for (const message of page.data) {
        if (message.type === "user") {
          parts.push({ id: message.id, kind: "user", text: message.text, files: message.files?.map(file => file.name ?? "") });
        } else if (message.type === "assistant") {
          for (const [index, item] of message.content.entries()) {
            if (item.type === "text") parts.push({ id: message.id + "/" + index, kind: "text", text: item.text });
            if (item.type === "tool") parts.push({ ...toToolPart(item, directory), diff: toolDiffs[item.id] });
          }
        }
      }
      cursor = page.cursor?.next ?? undefined;
    } while (cursor);
    return { parts, changes: mergeChanges(Object.values(toolDiffs), await this.changes(sessionId)) };
  }

  async changes(sessionId: string) {
    return this.client.session.diff({ sessionID: sessionId }, request()).catch(() => []);
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
    interrupted: () => boolean
  ) {
    const signal = new AbortController();
    const events = this.client.event.subscribe({ types: eventTypes, signal: signal.signal })[Symbol.asyncIterator]();
    const tools = new Map<string, Extract<ChatPart, { kind: "tool" }>>();
    const tracker = new DiffTracker(directory);
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
        if (!("sessionID" in event.data) || event.data.sessionID !== sessionId) continue;
        switch (event.type) {
          case "session.text.delta":
          case "session.text.ended": {
            const id = event.data.assistantMessageID + "/" + event.data.ordinal;
            if (event.type === "session.text.delta") emit({ type: "delta", sessionId, partId: id, delta: event.data.delta });
            else update({ id, kind: "text", text: event.data.text });
            break;
          }
          case "session.tool.input.started": {
            const { id, name } = event.data;
            const tool = { id, kind: "tool", tool: name, target: "", status: "running" } as const;
            tools.set(id, tool);
            update(tool);
            break;
          }
          case "session.tool.called": {
            const { id, input } = event.data;
            const tool = tools.get(id);
            if (tool) {
              tool.target = target(input, directory);
              update({ ...tool });
              if (fileTools.has(tool.tool) && tool.target) await tracker.capture(id, [tool.target]);
            }
            break;
          }
          case "session.tool.success":
          case "session.tool.failed": {
            const tool = tools.get(event.data.id);
            if (tool) {
              tool.status = event.type === "session.tool.success" ? "completed" : "error";
              tool.output = event.type === "session.tool.success" ? outputText(event.data.content) : event.data.error.message;
              if (tool.status === "completed" && fileTools.has(tool.tool)) {
                tool.diff = await tracker.finish(tool.id, tool.target, tool.output);
              }
              update({ ...tool });
            }
            break;
          }
          case "permission.asked": {
            const { id, action, resources, save } = event.data;
            if (action === "edit" && event.data.source?.id) await tracker.capture(event.data.source.id, resources);
            emit({ type: "permission", sessionId, permission: { id, action, resources, save } });
            break;
          }
          case "permission.replied":
            emit({ type: "permission-resolved", sessionId, id: event.data.requestID });
            break;
          case "session.execution.failed":
            error = userError(event.data.error);
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
      await this.client.session.switchModel({ sessionID: sessionId, model }, request());
      if (interrupted()) return { changes: await this.changes(sessionId), stopped: true };
      queued = true;
      await this.client.session.prompt({
        sessionID: sessionId, text,
        files: files.map(path => ({ uri: pathToFileURL(path).href, name: basename(path) }))
      }, request());
      if (interrupted()) {
        await this.stop(sessionId);
        return { changes: await this.changes(sessionId), stopped: true };
      }
      await stream;
      if (error) throw new Error(error);
      return { changes: mergeChanges(tracker.results(), await this.changes(sessionId)), stopped };
    } catch (failure) {
      if (queued) await this.stop(sessionId).catch(() => {});
      throw failure;
    } finally {
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
