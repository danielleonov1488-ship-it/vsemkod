import { createServer, get, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import bundled from "../resources/catalog.json";
import { catalogSchema, type Catalog, type Offer, type Provider } from "../src/shared/catalog-schema";
import { FREE_FIRST_BYTE_MS, Router } from "../src/main/router";
import { ProviderHealth } from "../src/main/router/health";

const sample = catalogSchema.parse(bundled);
const template = sample.offers.find(offer => offer.providerId === "kilo")!;
const model = (id: string, tier: "top" | "good" | "basic", rank: number) => ({
  ...sample.models[0], id, name: id, tier, rank
});
const provider = (id: Provider["id"], baseUrl: string, anonymous = true): Provider => ({
  ...sample.providers.find(provider => provider.id === id)!,
  id, baseUrl, auth: { type: anonymous ? "none" : "manual_key" }, clicksToConnect: id === "kilo" ? 0 : 1
});
const offer = (modelId: string, providerId: Provider["id"], patch: Partial<Offer> = {}): Offer => ({
  ...template, modelId, providerId, providerModelId: providerId + "-" + modelId, ...patch
});
const text = (res: ServerResponse, message = "ok") => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message }));
};

type Call = { body: Record<string, unknown>; auth?: string; path?: string };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function upstream(handler: (res: ServerResponse, call: Call) => void = res => text(res)) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { body: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization, path: req.url };
    calls.push(call);
    handler(res, call);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No mock listen address");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { url: "http://127.0.0.1:" + address.port + "/v1/", calls };
}

async function fixture(
  providers: Provider[], offers: Offer[], options: Partial<ConstructorParameters<typeof Router>[0]> = {},
  models = [model("first", "top", 10), model("second", "top", 20), model("third", "good", 1), model("basic", "basic", 0)]
) {
  const catalog: Catalog = { ...sample, providers, offers, models, candidates: [] };
  const router = new Router({ catalog: () => catalog, key: () => undefined, health: new ProviderHealth(), waitBudgetMs: 0, ...options });
  await router.start();
  cleanup.push(() => router.close());
  const headers = { authorization: "Bearer " + router.token, "content-type": "application/json" };
  const send = (model: string, patch: Record<string, unknown> = {}, session = "chat", signal?: AbortSignal) => fetch(router.baseUrl + "/chat/completions", {
    method: "POST", signal, headers: { ...headers, "x-vsemkod-session": session },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Тест" }], ...patch })
  });
  return { router, headers, send };
}

