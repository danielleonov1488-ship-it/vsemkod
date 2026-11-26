import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { activeOffers, automaticModels, rankedModels } from "../../shared/catalog";
import type { ChatEvent, ModelSpeed, ReplySpeed, RouterStats } from "../../shared/api";
import type { Catalog, Limits } from "../../shared/catalog-schema";
import type { KeyId } from "../../shared/providers";
import type { ConnectService } from "../connect-service";
import { ProviderHealth } from "./health";
import { parseKeyCredits } from "./quotas";
import { readReplyUsage } from "./reply-usage";
import { CompletionStream, errorPrefix, responseChunks, sseFrames, writeChunk } from "./response-stream";
import { ProviderSlots } from "./slots";

type Route = Omit<Extract<ChatEvent, { type: "route" }>, "type">;
export const FREE_FIRST_BYTE_MS = 45_000;
type Completion = Record<string, unknown> & { model: string; messages: unknown[] };
type Candidate = {
  modelId: string;
  provider: { id: KeyId; name: string; baseUrl: string };
  upstreamId: string;
  limits?: Limits;
  needsKey: boolean;
};
type Started = (response: Response, averageMs: number) => void;

interface RouterOptions {
  catalog: () => Catalog;
  key: (id: KeyId) => string | undefined;
  personal?: ConnectService["personalRoutes"];
  customIds?: () => KeyId[];
  legacyModel?: (id: string) => string | undefined;
  health: ProviderHealth;
  auto?: () => boolean;
  firstByteMs?: number;
  stallMs?: number;
  waitBudgetMs?: number;
  slotWaitMs?: number;
  onActivity?: (sessionId: string) => void;
  onWait?: (event: Omit<Extract<ChatEvent, { type: "route-wait" }>, "type">) => void;
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
  private slots = new ProviderSlots();
  private noStreamOptions = new Set<KeyId>();
  private sticky = new Map<string, KeyId>();
  private lastRoutes = new Map<string, Candidate>();
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

  resetProvider(id: KeyId) {
    this.options.health.reset(id);
    this.slots.reset(id);
    this.noStreamOptions.delete(id);
  }

  stats(): RouterStats {
    this.refreshOpenRouter();
    return this.currentStats();
  }

  private currentStats() {
    const customIds = this.options.customIds?.() ?? this.options.personal?.().map(route => route.provider.id);
    return this.options.health.stats(this.options.catalog(), customIds);
  }

  private publishStats() {
    this.options.onStats?.(this.currentStats());
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
    const parentContext = typeof parent === "string" ? this.turns.get(parent) : undefined;
    const context = (sessionId ? this.turns.get(sessionId) : undefined) ?? parentContext;
    const activitySession = parentContext?.sessionId ?? context?.sessionId ?? sessionId;
    const activity = () => { if (activitySession) this.options.onActivity?.(activitySession); };
    if (context) context.error = undefined;
    try {
      const body = await readCompletion(req);
      if (context?.preferredModel && body.model === "relay") body.model = context.preferredModel;
      await this.complete(res, catalog, body, cancel.signal, activity, context?.sessionId ?? sessionId, context?.auto);
    } catch (error) {
      if (context && error instanceof RequestError) context.error = error.message;
      throw error;
    }
  }

  private candidates(catalog: Catalog, body: Completion, auto?: boolean) {
    const explicit = catalog.models.find(model => model.id === body.model);
    const personal = explicit || body.model === "auto" ? undefined : this.options.personal?.().find(route => route.model.id === body.model);
    if (personal) {
      const candidate: Candidate = {
        modelId: personal.model.id, provider: personal.provider, upstreamId: personal.upstreamId, needsKey: true
      };
      return { groups: [[candidate]], explicit, personal: true };
    }
    if (!explicit && body.model !== "auto") throw new RequestError(404, "Модель недоступна. Выберите её заново в списке моделей.");
    const alternatives = automaticModels(catalog).filter(model => model.id !== explicit?.id);
    const models = explicit ? [explicit, ...((auto ?? this.options.auto?.() ?? false) ? alternatives : [])] : alternatives;
    const requiresTools = Array.isArray(body.tools) && body.tools.length > 0;
    const groups = models.map(model => activeOffers(catalog, model.id)
      .filter(({ offer }) => offer.free === true && (!requiresTools || offer.supportsTools))
      .map(({ provider, offer }): Candidate => ({
        modelId: model.id, provider, upstreamId: offer.providerModelId, limits: provider.freeLimits,
        needsKey: provider.auth.type !== "none"
      })));
    return { groups, explicit, personal: false };
  }

