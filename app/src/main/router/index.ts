import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { activeOffers, automaticModels, rankedModels } from "../../shared/catalog";
import type { ChatEvent, ModelSpeed, ReplySpeed, RouterStats } from "../../shared/api";
import type { Catalog } from "../../shared/catalog-schema";
import type { KeyId } from "../../shared/providers";
import type { ConnectService } from "../connect-service";
import { ProviderHealth } from "./health";
import { parseKeyCredits } from "./quotas";
import { readReplyUsage } from "./reply-usage";

type Route = Omit<Extract<ChatEvent, { type: "route" }>, "type">;
export const FREE_FIRST_BYTE_MS = 45_000;
type Completion = Record<string, unknown> & { model: string; messages: unknown[] };

interface RouterOptions {
  catalog: () => Catalog;
  key: (id: KeyId) => string | undefined;
  personal?: ConnectService["personalRoutes"];
  health: ProviderHealth;
  auto?: () => boolean;
  firstByteMs?: number;
  onRoute?: (event: Route) => void;
  onExhausted?: (event: Extract<ChatEvent, { type: "route-exhausted" }>) => void;
  onSpeed?: (event: Extract<ChatEvent, { type: "reply-speed" }>) => void;
  onReplyCache?: (sessionId: string, cachePercent?: number) => void;
  onStats?: (stats: RouterStats) => void;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readCompletion(req: IncomingMessage): Promise<Completion> {
  const limit = 20 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "Запрос превышает 20 МБ.");
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* Invalid JSON. */ }
  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    throw new RequestError(400, "Укажите модель и сообщения.");
  }
  return body;
}

