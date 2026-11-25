import { type ChatEvent, chatErrorEvent, chatMessages, jsonError, originIsAllowed, readJson, record, sseEvent, sseResponse } from "./protocol";
import { GlobalQuota, IpLimits, LEASE_MS } from "./limits";
import { DAY, hashIp, issueToken, utcDay, verifyToken } from "./token";
import { streamAnswer } from "./upstreams";

export { GlobalQuota, IpLimits };

interface Env {
  AI: Ai;
  AI_MODEL: string;
  AI_MODEL_NAME: string;
  AI_BACKUP_MODEL: string;
  ALLOWED_ORIGINS?: string;
  DEV?: string;
  UPSTREAM_MOCK?: string;
  TURNSTILE_SECRET?: string;
  SESSION_SECRET?: string;
  FALLBACK_API_KEY?: string;
  FALLBACK_BASE_URL?: string;
  FALLBACK_MODEL?: string;
  IP_LIMITS: DurableObjectNamespace<IpLimits>;
  GLOBAL_QUOTA: DurableObjectNamespace<GlobalQuota>;
  EDGE_LIMIT?: RateLimit;
}

const DEFAULT_ORIGINS = "https://vsemkod.ru,https://www.vsemkod.ru";
const TEST_TURNSTILE_KEY = "1x0000000000000000000000000000000AA";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function route(path: string) {
  if (path === "/status") return { method: "GET", headers: [] };
  if (path === "/session") return { method: "POST", headers: ["content-type"] };
  if (path === "/chat") return { method: "POST", headers: ["authorization", "content-type"] };
}

function preflight(request: Request, target: NonNullable<ReturnType<typeof route>>): Response {
  const method = request.headers.get("Access-Control-Request-Method");
  const requested = request.headers.get("Access-Control-Request-Headers")?.toLowerCase().split(",").map((h) => h.trim()) ?? [];
  if (method !== target.method || requested.some((header) => !target.headers.includes(header))) {
    return jsonError("forbidden", 403);
  }
  const headers = new Headers({ "Access-Control-Allow-Methods": target.method, "Access-Control-Max-Age": "600" });
  if (target.headers.length) headers.set("Access-Control-Allow-Headers", target.headers.join(", "));
  return new Response(null, { status: 204, headers });
}

function connectingIp(request: Request, env: Env): string | null {
  return request.headers.get("CF-Connecting-IP") || (env.DEV === "1" ? "127.0.0.1" : null);
}

function turnstileHost(hostname: unknown, origin: string, allowed: string[], env: Env): boolean {
  const local = env.DEV === "1" && new URL(origin).hostname === "localhost";
  // Siteverify reports example.com with Cloudflare's public success key.
  if (env.TURNSTILE_SECRET === TEST_TURNSTILE_KEY) return local && hostname === "example.com";
  if (local && hostname === "localhost") return true;
  return allowed.some((candidate) => originIsAllowed(candidate, allowed, env.DEV === "1") && new URL(candidate).hostname === hostname);
}

async function checkTurnstile(token: string, ip: string, origin: string, allowed: string[], env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || (env.TURNSTILE_SECRET === TEST_TURNSTILE_KEY && env.DEV !== "1")) return false;
  try {
    const response = await fetch(SITEVERIFY, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.warn("turnstile_http");
      return false;
    }
    const result = record(await readJson(response, 8192));
    if (result?.success !== true) {
      console.warn("turnstile_fail");
      return false;
    }
    if (turnstileHost(result.hostname, origin, allowed, env)) return true;
    console.warn("turnstile_hostname");
    return false;
  } catch {
    console.warn("turnstile_network");
    return false;
  }
}

async function edgeAllows(env: Env, path: string, ipHash: string): Promise<boolean> {
  return !env.EDGE_LIMIT || (await env.EDGE_LIMIT.limit({ key: `${path}:${ipHash}` })).success;
}

async function createSession(request: Request, origin: string, allowed: string[], env: Env): Promise<Response> {
  const ip = connectingIp(request, env);
  if (!ip || !env.SESSION_SECRET || !env.TURNSTILE_SECRET) return jsonError("upstream", 503);
  const body = record(await readJson(request, 16_384));
  const token = body?.turnstile;
  if (!body || Object.keys(body).length !== 1 || typeof token !== "string" || !token || token.length > 2048) {
    return jsonError("bad_request", 400);
  }
  if (!(await edgeAllows(env, "session", await hashIp(ip, env.SESSION_SECRET, Date.now())))) return jsonError("limit", 429);
  if (!(await checkTurnstile(token, ip, origin, allowed, env))) {
    return jsonError("turnstile", 403);
  }

  const now = Date.now();
  const ipHash = await hashIp(ip, env.SESSION_SECRET, now);
  const result = await env.IP_LIMITS.getByName(ipHash).session(utcDay(now));
  if (result.code) return jsonError(result.code, 429);
  const session = await issueToken(env.SESSION_SECRET, ipHash, request.headers.get("User-Agent") ?? "", now);
  return Response.json({ ...session, remaining: result.remaining });
}