  private preferred(candidates: Candidate[], sessionId?: string) {
    const health = this.options.health;
    const first = candidates[0];
    const sticky = first && sessionId ? this.sticky.get(sessionId + "/" + first.modelId) : undefined;
    return candidates.toSorted((a, b) => Number(b.provider.id === sticky) - Number(a.provider.id === sticky) ||
      health.routeFailures(a.provider.id, a.upstreamId) - health.routeFailures(b.provider.id, b.upstreamId) ||
      health.routeLatency(a.provider.id, a.upstreamId, a.modelId) - health.routeLatency(b.provider.id, b.upstreamId, b.modelId));
  }

  private async complete(res: ServerResponse, catalog: Catalog, body: Completion, signal: AbortSignal,
    activity: () => void, sessionId?: string, auto?: boolean) {
    if (/^[^:]+:[a-f0-9]{32}$/.test(body.model)) body.model = this.options.legacyModel?.(body.model) ?? body.model;
    const { groups, explicit, personal } = this.candidates(catalog, body, auto);
    const health = this.options.health;
    const stream = new CompletionStream();
    const blocked = new Set<string>();
    const limited = new Set<string>();
    const keyFor = ({ provider, needsKey }: Candidate) => needsKey ? this.options.key(provider.id) : undefined;
    const routeKey = ({ provider, upstreamId }: Candidate) => provider.id + "/" + upstreamId;
    let first: Candidate | undefined;
    let current: Candidate | undefined;
    let switches = 0;
    let rejection: RequestError | undefined;
    let timedOut = false;
    let busy = false;
    let exhausted = false;
    const reportExhausted = () => {
      if (sessionId && !exhausted && explicit && first?.modelId === explicit.id) {
        this.options.onExhausted?.({ type: "route-exhausted", sessionId, modelId: explicit.id, providerId: first.provider.id });
        exhausted = true;
      }
    };
    const waitBudget = this.options.waitBudgetMs ?? 180_000;
    let retryUntil: number | undefined;
    let usage: ReturnType<typeof readReplyUsage> | undefined;
    const started = performance.now();
    const speed = (live: boolean) => {
      const reply = usage?.speed(live);
      if (reply && current && sessionId) this.reportSpeed(sessionId, current.modelId, current.provider.id, reply, live);
    };
    const live = sessionId && setInterval(() => speed(true), 1000);
    try {
      for (;;) {
        const paused = new Map<string, Candidate>();
        for (const candidates of groups) {
          for (const candidate of this.preferred(candidates, sessionId)) {
            if (signal.aborted) return;
            const id = routeKey(candidate);
            const key = keyFor(candidate);
            if (blocked.has(id) || candidate.needsKey && !key) continue;
            const { provider, modelId, upstreamId } = candidate;
            first ??= candidate;
            const pause = health.routePause(provider.id, upstreamId);
            if (pause.remaining > 0) {
              paused.set(id, candidate);
              if (pause.limited) limited.add(id);
              continue;
            }

            activity();
            const slot = await this.slots.acquire(provider.id, candidate.limits?.concurrent, this.options.slotWaitMs ?? 15_000, signal);
            if (!slot) { blocked.add(id); continue; }
            const continuation = current !== undefined;
            try {
              if (keyFor(candidate) !== key || health.routePause(provider.id, upstreamId).remaining > 0) {
                paused.set(id, candidate);
                continue;
              }
              const markStarted: Started = (response, averageMs) => {
                const previous = current ?? (body.model === "auto" && sessionId ? this.lastRoutes.get(sessionId) ?? first : first);
                const fallback = previous && (previous.modelId !== modelId || previous.provider.id !== provider.id);
                if (!continuation) {
                  res.writeHead(response.status, {
                    "content-type": response.headers.get("content-type") ?? (body.stream === true ? "text/event-stream" : "application/json"),
                    "cache-control": "no-store", "x-vsemkod-model": modelId,
                    ...(fallback && previous.modelId !== modelId ? { "x-vsemkod-fallback-from": previous.modelId } : {})
                  });
                } else {
                  switches++;
                  activity();
                }
                current = candidate;
                if (sessionId) {
                  this.sticky.set(sessionId + "/" + modelId, provider.id);
                  this.lastRoutes.set(sessionId, candidate);
                  this.options.onRoute?.({
                    sessionId, modelId, providerId: provider.id, averageMs,
                    previousModelId: fallback || continuation ? previous?.modelId : undefined,
                    previousProviderId: fallback || continuation ? previous?.provider.id : undefined,
                    reason: continuation ? "unavailable" : fallback ? limited.has(routeKey(previous)) ? "quota" : "unavailable" : undefined,
                    midStream: continuation || undefined
                  });
                }
              };
              if (modelId !== explicit?.id) reportExhausted();
              const result = await this.attempt(res, candidate, body, key, stream, signal, slot, markStarted,
                (isSse, chunk) => {
                  usage ??= readReplyUsage(isSse, started);
                  usage.push(chunk);
                }, () => usage?.nextStream(), continuation, personal);
              if (result === undefined) {
                res.end();
                const cachePercent = usage?.finish();
                if (sessionId) this.options.onReplyCache?.(sessionId, cachePercent);
                speed(false);
                return;
              }
              if (result === "aborted") return;
              if (result instanceof RequestError) {
                if (personal || ![401, 403, 404].includes(result.status)) throw result;
                rejection ??= result;
              } else if (result === "quota") limited.add(id);
              else if (result === "busy") busy = true;
              else if (result === "timeout") timedOut = true;
              if (health.routePause(provider.id, upstreamId).remaining > 0) paused.set(id, candidate);
              else blocked.add(id);
              if (current && (personal || stream.tools || stream.finished || switches >= 3)) {
                throw new RequestError(502, "Поток ответа оборвался.");
              }
            } finally { slot.release(); }
          }
        }

        if (personal || waitBudget <= 0 || signal.aborted) break;
        retryUntil ??= performance.now() + waitBudget;
        const remainingBudget = retryUntil - performance.now();
        if (remainingBudget <= 0) break;
        const next = [...paused.values()].filter(candidate => !candidate.needsKey || keyFor(candidate))
          .map(({ provider, upstreamId }) => health.routePause(provider.id, upstreamId))
          .sort((a, b) => a.remaining - b.remaining)[0];
        if (!next || next.remaining > Math.min(remainingBudget, 90_000)) break;
        if (next.remaining > 0) await this.wait(next.until, next.remaining, activity, signal, sessionId);
      }
    } finally {
      if (live) clearInterval(live);
    }

    if (signal.aborted) return;
    reportExhausted();
    if (current) throw new RequestError(502, "Поток ответа оборвался.");
    if (limited.size) throw new RequestError(429, personal ? "Квота этой модели исчерпана. Повторите позже." : "Квота бесплатных моделей исчерпана. Повторите позже.");
    if (busy) throw new RequestError(429, "У провайдера слишком много одновременных запросов. Повторите позже.");
    if (timedOut) throw new RequestError(504, "Провайдер не ответил вовремя. Повторите запрос или выберите другую модель.");
    if (rejection) throw rejection;
    if (first) throw new RequestError(502, "Провайдеры не ответили. Проверьте соединение или повторите позже.");
    throw new RequestError(503, "Для этой модели сейчас нет доступной бесплатной раздачи.");
  }