export class Router {
  readonly token = randomBytes(32).toString("base64url");
  private endpoint?: string;
  private turns = new Map<string, { sessionId: string; auto: boolean; preferredModel?: string; error?: string }>();
  private noStreamOptions = new Set<KeyId>();
  private sticky = new Map<string, KeyId>();
  private lastRoutes = new Map<string, { modelId: string; providerId: KeyId }>();
  private server = createServer((req, res) => {
    void this.handle(req, res).catch((error: unknown) => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else json(res, error instanceof RequestError ? error.status : 500, {
        error: { message: error instanceof RequestError ? error.message : "Внутренняя ошибка маршрутизатора." }
      });
    });
  });

  constructor(private readonly options: RouterOptions) {}

  get baseUrl(): string {
    if (!this.endpoint) throw new Error("Маршрутизатор ещё не запущен.");
    return this.endpoint;
  }

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Не удалось запустить маршрутизатор.");
    this.endpoint = "http://127.0.0.1:" + address.port + "/v1";
  }

  async close(): Promise<void> {
    if (this.server.listening) {
      const closed = new Promise<void>((resolve, reject) =>
        this.server.close(error => error ? reject(error) : resolve()));
      this.server.closeAllConnections();
      await closed;
    }
    await this.options.health.flush();
  }

  setTurn(context: { sessionId: string; auto: boolean; preferredModel?: string }): void {
    this.turns.set(context.sessionId, context);
  }

  clearTurn(sessionId: string) {
    this.turns.delete(sessionId);
  }

  turnError(sessionId: string) {
    return this.turns.get(sessionId)?.error;
  }

  reportSpeed(sessionId: string, modelId: string, providerId: ModelSpeed["providerId"], speed: ReplySpeed, live = false) {
    const modelSpeed = live ? undefined : this.options.health.recordSpeed(modelId, providerId, speed.tokensPerSecond, { sessionId, speed });
    this.options.onSpeed?.({ type: "reply-speed", sessionId, speed, live, modelSpeed });
  }

  stats(): RouterStats {
    this.refreshOpenRouter();
    return this.options.health.stats(this.options.catalog());
  }

  private publishStats() {
    this.options.onStats?.(this.options.health.stats(this.options.catalog()));
  }

  private refreshOpenRouter() {
    const key = this.options.key("openrouter");
    if (!key || !this.options.health.beginCreditsCheck()) return;
    void fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: "Bearer " + key }, redirect: "error", signal: AbortSignal.timeout(8000)
    }).then(async response => {
      if (!response.ok) { await response.body?.cancel(); return; }
      const credits = parseKeyCredits(await response.json());
      if (credits && this.options.key("openrouter") === key) {
        this.options.health.setCredits(credits);
        this.publishStats();
      }
    }).catch(() => { /* Keep the last credit reading during connection failures. */ });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from("Bearer " + this.token);
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(this.baseUrl).host ||
      actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new RequestError(401, "Требуется доступ к локальному маршрутизатору.");
    }
    const catalog = this.options.catalog();
    if (req.method === "GET" && req.url === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: [{ id: "auto", vendor: "vsemkod" }, ...rankedModels(catalog),
          ...(this.options.personal?.().map(({ model }) => ({ id: model.id, vendor: model.providerName })) ?? [])].map(model => ({
          id: model.id, object: "model", created: Math.floor(Date.parse(catalog.generatedAt) / 1000), owned_by: model.vendor
        }))
      });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      throw new RequestError(404, "Эндпоинт не найден.");
    }
    const cancel = new AbortController();
    res.once("close", () => cancel.abort());
    const header = req.headers["x-vsemkod-session"] ?? req.headers["x-opencode-session-id"] ?? req.headers["x-session-id"];
    const parent = req.headers["x-opencode-parent-session-id"];
    const sessionId = typeof header === "string" ? header.slice(0, 250) : undefined;
    const context = (sessionId ? this.turns.get(sessionId) : undefined) ??
      (typeof parent === "string" ? this.turns.get(parent) : undefined);
    if (context) context.error = undefined;
    try {
      const body = await readCompletion(req);
      if (context?.preferredModel && body.model === "relay") body.model = context.preferredModel;
      await this.complete(res, catalog, body, cancel.signal, context?.sessionId ?? sessionId, context?.auto);
    } catch (error) {
      if (context && error instanceof RequestError) context.error = error.message;
      throw error;
    }
  }

  private async complete(res: ServerResponse, catalog: Catalog, body: Completion, signal: AbortSignal,
    sessionId?: string, auto?: boolean) {
    const models = rankedModels(catalog);
    const explicit = models.find(model => model.id === body.model);
    const personal = this.options.personal?.().find(route => route.model.id === body.model);
    if (!explicit && !personal && body.model !== "auto") throw new RequestError(404, "Модель недоступна.");
    const allowFallback = !explicit || (auto ?? this.options.auto?.() ?? false);
    const alternatives = automaticModels(catalog).filter(model => model.id !== explicit?.id);
    const ordered = personal ? [personal.model] : explicit ? [explicit, ...(allowFallback ? alternatives : [])] : alternatives;
    const health = this.options.health;
    const requiresTools = Array.isArray(body.tools) && body.tools.length > 0;
    const rateLimited = new Set<string>();
    let firstAttempt: { modelId: string; providerId: KeyId } | undefined;
    let timedOut = false;
    let rejected: RequestError | undefined;
    let attempted = false;
    let cooling = false;

    for (const model of ordered) {
      const stickyKey = sessionId && sessionId + "/" + model.id;
      const sticky = stickyKey ? this.sticky.get(stickyKey) : undefined;
      const candidates = personal ? [{ provider: personal.provider, upstreamId: personal.upstreamId, needsKey: true }]
        : activeOffers(catalog, model.id)
        .filter(({ offer }) => !requiresTools || offer.supportsTools)
        .sort((a, b) => Number(b.provider.id === sticky) - Number(a.provider.id === sticky) ||
          health.failures(a.provider.id) - health.failures(b.provider.id))
        .map(({ provider, offer }) => ({ provider, upstreamId: offer.providerModelId, needsKey: provider.auth.type !== "none" }));

      for (const { provider, upstreamId, needsKey } of candidates) {
        if (signal.aborted) return;
        const key = needsKey ? this.options.key(provider.id) : undefined;
        if (needsKey && !key) continue;
        firstAttempt ??= { modelId: model.id, providerId: provider.id };
        const routeKey = model.id + "/" + provider.id;
        if (!health.ready(provider.id)) {
          cooling = true;
          if (health.limited(provider.id)) rateLimited.add(routeKey);
          continue;
        }
        attempted = true;
        const freeLimits = catalog.providers.find(entry => entry.id === provider.id)?.freeLimits;
        health.request(provider.id, Boolean(freeLimits?.rph || freeLimits?.rpd));
        const started = performance.now();
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), this.options.firstByteMs ?? (personal ? 35_000 : FREE_FIRST_BYTE_MS));
        let response: Response;
        let reader: ReadableStreamDefaultReader<Uint8Array>;
        let first: ReadableStreamReadResult<Uint8Array>;
        try {
          const upstream: Completion = { ...body, model: upstreamId };
          if (body.stream === true) {
            if (this.noStreamOptions.has(provider.id)) delete upstream.stream_options;
            else upstream.stream_options ??= { include_usage: true };
          }
          const forward = () => fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              accept: body.stream ? "text/event-stream" : "application/json",
              ...(key ? { authorization: "Bearer " + key } : {})
            },
            body: JSON.stringify(upstream),
            signal: AbortSignal.any([signal, deadline.signal])
          });
          response = await forward();
          if (response.status === 400 && upstream.stream_options !== undefined &&
              (await response.text()).toLowerCase().includes("stream_options")) {
            this.noStreamOptions.add(provider.id);
            delete upstream.stream_options;
            response = await forward();
          }
          if (!needsKey || this.options.key(provider.id) === key) {
            health.response(provider.id, response.headers);
            this.publishStats();
          }
          if (provider.id === "openrouter") this.refreshOpenRouter();
          const quota = response.status === 429 || response.status === 402;
          if (quota || response.status === 408 || response.status >= 500) {
            if (quota) rateLimited.add(routeKey);
            if (response.status === 408 || response.status === 504) timedOut = true;
            health.error(provider.id, quota ? "quota" : "unavailable", response.headers.get("retry-after"));
            void response.body?.cancel().catch(() => {});
            continue;
          }
          if (!response.ok) {
            health.error(provider.id);
            void response.body?.cancel().catch(() => {});
            const message = response.status === 401 || response.status === 403
              ? provider.name + " отклонил доступ к модели."
              : provider.name + " отклонил запрос (HTTP " + response.status + ").";
            const failure = new RequestError(response.status, message);
            if (personal || ![401, 403, 404].includes(response.status)) throw failure;
            rejected ??= failure;
            continue;
          }
          if (!response.body) throw new Error("Пустой ответ.");
          reader = response.body.getReader();
          first = await reader.read();
          if (first.done) throw new Error("Пустой ответ.");
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof RequestError) throw error;
          if (deadline.signal.aborted) timedOut = true;
          health.error(provider.id, "unavailable");
          this.publishStats();
          continue;
        } finally {
          clearTimeout(timer);
        }

        const averageMs = health.firstByte(provider.id, model.id, performance.now() - started);
        const previous = body.model === "auto" && sessionId ? this.lastRoutes.get(sessionId) ?? firstAttempt : firstAttempt;
        const fallback = previous && (previous.modelId !== model.id || previous.providerId !== provider.id);
        const switched = fallback && previous.modelId !== model.id;
        if (stickyKey) this.sticky.set(stickyKey, provider.id);
        if (sessionId) {
          this.lastRoutes.set(sessionId, { modelId: model.id, providerId: provider.id });
          this.options.onRoute?.({
            sessionId, modelId: model.id, providerId: provider.id, averageMs,
            previousModelId: fallback ? previous.modelId : undefined,
            previousProviderId: fallback ? previous.providerId : undefined,
            reason: fallback ? rateLimited.has(previous.modelId + "/" + previous.providerId) ? "quota" : "unavailable" : undefined
          });
        }
        res.writeHead(response.status, {
          "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
          "x-vsemkod-model": model.id,
          ...(switched ? { "x-vsemkod-fallback-from": previous.modelId } : {})
        });
        try {
          const onStreamError = () => { if (!signal.aborted) health.error(provider.id); };
          const usage = readReplyUsage(response.headers.get("content-type")?.includes("text/event-stream") ||
            body.stream === true && !response.headers.has("content-type"), started);
          const emitSpeed = (live: boolean) => {
            const speed = usage.speed(live);
            if (speed && sessionId) this.reportSpeed(sessionId, model.id, provider.id, speed, live);
          };
          const live = sessionId && setInterval(() => emitSpeed(true), 1000);
          const onEnd = () => {
            const cache = usage.finish();
            if (sessionId) this.options.onReplyCache?.(sessionId, cache);
            emitSpeed(false);
          };
          try { await pipeline(Readable.from(readStream(reader, first.value, deadline, onStreamError, usage.push, onEnd)), res); }
          finally { if (live) clearInterval(live); }
          health.success(provider.id);
        } catch { /* A started response cannot switch providers. */ }
        return;
      }
      if (sessionId && model.id === explicit?.id && firstAttempt?.modelId === model.id) {
        this.options.onExhausted?.({ type: "route-exhausted", sessionId, modelId: model.id, providerId: firstAttempt.providerId });
      }
    }

    if (rateLimited.size) throw new RequestError(429, personal ? "Квота этой модели исчерпана. Повторите позже." : "Квота бесплатных моделей исчерпана. Повторите позже.");
    if (timedOut) throw new RequestError(504, "Провайдер не ответил вовремя. Повторите запрос или выберите другую модель.");
    if (rejected) throw rejected;
    if (attempted || cooling) throw new RequestError(502, "Провайдеры не ответили. Проверьте соединение или повторите позже.");
    throw new RequestError(503, "Для этой модели сейчас нет доступной бесплатной раздачи.");
  }
}

async function* readStream(
  reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array,
  deadline: AbortController, onError: () => void, onChunk?: (chunk: Uint8Array) => void, onEnd?: () => void
) {
  try {
    onChunk?.(first);
    yield first;
    while (true) {
      const timer = setTimeout(() => deadline.abort(), 120_000);
      const next = await reader.read().finally(() => clearTimeout(timer));
      if (next.done) { onEnd?.(); return; }
      onChunk?.(next.value);
      yield next.value;
    }
  } catch (error) {
    onError();
    throw error;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