function chatError(code: Parameters<typeof chatErrorEvent>[0], status = 200): Response {
  return sseResponse(sseEvent(chatErrorEvent(code)), status);
}

async function chat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ip = connectingIp(request, env);
  const secret = env.SESSION_SECRET;
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
  const userAgent = request.headers.get("User-Agent") ?? "";
  if (!ip || !secret || !bearer || !(await verifyToken(bearer, secret, ip, userAgent, Date.now()))) return chatError("auth", 401);

  const messages = chatMessages(await readJson(request, 131_072));
  if (!messages) return chatError("bad_request", 400);
  const now = Date.now();
  const day = utcDay(now);
  const ipHash = await hashIp(ip, secret, now);
  if (!(await edgeAllows(env, "chat", ipHash))) return chatError("limit");
  const quota = env.GLOBAL_QUOTA.getByName("daily");
  if (!(await quota.isOpen())) return chatError("closed");

  const limits = env.IP_LIMITS.getByName(ipHash);
  const previous = now - day < LEASE_MS ? env.IP_LIMITS.getByName(await hashIp(ip, secret, now - DAY)) : undefined;
  const id = crypto.randomUUID();
  const release = async () => {
    try { await Promise.all([limits.release(id), previous?.release(id)]); } catch { console.warn("limits_release_fail"); }
  };

  let remaining: number;
  try {
    const guard = await previous?.holdPrevious(id);
    if (guard?.code) return chatError(guard.code);
    const started = await limits.start(day, id, guard?.recent ?? []);
    if (started.code) {
      if (previous) await release();
      return chatError(started.code);
    }
    remaining = started.remaining;
  } catch {
    await release();
    throw new Error("limits_start_fail");
  }

  const disconnect = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnect.signal]);
  return sseResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ChatEvent) => {
        if (!signal.aborted) controller.enqueue(sseEvent(event));
      };
      ctx.waitUntil((async () => {
        let final: ChatEvent = chatErrorEvent("upstream");
        try {
          const result = await streamAnswer(env, messages, signal, (v) => send({ t: "delta", v }));
          if (result === "done") final = { t: "done", remaining };
          if (result === "closed") {
            await quota.close(day);
            final = chatErrorEvent("closed");
          }
        } catch {
          console.warn("chat_fail");
        } finally {
          await release();
          if (!disconnect.signal.aborted) {
            send(final);
            controller.close();
          }
        }
      })());
    },
    cancel() { disconnect.abort(); },
  }));
}

async function handle(request: Request, env: Env, ctx: ExecutionContext, origin: string, allowed: string[]) {
  const path = new URL(request.url).pathname;
  const target = route(path);
  if (!target) return jsonError("not_found", 404);
  if (request.method === "OPTIONS") return preflight(request, target);
  if (request.method !== target.method) {
    const response = jsonError("method", 405);
    response.headers.set("Allow", `${target.method}, OPTIONS`);
    return response;
  }
  try {
    if (path === "/status") {
      const open = await env.GLOBAL_QUOTA.getByName("daily").isOpen();
      return Response.json({ open, model: { id: env.AI_MODEL, name: env.AI_MODEL_NAME } });
    }
    if (path === "/session") return await createSession(request, origin, allowed, env);
    return await chat(request, env, ctx);
  } catch {
    console.warn("worker_fail");
    return path === "/chat" ? chatError("upstream", 503) : jsonError("upstream", 503);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") ?? "";
    const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((value) => value.trim());
    const permitted = originIsAllowed(origin, allowed, env.DEV === "1");
    const response = permitted ? await handle(request, env, ctx, origin, allowed) : jsonError("forbidden", 403);
    if (permitted) response.headers.set("Access-Control-Allow-Origin", origin);
    if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
    response.headers.set("Vary", request.method === "OPTIONS"
      ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" : "Origin");
    return response;
  },
} satisfies ExportedHandler<Env>;
