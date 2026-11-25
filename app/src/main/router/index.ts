import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { activeOffers, rankedModels } from "../../shared/catalog";
import type { Catalog, ProviderId } from "../../shared/catalog-schema";
import { ProviderHealth } from "./health";

type Route = { sessionId: string; modelId: string; providerId: ProviderId; previousModelId?: string };
type Completion = Record<string, unknown> & { model: string; messages: unknown[] };

interface RouterOptions {
  catalog: () => Catalog;
  key: (id: ProviderId) => string | undefined;
  health: ProviderHealth;
  auto?: () => boolean;
  firstByteMs?: number;
  onRoute?: (event: Route) => void;
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
  private context?: { sessionId: string; auto: boolean };
  private sticky = new Map<string, ProviderId>();
  private lastModels = new Map<string, string>();
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

  setTurn(context?: { sessionId: string; auto: boolean }): void {
    this.context = context;
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
        data: [{ id: "auto", vendor: "vsemkod" }, ...rankedModels(catalog)].map(model => ({
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
    await this.complete(req, res, catalog, await readCompletion(req), cancel.signal);
  }

  private async complete(req: IncomingMessage, res: ServerResponse, catalog: Catalog, body: Completion, signal: AbortSignal) {
    const models = rankedModels(catalog);
    const explicit = models.find(model => model.id === body.model);
    if (!explicit && body.model !== "auto") throw new RequestError(404, "Модель отсутствует в каталоге.");
    const header = req.headers["x-vsemkod-session"];
    const sessionId = this.context?.sessionId ?? (typeof header === "string" ? header.slice(0, 200) : undefined);
    const allowFallback = !explicit || (this.context?.auto ?? this.options.auto?.() ?? false);
    const alternatives = models.filter(model => model.tier !== "basic" && model.id !== explicit?.id);
    const ordered = explicit ? [explicit, ...(allowFallback ? alternatives : [])] : alternatives;
    const health = this.options.health;
    const requiresTools = Array.isArray(body.tools) && body.tools.length > 0;
    let rateLimited = false;
    let attempted = false;
    let cooling = false;

    for (const model of ordered) {
      const stickyKey = sessionId && sessionId + "/" + model.id;
      const sticky = stickyKey ? this.sticky.get(stickyKey) : undefined;
      const candidates = activeOffers(catalog, model.id)
        .filter(({ offer }) => !requiresTools || offer.supportsTools)
        .sort((a, b) => Number(b.provider.id === sticky) - Number(a.provider.id === sticky) ||
          health.failures(a.provider.id) - health.failures(b.provider.id));

      for (const { offer, provider } of candidates) {
        if (signal.aborted) return;
        const key = provider.auth.type === "none" ? undefined : this.options.key(provider.id);
        if (provider.auth.type !== "none" && !key) continue;
        if (!health.ready(provider.id)) {
          cooling = true;
          rateLimited ||= health.limited(provider.id);
          continue;
        }
        attempted = true;
        health.request(provider.id);
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), this.options.firstByteMs ?? 35_000);
        let response: Response;
        let reader: ReadableStreamDefaultReader<Uint8Array>;
        let first: ReadableStreamReadResult<Uint8Array>;
        try {
          response = await fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              accept: body.stream ? "text/event-stream" : "application/json",
              ...(key ? { authorization: "Bearer " + key } : {})
            },
            body: JSON.stringify({ ...body, model: offer.providerModelId }),
            signal: AbortSignal.any([signal, deadline.signal])
          });
          if (response.status === 429 || response.status >= 500) {
            rateLimited ||= response.status === 429;
            health.error(provider.id, response.status === 429 ? "quota" : "unavailable", response.headers.get("retry-after"));
            void response.body?.cancel().catch(() => {});
            continue;
          }
          if (!response.ok) {
            health.error(provider.id);
            void response.body?.cancel().catch(() => {});
            const message = response.status === 401 || response.status === 403
              ? provider.name + " отклонил доступ к модели."
              : provider.name + " отклонил запрос (HTTP " + response.status + ").";
            throw new RequestError(response.status, message);
          }
          if (!response.body) throw new Error("Пустой ответ.");
          reader = response.body.getReader();
          first = await reader.read();
          if (first.done) throw new Error("Пустой ответ.");
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof RequestError) throw error;
          health.error(provider.id, "unavailable");
          continue;
        } finally {
          clearTimeout(timer);
        }

        const previousModelId = explicit?.id ?? (sessionId ? this.lastModels.get(sessionId) : undefined);
        const switched = previousModelId !== undefined && previousModelId !== model.id;
        if (stickyKey) this.sticky.set(stickyKey, provider.id);
        if (sessionId) {
          this.lastModels.set(sessionId, model.id);
          this.options.onRoute?.({ sessionId, modelId: model.id, providerId: provider.id, previousModelId: switched ? previousModelId : undefined });
        }
        res.writeHead(response.status, {
          "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
          "x-vsemkod-model": model.id,
          ...(switched ? { "x-vsemkod-fallback-from": previousModelId } : {})
        });
        try {
          const onStreamError = () => { if (!signal.aborted) health.error(provider.id); };
          await pipeline(Readable.from(readStream(reader, first.value, deadline, onStreamError)), res);
          health.success(provider.id);
        } catch { /* A started response cannot switch providers. */ }
        return;
      }
    }

    if (rateLimited) throw new RequestError(429, "Квота бесплатных моделей исчерпана. Повторите позже.");
    if (attempted || cooling) throw new RequestError(502, "Провайдеры не ответили. Проверьте соединение или повторите позже.");
    throw new RequestError(503, "Для этой модели сейчас нет доступной бесплатной раздачи.");
  }
}

async function* readStream(
  reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array,
  deadline: AbortController, onError: () => void
) {
  try {
    yield first;
    while (true) {
      const timer = setTimeout(() => deadline.abort(), 120_000);
      const next = await reader.read().finally(() => clearTimeout(timer));
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    onError();
    throw error;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
