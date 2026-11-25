import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { GlobalQuota, IpLimits } from "../src/index";
import { hashIp, issueToken } from "../src/token";
import { MemoryStorage } from "./workers-mock";

const origin = "https://vsemkod.ru";
const ip = "192.0.2.70";
const ua = "test-browser";
const secret = "unit-test-session";
const dummy = "1x0000000000000000000000000000000AA";
const messages = { messages: [{ role: "user", content: "Текст для модели" }] };

function request(path: string, { from = origin, method = "GET", body, token, headers = {}, address = ip, agent = ua }:
  { from?: string | null; method?: string; body?: object; token?: string; headers?: Record<string, string>; address?: string; agent?: string } = {}) {
  return new Request(`https://demo.example${path}`, { method, body: JSON.stringify(body), headers: {
    "User-Agent": agent, "CF-Connecting-IP": address,
    ...(from === null ? {} : { Origin: from }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  } });
}

function fixture(run = vi.fn()) {
  const stores = new Map<string, MemoryStorage>();
  const ips = new Map<string, IpLimits>();
  const quota = new GlobalQuota({ storage: new MemoryStorage() } as never, {});
  const env = {
    AI: { run }, AI_MODEL: "@cf/openai/gpt-oss-120b", AI_MODEL_NAME: "GPT‑OSS 120B", AI_BACKUP_MODEL: "@cf/zai-org/glm-4.7-flash",
    DEV: "0", UPSTREAM_MOCK: "0", TURNSTILE_SECRET: "test-secret", SESSION_SECRET: secret,
    EDGE_LIMIT: { limit: vi.fn(async (_key: { key: string }) => ({ success: true })) },
    IP_LIMITS: { getByName: vi.fn((hash: string) => {
      if (!ips.has(hash)) {
        const storage = new MemoryStorage();
        stores.set(hash, storage);
        ips.set(hash, new IpLimits({ storage } as never, {}));
      }
      return ips.get(hash)!;
    }) },
    GLOBAL_QUOTA: { getByName: () => quota },
  };
  const ctx = { waitUntil: (work: Promise<unknown>) => void work };
  return { env, stores, send: (input: Request) => worker.fetch(input, env as never, ctx as never) };
}

async function tokenFor(address = ip) {
  const now = Date.now();
  return (await issueToken(secret, await hashIp(address, secret, now), ua, now)).token;
}

async function events(response: Response) {
  expect(response.headers.get("Content-Type")).toMatch(/^text\/event-stream\b/);
  return (await response.text()).trim().split("\n\n").map((event) => JSON.parse(event.slice(6)));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Origin и CORS", () => {
  it.each([null, "null", "https://foreign.example", "https://vsemkod.ru.evil.test", "http://localhost:5173"])("запрещает Origin=%s в проде", async (from) => {
    const response = await fixture().send(request("/status", { from }));
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("добавляет localhost только в DEV и принимает оба домена сайта", async () => {
    const { env, send } = fixture();
    env.DEV = "1";
    for (const from of [origin, "https://www.vsemkod.ru", "http://localhost:5173"]) {
      const response = await send(request("/status", { from }));
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(from);
      expect(await response.json()).toEqual({ open: true, model: { id: env.AI_MODEL, name: env.AI_MODEL_NAME } });
    }
    expect((await send(request("/status", { from: "http://localhost.attacker.test:5173" }))).status).toBe(403);
  });

  it("разрешает только нужные методу и маршруту заголовки preflight", async () => {
    const { send } = fixture();
    const cors = (path: string, method: string, headers: string) => send(request(path, { method: "OPTIONS", headers: {
      "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers,
    } }));
    const chat = await cors("/chat", "POST", "Authorization, Content-Type");
    expect(chat.status).toBe(204);
    expect(chat.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(chat.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(chat.headers.get("Access-Control-Allow-Headers")).toBe("authorization, content-type");
    expect(chat.headers.get("Vary")).toBe("Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    expect((await cors("/chat", "DELETE", "authorization")).status).toBe(403);
    expect((await cors("/chat", "POST", "authorization,x-extra")).status).toBe(403);
    expect((await cors("/session", "POST", "authorization")).status).toBe(403);
    expect((await cors("/session", "POST", "content-type")).status).toBe(204);
  });
});

it("/session передаёт remoteip в Siteverify, проверяет hostname и принимает dummy только на localhost в DEV", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const verify = vi.fn(async () => Response.json({ success: true, hostname: "foreign.example" }));
  vi.stubGlobal("fetch", verify);
  const { env, send } = fixture();
  const session = (from = origin) => send(request("/session", { from, method: "POST", body: { turnstile: "captcha" } }));
  expect(await (await session()).json()).toEqual({ error: { code: "turnstile", message: expect.any(String) } });
  expect(verify).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", expect.objectContaining({
    method: "POST", redirect: "manual", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: "captcha", remoteip: ip }),
  }));
  verify.mockImplementation(async () => Response.json({ success: true, hostname: "vsemkod.ru" }));
  const response = await session();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ token: expect.any(String), expiresAt: expect.any(Number), remaining: 30 });
  expect((await send(request("/session", { method: "POST", body: { turnstile: "captcha", model: "x" } }))).status).toBe(400);

  env.TURNSTILE_SECRET = dummy;
  verify.mockClear();
  expect((await session()).status).toBe(403);
  expect(verify).not.toHaveBeenCalled();
  env.DEV = "1";
  verify.mockImplementation(async () => Response.json({ success: true, hostname: "example.com" }));
  expect((await session()).status).toBe(403);
  expect((await session("http://localhost:5173")).status).toBe(200);
});

