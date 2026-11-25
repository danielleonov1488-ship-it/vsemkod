import { createServer, get, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import bundled from "../resources/catalog.json";
import { catalogSchema, type Catalog, type Offer, type Provider } from "../src/shared/catalog-schema";
import { Router } from "../src/main/router";
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
  const router = new Router({ catalog: () => catalog, key: () => undefined, health: new ProviderHealth(), ...options });
  await router.start();
  cleanup.push(() => router.close());
  const headers = { authorization: "Bearer " + router.token, "content-type": "application/json" };
  const send = (model: string, patch: Record<string, unknown> = {}, session = "chat") => fetch(router.baseUrl + "/chat/completions", {
    method: "POST", headers: { ...headers, "x-vsemkod-session": session },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Тест" }], ...patch })
  });
  return { router, headers, send };
}

describe("Router", () => {
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
    expect(primary.calls).toHaveLength(3);
    expect((await send("first")).status).toBe(200);
    expect(reserve.calls).toHaveLength(4);
  });

  it("cools down network errors exponentially and accepts Retry-After dates", () => {
    let time = 60_000;
    const health = new ProviderHealth(undefined, () => time);
    health.error("kilo", "unavailable");
    time += 29_999;
    expect(health.ready("kilo")).toBe(false);
    time++;
    expect(health.ready("kilo")).toBe(true);
    health.error("kilo", "unavailable");
    time += 59_999;
    expect(health.ready("kilo")).toBe(false);
    time++;
    expect(health.ready("kilo")).toBe(true);
    health.error("kilo", "quota", new Date(time + 15_000).toUTCString());
    expect(health.limited("kilo")).toBe(true);
    time += 15_000;
    expect(health.ready("kilo")).toBe(true);
    health.success("kilo");
    expect(health.failures("kilo")).toBe(0);
  });

  it("uses top before good and emits the model switch only with fallback enabled", async () => {
    const failure = await upstream(res => res.writeHead(503).end());
    const top = await upstream();
    const good = await upstream();
    let auto = false;
    const routes: { modelId: string; previousModelId?: string }[] = [];
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
    expect(routes[0]).toMatchObject({ modelId: "second", previousModelId: "first" });
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

  it("does not switch upstream after any stream byte is forwarded", async () => {
    const source = await upstream(res => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
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

  it("persists request and error counts without request contents", async () => {
    const root = fileURLToPath(new URL("../.vsemkod-dev/", import.meta.url));
    await mkdir(root, { recursive: true });
    const local = await mkdtemp(join(root, "router-test-"));
    const path = join(local, "usage.json");
    cleanup.push(async () => { await rm(path, { force: true }); await rmdir(local); });
    const failure = await upstream(res => res.writeHead(429).end());
    const { router, send } = await fixture([provider("kilo", failure.url)],
      [offer("first", "kilo")], { health: new ProviderHealth(path) });
    expect((await send("first")).status).toBe(429);
    await router.close();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ kilo: { requests: 1, errors: 1 } });
  });
});