  private async wait(until: number, ms: number, activity: () => void, signal: AbortSignal, sessionId?: string) {
    if (sessionId) this.options.onWait?.({ sessionId, until });
    activity();
    const pulse = setInterval(activity, 1000);
    try { await delay(ms, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
    finally {
      clearInterval(pulse);
      if (sessionId) this.options.onWait?.({ sessionId, until: null });
    }
  }

  private async attempt(res: ServerResponse, candidate: Candidate, body: Completion, key: string | undefined, stream: CompletionStream,
    signal: AbortSignal, slot: NonNullable<Awaited<ReturnType<ProviderSlots["acquire"]>>>, markStarted: Started,
    observe: (isStream: boolean, chunk: Uint8Array) => void, nextStream: () => void, continuation: boolean, personal: boolean) {
    const { provider, modelId, upstreamId, needsKey, limits } = candidate;
    const health = this.options.health;
    const currentKey = () => slot.isCurrent() && (!needsKey || this.options.key(provider.id) === key);
    health.request(provider.id, Boolean(limits?.rph || limits?.rpd), upstreamId);
    const started = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.options.firstByteMs ?? (personal ? 35_000 : FREE_FIRST_BYTE_MS));
    const stallMs = this.options.stallMs ?? (personal ? 90_000 : 60_000);
    const upstream: Completion = { ...body, model: upstreamId };
    if (continuation && stream.text) upstream.messages = [...body.messages, { role: "assistant", content: stream.text },
      { role: "user", content: "Продолжи свой предыдущий ответ ровно с места, где он оборвался. Не повторяй уже написанное и ничего не объясняй." }];
    if (body.stream === true) {
      if (this.noStreamOptions.has(provider.id)) delete upstream.stream_options;
      else upstream.stream_options ??= { include_usage: true };
    }
    const forward = () => fetch(provider.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, deadline.signal]),
      headers: {
        "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json",
        ...(key ? { authorization: "Bearer " + key } : {})
      },
      body: JSON.stringify(upstream)
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let waitingForFirst = true;
    try {
      let response = await forward();
      if (response.status === 400 && upstream.stream_options !== undefined &&
          (await errorPrefix(response)).toLowerCase().includes("stream_options")) {
        if (currentKey()) this.noStreamOptions.add(provider.id);
        delete upstream.stream_options;
        response = await forward();
      }
      if (currentKey()) {
        health.response(provider.id, response.headers);
        this.publishStats();
      }
      if (provider.id === "openrouter") this.refreshOpenRouter();
      if (!response.ok) {
        const status = response.status;
        const others = status === 429 ? slot.otherRequests() : 0;
        const account = status === 402 || status === 429 &&
          /insufficient|credits|balance|daily|per day|quota exceeded|limit reached/i.test(await errorPrefix(response));
        await response.body?.cancel().catch(() => {});
        const rejected = status === 401 || status === 403;
        const concurrent = status === 429 && !account && others > 0;
        if (signal.aborted) return "aborted";
        if (currentKey()) {
          if (concurrent) slot.learn(others);
          health.error(provider.id, upstreamId,
            rejected ? "rejected" : account ? "account" : concurrent ? "concurrent" : status === 429 ? "quota" :
            status === 408 || status >= 500 ? "unavailable" : undefined, response.headers.get("retry-after"));
        }
        if (concurrent) return "busy";
        if (status === 402 || status === 429) return "quota";
        if (status === 408 || status === 504) return "timeout";
        if (status >= 500) return "unavailable";
        return new RequestError(status, rejected ? provider.name + " отклонил доступ к модели." :
          provider.name + " отклонил запрос (HTTP " + status + ").");
      }
      if (!response.body) throw new Error("Пустой ответ.");
      reader = response.body.getReader();
      const first = await reader.read();
      if (first.done) throw new Error("Пустой ответ.");
      clearTimeout(timer);
      waitingForFirst = false;
      const elapsed = performance.now() - started;
      const averageMs = currentKey() ? health.firstByte(provider.id, modelId, elapsed, upstreamId) : elapsed;
      const chunks = responseChunks(reader, first.value, deadline, stallMs);
      const contentType = response.headers.get("content-type");
      const isSse = body.stream === true && (!contentType || contentType.includes("text/event-stream"));
      if (isSse) {
        let opened = false;
        const restart = continuation && !stream.text;
        for await (const frame of sseFrames(chunks)) {
          const output = stream.event(frame, continuation);
          if (!output) continue;
          if (!opened) {
            markStarted(response, averageMs);
            if (continuation) nextStream();
            if (restart) {
              const delta = { reasoning_content: "\n\n— Источник оборвал ответ, продолжаю через " + provider.name + " —\n\n" };
              await writeChunk(res, "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n", signal);
            }
            opened = true;
          }
          observe(true, Buffer.from(output));
          await writeChunk(res, output, signal);
          if (stream.done) break;
        }
        if (!stream.finished && !stream.done) throw new Error("Поток ответа оборвался.");
      } else {
        if (continuation) throw new Error("Источник не вернул поток SSE.");
        const buffers: Uint8Array[] = [];
        for await (const chunk of chunks) buffers.push(chunk);
        const result = Buffer.concat(buffers);
        observe(false, result);
        markStarted(response, averageMs);
        if (!res.write(result)) await once(res, "drain", { signal });
      }
      if (currentKey()) health.success(provider.id, upstreamId);
    } catch {
      if (signal.aborted) return "aborted";
      if (currentKey()) health.error(provider.id, upstreamId, "unavailable");
      return waitingForFirst && deadline.signal.aborted ? "timeout" : "unavailable";
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
      this.publishStats();
    }
  }
}