it("/chat отдаёт SSE при 401 auth и 400 bad_request, не вызывая модель", async () => {
  const run = vi.fn();
  const { send } = fixture(run);
  const token = await tokenFor();
  for (const options of [{}, { token, agent: "other-browser" }, { token, address: "192.0.2.100" }]) {
    const response = await send(request("/chat", { method: "POST", body: messages, ...options }));
    expect(response.status).toBe(401);
    expect(await events(response)).toEqual([{ t: "error", code: "auth", message: expect.any(String) }]);
  }
  const response = await send(request("/chat", { method: "POST", token, body: { ...messages, tools: [] } }));
  expect(response.status).toBe(400);
  expect(await events(response)).toEqual([{ t: "error", code: "bad_request", message: expect.any(String) }]);
  expect(run).not.toHaveBeenCalled();
});

it("дешёвый лимит срабатывает раньше Durable Object и Siteverify", async () => {
  const { env, send } = fixture();
  env.EDGE_LIMIT.limit.mockResolvedValue({ success: false });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await send(request("/session", { method: "POST", body: { turnstile: "captcha" } }))).status).toBe(429);
  const response = await send(request("/chat", { method: "POST", token: await tokenFor(), body: messages }));
  expect(await events(response)).toEqual([{ t: "error", code: "limit", message: expect.any(String) }]);
  expect(fetch).not.toHaveBeenCalled();
  expect(env.IP_LIMITS.getByName).not.toHaveBeenCalled();
  for (const [call] of env.EDGE_LIMIT.limit.mock.calls) expect(call.key).not.toContain(ip);
});

it("закрывает /status и следующие запросы /chat после общего исчерпания квоты", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const run = vi.fn().mockRejectedValue(new Error("AiError: 3036: daily free allocation"));
  const { send } = fixture(run);
  const token = await tokenFor();
  const chat = () => send(request("/chat", { method: "POST", token, body: messages }));
  const closed = [{ t: "error", code: "closed", message: expect.any(String) }];
  expect(await events(await chat())).toEqual(closed);
  expect(await (await send(request("/status"))).json()).toMatchObject({ open: false });
  expect(await events(await chat())).toEqual(closed);
  expect(run).toHaveBeenCalledTimes(2);
});

it("стримит для 24 разных IP одновременно, блокируя второй стрим на том же IP", async () => {
  const gate = Promise.withResolvers<void>();
  const run = vi.fn(async () => {
    await gate.promise;
    return new Response('data: {"choices":[{"delta":{"content":"Ответ"}}]}\n\ndata: [DONE]\n\n').body;
  });
  const { send } = fixture(run);
  const chat = async (address: string) => send(request("/chat", { method: "POST", address, token: await tokenFor(address), body: messages }));
  const responses = await Promise.all(Array.from({ length: 24 }, (_, index) => chat(`192.0.2.${index + 1}`)));
  expect(run).toHaveBeenCalledTimes(24);
  expect(await events(await chat("192.0.2.1"))).toEqual([{ t: "error", code: "busy", message: expect.any(String) }]);
  gate.resolve();
  const allEvents = await Promise.all(responses.map(events));
  expect(allEvents).toEqual(Array(24).fill([{ t: "delta", v: "Ответ" }, { t: "done", remaining: 29 }]));
  expect((await events(await chat("192.0.2.1"))).at(-1)).toEqual({ t: "done", remaining: 28 });
});

it("логирует только коды и хранит только лимиты, даже если апстрим вернул текст запроса и ответа в ошибке", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  const prompt = "private-prompt-marker";
  const answer = "private-answer-marker";
  const body = { messages: [{ role: "user", content: prompt }] };
  const run = vi.fn().mockRejectedValue({ status: 503, message: `${prompt} ${answer} ${ip}` });
  const { send, stores } = fixture(run);
  const response = await send(request("/chat", { method: "POST", token: await tokenFor(), body }));
  expect(await events(response)).toEqual([{ t: "error", code: "upstream", message: expect.any(String) }]);
  expect(logs.flatMap((log) => log.mock.calls)).toEqual([["upstream_5xx"], ["upstream_5xx"]]);
  const state = [...stores].flatMap(([key, store]) => [[key, [...store.values]]]);
  expect(state.filter(([, values]) => (values as unknown[]).length)).toEqual([
    [expect.stringMatching(/^[\w-]{43}$/), [["counts", { sessions: 0, messages: 1, recent: [expect.any(Number)] }]]],
  ]);
  expect(JSON.stringify(state)).not.toMatch(new RegExp(`${prompt}|${answer}|${ip.replaceAll(".", "\\.")}`));
});