describe("Router", () => {
  it("routes a new provider ID and persists its health and quota", async () => {
    const server = await upstream();
    const data = await mkdtemp(join(tmpdir(), "vsemkod-k1-health-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const path = join(data, "usage.json");
    const health = new ProviderHealth(path);
    const id = "constructor";
    const dynamic = { ...provider("kilo", server.url, false), id, freeLimits: { rpd: 50 } };
    const route = offer("first", id, { limits: { rpd: 50 } });
    const { send } = await fixture([dynamic], [route], { key: keyId => keyId === id ? "fixture-key" : undefined, health });
    expect((await send("first")).status).toBe(200);
    expect(server.calls[0]).toMatchObject({ auth: "Bearer fixture-key", body: { model: "constructor-first" } });
    await health.flush();
    const restarted = new ProviderHealth(path);
    await restarted.load();
    const catalog = { ...sample, providers: [dynamic], offers: [route] };
    expect(restarted.stats(catalog)[id]).toMatchObject({ requests: { remaining: 49, limit: 50 }, ready: true });
    expect(restarted.latencies()[0]).toMatchObject({ providerId: id, modelId: "first" });
  });

  it("requests include_usage, retries unsupported providers, and remembers the result", async () => {
    const server = await upstream((res, call) => {
      if (call.body.stream_options) res.writeHead(400).end("Unsupported stream_options");
      else res.writeHead(200, { "content-type": "text/event-stream" }).end("data: [DONE]\n\n");
    });
    const { send } = await fixture([provider("kilo", server.url)], [offer("first", "kilo")]);
    for (const id of ["a", "b"]) expect(await (await send("first", { stream: true }, id)).text()).toContain("[DONE]");
    expect(server.calls.map(call => call.body.stream_options)).toEqual([{ include_usage: true }, undefined, undefined]);
  });

  it("isolates fallback policy and errors for simultaneous engine sessions", async () => {
    const firstProvider = await upstream(res => res.writeHead(404).end());
    const secondProvider = await upstream();
    const routes: string[] = [];
    const { router, headers } = await fixture([provider("kilo", firstProvider.url), provider("numes", secondProvider.url)],
      [offer("first", "kilo"), offer("second", "numes")], { onRoute: event => routes.push(event.sessionId) });
    router.setTurn({ sessionId: "chat-a", auto: false });
    router.setTurn({ sessionId: "chat-b", auto: true });
    const replies = await Promise.all(["chat-a", "chat-b"].map(id => fetch(router.baseUrl + "/chat/completions", {
      method: "POST", headers: { ...headers, "x-opencode-session-id": id }, body: JSON.stringify({ model: "first", messages: [] })
    })));
    expect(replies.map(reply => reply.status)).toEqual([404, 200]);
    expect(routes).toEqual(["chat-b"]);
    expect(router.turnError("chat-a")).toContain("404");
    router.clearTurn("chat-b");
    expect(router.turnError("chat-a")).toContain("404");
  });

  it("authenticates localhost clients and exposes canonical model IDs", async () => {
    const { router, headers } = await fixture([], []);
    const url = router.baseUrl + "/models";
    expect((await fetch(url)).status).toBe(401);
    const wrongHost = await new Promise(resolve => get(url, { headers: { ...headers, host: "example.org" } }, response => {
      response.resume();
      resolve(response.statusCode);
    }));
    expect(wrongHost).toBe(401);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((model: { id: string }) => model.id))
      .toEqual(["auto", "first", "second", "third", "basic"]);
  });

  it("skips expired, inactive, unconnected and tool-incompatible offers", async () => {
    const excluded = await upstream();
    const valid = await upstream();
    const { send } = await fixture([
      provider("kilo", excluded.url), provider("openrouter", excluded.url, false),
      provider("numes", excluded.url), provider("groq", excluded.url), provider("runcrate", valid.url, false)
    ], [
      offer("first", "kilo", { expiresAt: "2020-01-01T00:00:00Z" }),
      offer("first", "openrouter"), offer("first", "numes", { status: "degraded" }),
      offer("first", "groq", { supportsTools: false }), offer("first", "runcrate", { supportsTools: true })
    ], { key: id => id === "runcrate" ? "local-test-key" : undefined });
    const tools = [{ type: "function", function: { name: "write" } }];
    const response = await send("first", { tools, tool_choice: "required" });
    expect(response.status).toBe(200);
    expect(excluded.calls).toHaveLength(0);
    expect(valid.calls).toEqual([{
      path: "/v1/chat/completions", auth: "Bearer local-test-key",
      body: { model: "runcrate-first", messages: [{ role: "user", content: "Тест" }], tools, tool_choice: "required" }
    }]);
  });

  it("falls back within the model, honors Retry-After, and sticks per session", async () => {
    let time = 10_000;
    const primary = await upstream((res) => {
      if (time === 10_000) res.writeHead(429, { "retry-after": "10" }).end();
      else text(res);
    });
    const reserve = await upstream();
    const { send } = await fixture(
      [provider("kilo", primary.url), provider("numes", reserve.url)],
      [offer("first", "kilo"), offer("first", "numes"), offer("second", "kilo")],
      { health: new ProviderHealth(undefined, () => time) }
    );
    expect((await send("first")).status).toBe(200);
    time += 9000;
    expect((await send("first", {}, "new")).status).toBe(200);
    expect(primary.calls).toHaveLength(1);
    time += 2000;
    expect((await send("first")).status).toBe(200);
    expect(reserve.calls).toHaveLength(3);
    expect((await send("second", {}, "health-check")).status).toBe(200);
    expect((await send("first", {}, "another")).status).toBe(200);
    expect(primary.calls).toHaveLength(2);
    expect((await send("first")).status).toBe(200);
    expect(reserve.calls).toHaveLength(5);
  });

  it("emits a quota fallback to the next model and skips Kilo until Retry-After passes", async () => {
    let time = 5000;
    const health = new ProviderHealth(undefined, () => time);
    const primary = await upstream(res => {
      if (time < 15_000) res.writeHead(429, { "retry-after": "10" }).end("Daily quota exceeded");
      else text(res);
    });
    const reserve = await upstream();
    const routes: unknown[] = [];
    const { send } = await fixture(
      [provider("kilo", primary.url), provider("numes", reserve.url)],
      [offer("first", "kilo"), offer("second", "kilo"), offer("second", "numes")],
      { auto: () => true, onRoute: event => routes.push(event), health }
    );
    expect((await send("first")).headers.get("x-vsemkod-model")).toBe("second");
    expect(health.limited("kilo")).toBe(true);
    expect(routes[0]).toMatchObject({ reason: "quota", previousModelId: "first", previousProviderId: "kilo",
      modelId: "second", providerId: "numes", averageMs: expect.any(Number) });
    time += 9999;
    expect((await send("first", {}, "next")).headers.get("x-vsemkod-model")).toBe("second");
    expect(primary.calls).toHaveLength(1);
    time++;
    expect((await send("first")).headers.get("x-vsemkod-model")).toBe("first");
    expect(primary.calls).toHaveLength(2);
  });

  it("cools down network errors exponentially and accepts Retry-After dates", () => {
    let time = 60_000;
    const health = new ProviderHealth(undefined, () => time);
    health.error("kilo", "first", "unavailable");
    time += 14_999;
    expect(health.ready("kilo")).toBe(false);
    time++;
    expect(health.ready("kilo")).toBe(true);
    health.error("kilo", "first", "unavailable");
    time += 29_999;
    expect(health.ready("kilo")).toBe(false);
    time++;
    expect(health.ready("kilo")).toBe(true);
    health.error("kilo", "first", "quota", new Date(time + 15_000).toUTCString());
    expect(health.limited("kilo")).toBe(true);
    time += 15_000;
    expect(health.ready("kilo")).toBe(true);
    health.success("kilo", "first");
    expect(health.failures("kilo")).toBe(0);
  });

  it("caps Retry-After at one hour and resets rejected credentials after ten minutes", () => {
    let now = 1000;
    const health = new ProviderHealth(undefined, () => now);
    health.error("kilo", "one", "quota", "36000");
    expect(health.routePause("kilo", "one").remaining).toBe(3_600_000);
    expect(health.routePause("kilo", "two").remaining).toBe(0);
    health.error("kilo", "one", "rejected", "1");
    expect(health.routePause("kilo", "two").remaining).toBe(600_000);
    now += 600_000;
    expect(health.routePause("kilo", "two").remaining).toBe(0);
    health.reset("kilo");
    expect(health.routeFailures("kilo", "one")).toBe(0);
  });

  it.each([429, 503, 401, 403, "timeout"] as const)("tries the same model with a second key before auto fallback (%s)", async failure => {
    const primary = await upstream(res => { if (failure !== "timeout") res.writeHead(failure).end(); });
    const backup = await upstream();
    const alternate = await upstream();
    const exhausted: string[] = [];
    const routes: { providerId: string; modelId: string; previousProviderId?: string }[] = [];
    const { send } = await fixture(
      [provider("kilo", alternate.url), provider("numes", primary.url, false), provider("runcrate", backup.url, false)],
      [offer("first", "numes"), offer("first", "runcrate"), offer("second", "kilo")],
      { auto: () => true, firstByteMs: 200, key: id => id !== "kilo" ? "local-test-key" : undefined,
        onRoute: route => routes.push(route), onExhausted: event => exhausted.push(event.modelId) }
    );
    const reply = await send("first");
    expect(reply.headers.get("x-vsemkod-model")).toBe("first");
    expect(await reply.json()).toEqual({ message: "ok" });
    expect(primary.calls[0].body.model).toBe("numes-first");
    expect(backup.calls[0].body.model).toBe("runcrate-first");
    expect(alternate.calls).toHaveLength(0);
    expect(exhausted).toEqual([]);
    expect(routes[0]).toMatchObject({ modelId: "first", previousProviderId: "numes", providerId: "runcrate" });
  });

  it("uses top before good and emits the model switch only with fallback enabled", async () => {
    const failure = await upstream(res => res.writeHead(503).end());
    const top = await upstream();
    const good = await upstream();
    let auto = false;
    const routes: { modelId: string; previousModelId?: string; reason?: string }[] = [];
    const { send } = await fixture(
      [provider("kilo", failure.url), provider("numes", top.url), provider("groq", good.url)],
      [offer("first", "kilo"), offer("second", "numes"), offer("third", "groq")],
      { auto: () => auto, onRoute: event => routes.push(event) }
    );
    expect((await send("first")).status).toBe(502);
    expect(top.calls).toHaveLength(0);
    auto = true;
    const replaced = await send("first");
    expect(replaced.headers.get("x-vsemkod-model")).toBe("second");
    expect(replaced.headers.get("x-vsemkod-fallback-from")).toBe("first");
    expect(routes[0]).toMatchObject({ modelId: "second", previousModelId: "first", reason: "unavailable" });
    expect(good.calls).toHaveLength(0);
    auto = false;
    expect((await send("auto")).headers.get("x-vsemkod-model")).toBe("second");
  });

  it("uses good when no top offers are accessible, and ignores basic in auto", async () => {
    const ok = await upstream();
    const { send } = await fixture(
      [provider("kilo", ok.url)], [offer("third", "kilo"), offer("basic", "kilo")]
    );
    expect((await send("auto")).headers.get("x-vsemkod-model")).toBe("third");
    expect((await send("basic")).headers.get("x-vsemkod-model")).toBe("basic");
  });

  it("falls back if upstream headers arrive but no body byte arrives in time", async () => {
    expect(FREE_FIRST_BYTE_MS).toBe(45_000);
    const stalled = await upstream(res => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
    const reserve = await upstream();
    const { send } = await fixture(
      [provider("kilo", stalled.url), provider("numes", reserve.url)],
      [offer("first", "kilo"), offer("first", "numes")], { firstByteMs: 100 }
    );
    expect((await send("first", { stream: true })).status).toBe(200);
    expect(reserve.calls).toHaveLength(1);
  });

  it("proxies SSE and tool calls byte-for-byte", async () => {
    const first = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write"}}]}}]}\n\n';
    const second = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
    const source = await upstream(res => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(first);
      setTimeout(() => res.end(second), 25);
    });
    const { send } = await fixture([provider("kilo", source.url)], [offer("first", "kilo")]);
    const response = await send("first", { stream: true });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(first + second);
  });

  it("fails the stream without replaying an interrupted tool call", async () => {
    const source = await upstream(res => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0}]}}]}\n\n');
      setTimeout(() => res.destroy(), 40);
    });
    const reserve = await upstream();
    const { send } = await fixture([provider("kilo", source.url), provider("numes", reserve.url)],
      [offer("first", "kilo"), offer("first", "numes")]);
    const response = await send("first", { stream: true });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(reserve.calls).toHaveLength(0);
  });

  it("restores provider/model averages and migrates legacy usage counters", async () => {
    const root = fileURLToPath(new URL("../.vsemkod-dev/", import.meta.url));
    await mkdir(root, { recursive: true });
    const local = await mkdtemp(join(root, "router-test-"));
    const path = join(local, "usage.json");
    cleanup.push(async () => { await rm(path, { force: true }); await rmdir(local); });
    const { writeJson } = await import("../src/main/storage");
    await writeJson(path, { kilo: { requests: 7, errors: 2 } });
    const health = new ProviderHealth(path);
    await health.load();
    const delayed = await upstream(res => setTimeout(() => text(res), 30));
    const { send, router } = await fixture([provider("kilo", delayed.url)], [offer("first", "kilo")], { health });
    await (await send("first")).text();
    const measured = health.latencies()[0].averageMs;
    expect(measured).toBeGreaterThanOrEqual(20);
    expect(health.firstByte("kilo", "first", measured * 3)).toBeCloseTo(measured * 2);
    expect(health.firstByte("numes", "first", 750)).toBe(750);
    await router.close();
    const restored = new ProviderHealth(path);
    await restored.load();
    expect(restored.latencies()).toEqual(health.latencies());
    expect(restored.firstByte("kilo", "first", measured * 5)).toBeCloseTo(measured * 3);
    expect(JSON.parse(await readFile(path, "utf8")).providers.kilo).toEqual({ requests: 8, errors: 2 });
    await restored.flush();
  });

  it("persists request and error counts without request contents", async () => {
    const root = fileURLToPath(new URL("../.vsemkod-dev/", import.meta.url));
    await mkdir(root, { recursive: true });
    const local = await mkdtemp(join(root, "router-test-"));
    const path = join(local, "usage.json");
    cleanup.push(async () => { await rm(path, { force: true }); await rmdir(local); });
    const failure = await upstream(res => res.writeHead(429, {
      "X-RateLimit-Limit": "200", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "60"
    }).end());
    const { router, send } = await fixture([provider("kilo", failure.url)],
      [offer("first", "kilo")], { health: new ProviderHealth(path) });
    expect((await send("first")).status).toBe(429);
    await router.close();
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toEqual({
      providers: { kilo: { requests: 1, errors: 1 } }, ttfb: [], windows: { kilo: [expect.any(Number)] },
      headers: { kilo: { at: expect.any(Number), requests: { limit: 200, remaining: 0, resetAt: expect.any(Number) } } }
    });
    const restored = new ProviderHealth(path);
    await restored.load();
    expect(restored.stats(sample).kilo?.requests).toMatchObject({ limit: 200, remaining: 0, source: "headers" });
  });

  it("pauses a single route for rate limiting and the provider for a 402", async () => {
    const health = new ProviderHealth();
    const source = await upstream((res, call) => {
      if (call.body.model === "kilo-first") res.writeHead(429).end("Too many requests");
      else if (call.body.model === "kilo-third") res.writeHead(402).end();
      else text(res);
    });
    const { send } = await fixture([provider("kilo", source.url)],
      [offer("first", "kilo"), offer("second", "kilo"), offer("third", "kilo")], { health });
    expect((await send("first")).status).toBe(429);
    expect(health.ready("kilo")).toBe(false);
    expect((await send("second")).status).toBe(200);
    expect(health.ready("kilo")).toBe(true);
    expect((await send("third")).status).toBe(429);
    expect((await send("second")).status).toBe(429);
    expect(source.calls.map(call => call.body.model)).toEqual(["kilo-first", "kilo-second", "kilo-third"]);
  });

  it("uses the route latency after failures and session affinity", async () => {
    const health = new ProviderHealth();
    const slow = await upstream();
    const fast = await upstream();
    health.firstByte("kilo", "first", 300, "kilo-first");
    health.firstByte("numes", "first", 100, "numes-first");
    const { send } = await fixture([provider("kilo", slow.url), provider("numes", fast.url)],
      [offer("first", "kilo"), offer("first", "numes")], { health });
    expect((await send("first")).status).toBe(200);
    expect(fast.calls).toHaveLength(1);
    health.error("numes", "numes-first", "unavailable", "0");
    expect((await send("first", {}, "another")).status).toBe(200);
    expect(slow.calls).toHaveLength(1);
    expect((await send("first")).status).toBe(200);
    expect(fast.calls).toHaveLength(2);
    expect(health.routeFailures("numes", "numes-first")).toBe(0);
  });

  it("learns the parallel capacity and keeps the slot until the SSE body ends", async () => {
    let held!: ServerResponse;
    const source = await upstream((res, call) => {
      if (call.body.model === "numes-first") {
        held = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"busy"}}]}\n\n');
      } else if (call.body.model === "numes-second") {
        res.writeHead(429, { "retry-after": "120" }).end("Too many concurrent requests");
      } else text(res);
    });
    const health = new ProviderHealth();
    const { send } = await fixture([{ ...provider("numes", source.url), freeLimits: {} }],
      [offer("first", "numes"), offer("second", "numes"), offer("third", "numes")], { health });
    const first = await send("first", { stream: true }, "a");
    expect((await send("second", {}, "b")).status).toBe(429);
    expect(health.routePause("numes", "numes-second").remaining).toBeLessThanOrEqual(3000);
    const third = send("third", {}, "c");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(source.calls).toHaveLength(2);
    held.end("data: [DONE]\n\n");
    await first.text();
    expect((await third).status).toBe(200);
    expect(source.calls).toHaveLength(3);
  });

  it("waits for an eligible route and pulses the parent watchdog, or cancels the wait", async () => {
    const source = await upstream();
    const health = new ProviderHealth();
    const onWait = vi.fn();
    const onActivity = vi.fn();
    const { router, headers, send } = await fixture([provider("kilo", source.url)], [offer("first", "kilo")],
      { health, waitBudgetMs: 3000, onWait, onActivity });
    health.error("kilo", "kilo-first", "quota", "2");
    router.setTurn({ sessionId: "parent", auto: false });
    const request = fetch(router.baseUrl + "/chat/completions", {
      method: "POST", headers: { ...headers, "x-opencode-session-id": "child", "x-opencode-parent-session-id": "parent" },
      body: JSON.stringify({ model: "first", messages: [] })
    });
    await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith({ sessionId: "parent", until: expect.any(Number) }));
    expect(source.calls).toHaveLength(0);
    expect((await request).status).toBe(200);
    expect(onWait).toHaveBeenLastCalledWith({ sessionId: "parent", until: null });
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onActivity.mock.calls.every(([session]) => session === "parent")).toBe(true);

    health.error("kilo", "kilo-first", "quota", "2");
    const controller = new AbortController();
    const failure = expect(send("first", {}, "cancelled", controller.signal)).rejects.toThrow();
    await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith({ sessionId: "cancelled", until: expect.any(Number) }));
    controller.abort();
    await failure;
    await vi.waitFor(() => expect(onWait).toHaveBeenLastCalledWith({ sessionId: "cancelled", until: null }));
    expect(source.calls).toHaveLength(1);
  });

  it("splices reasoning streams at complete SSE events and uses the final usage", async () => {
    const reasoning = 'data: {"choices":[{"delta":{"reasoning_content":"Думаю"}}]}\r\n\r\n';
    const source = await upstream(res => res.writeHead(200, { "content-type": "text/event-stream" })
      .end(reasoning + 'data: {"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":95}}\n\n' + "data: incomplete"));
    const output = 'data: {"choices":[{"delta":{"content":"Ответ"},"finish_reason":"stop"}]}\n\n';
    const reserve = await upstream(res => res.writeHead(200, { "content-type": "text/event-stream" }).end(output +
      'data: {"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":7}}\n\n' + "data: [DONE]\n\n"));
    const onRoute = vi.fn();
    const onActivity = vi.fn();
    const onReplyCache = vi.fn();
    const { send } = await fixture([provider("kilo", source.url), provider("numes", reserve.url)],
      [offer("first", "kilo"), offer("first", "numes")], { onRoute, onReplyCache, onActivity });
    const reply = await send("first", { stream: true });
    const events = await reply.text();
    expect(events).toContain(reasoning);
    expect(events).not.toContain("data: incomplete");
    expect(events.indexOf("Источник оборвал ответ")).toBeGreaterThan(events.indexOf("Думаю"));
    expect(events.indexOf(output)).toBeGreaterThan(events.indexOf("Источник оборвал ответ"));
    expect(reserve.calls[0].body.messages).toEqual(source.calls[0].body.messages);
    expect(onRoute).toHaveBeenLastCalledWith(expect.objectContaining({
      providerId: "numes", previousProviderId: "kilo", midStream: true, reason: "unavailable"
    }));
    expect(onActivity.mock.calls).toEqual([["chat"], ["chat"], ["chat"]]);
    expect(onReplyCache.mock.lastCall?.[0]).toBe("chat");
    expect(onReplyCache.mock.lastCall?.[1]).toBeCloseTo(7);
  });

  it("continues from the delivered text and strips the repeated role after a stall", async () => {
    const source = await upstream(res => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":"Раз, "}}]}\n\n');
    });
    const reserve = await upstream(res => res.writeHead(200, { "content-type": "text/event-stream" }).end(
      'data: {"choices":[{"delta":{"role":"assistant","content":"два."},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n"));
    const { send } = await fixture([provider("kilo", source.url), provider("numes", reserve.url)],
      [offer("first", "kilo"), offer("first", "numes")], { stallMs: 90 });
    const response = await send("first", { stream: true });
    const events = await response.text();
    expect(response.headers.get("x-vsemkod-model")).toBe("first");
    expect(events.match(/"role":"assistant"/g)).toHaveLength(1);
    expect(events).toContain('"content":"два."');
    expect(events).not.toContain("Источник оборвал ответ");
    expect(reserve.calls[0].body.messages).toMatchObject([
      { role: "user", content: "Тест" },
      { role: "assistant", content: "Раз, " },
      { role: "user", content: expect.stringContaining("Продолжи свой предыдущий ответ") }
    ]);
  });

  it("keeps a partial non-streaming body private and retries the complete response", async () => {
    const source = await upstream(res => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write('{"partial":');
      setTimeout(() => res.destroy(), 35);
    });
    const reserve = await upstream();
    const { send } = await fixture([provider("kilo", source.url), provider("numes", reserve.url)],
      [offer("first", "kilo"), offer("first", "numes")]);
    expect(await (await send("first")).json()).toEqual({ message: "ok" });
  });

  it("forwards the original SSE and reports cache usage for the correct chat", async () => {
    const payload = 'data: {"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":87}}}\n\ndata: [DONE]\n\n';
    const gateway = await upstream(res => res.writeHead(200, { "content-type": "text/event-stream" }).end(payload));
    const readings: unknown[] = [];
    const { send } = await fixture([provider("kilo", gateway.url)], [offer("first", "kilo")],
      { onReplyCache: (id, cache) => readings.push([id, cache]) });
    expect(await (await send("first", { stream: true }, "session-f")).text()).toBe(payload);
    expect(readings).toEqual([["session-f", 87]]);
  });
});
