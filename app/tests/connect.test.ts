import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { catalogSchema } from "../src/shared/catalog-schema";
import { personalProviders } from "../src/shared/providers";
import { ClipboardWatch, clipboardLimit, keyFromClipboard } from "../src/main/clipboard-watch";
import { ConnectService, modelReference } from "../src/main/connect-service";
import { KeyStore } from "../src/main/key-store";
import { createPkce, openRouterKey } from "../src/main/openrouter-oauth";
import { Router } from "../src/main/router";
import { ProviderHealth } from "../src/main/router/health";
import bundled from "../resources/catalog.json";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test-backend",
    encryptString: (input: string) => Buffer.from(input).reverse(),
    decryptString: (input: Buffer) => Buffer.from(input).reverse().toString()
  }
}));

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function mockServer(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local address");
  cleanup.push(() => { server.close(); server.closeAllConnections(); });
  return "http://127.0.0.1:" + address.port;
}

test("catalog discovery caches only free models and maps them to the provider without storing credentials", async () => {
  const data = await mkdtemp(join(tmpdir(), "vsemkod-g-models-"));
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  const expectedKey = "local-fixture-secret";
  let requests = 0;
  const server = await mockServer((req, res) => {
    expect(req.url).toBe("/models");
    expect(req.headers.authorization).toBe("Bearer " + expectedKey);
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [
      { id: "fixture/free-with-pricing", name: "Fixture Zero", pricing: { prompt: "0", completion: "0" } },
      { id: "fixture/trial:free", name: "Fixture Free" },
      { id: "fixture/paid", pricing: { prompt: "0", completion: "0.0001" } },
      { id: "fixture/paid:free", pricing: { prompt: "0", completion: "0.0001" } },
      { id: "fixture/no-tools:free", supports_tools: false },
      { id: "fixture/unknown" }
    ] }));
  });
  const catalog = catalogSchema.parse(bundled);
  catalog.providers.find(provider => provider.id === "openrouter")!.baseUrl = server;
  const keys = new KeyStore(join(data, "keys.json"));
  await keys.set("openrouter", expectedKey);
  const cache = join(data, "provider-models.json");
  const service = new ConnectService(keys, cache);
  await service.refreshCatalogModels(catalog);
  await service.refreshCatalogModels(catalog);
  expect(requests).toBe(1);
  expect(await readFile(cache, "utf8")).not.toContain(expectedKey);
  const restarted = new ConnectService(keys, cache);
  await restarted.loadCatalogModels();
  expect(restarted.personalRoutes()).toEqual([]);
  const discovered = () => restarted.effectiveCatalog(catalog).offers.filter(offer => offer.origin === "discovered");
  expect(discovered().map(offer => [offer.providerId, offer.providerModelId, offer.modelId])).toEqual([
    ["openrouter", "fixture/free-with-pricing", "x-free-with-pricing"], ["openrouter", "fixture/trial:free", "x-trial"]
  ]);
  expect(restarted.legacyCatalogModel(catalog, modelReference("openrouter", "fixture/trial:free"))).toBe("x-trial");
  await restarted.disconnect("openrouter");
  expect(discovered()).toEqual([]);
});

test("discovers free model conventions and restricts allModelsFree to explicit tool support", async () => {
  const catalog = catalogSchema.parse(bundled);
  const regular = await mockServer((_req, res) => res.end(JSON.stringify({ data: [
    { id: "fixture/a-free" }, { id: "fixture/b:free" }, { id: "free/c" }, { id: "fixture/d", free: true },
    { id: "fixture/e", pricing: { input: "0", output: 0 } },
    { id: "fixture/f", input_price: 0, output_price: "0.0000", supports_tool_calling: true },
    { id: "fixture/g", pricing: { free: true }, tool_call: true },
    { id: "fixture/paid", pricing: { input: 0, output: 1 } },
    { id: "fixture/no-tool-free", supports_tools: false }
  ] })));
  const allFree = await mockServer((_req, res) => res.end(JSON.stringify({ data: [
    { id: "fixture/allfree", capabilities: { function_calling: true } },
    { id: "fixture/no-tools", supports_tools: false }, { id: "fixture/unknown" }
  ] })));
  const sample = catalog.providers.find(provider => provider.id === "groq")!;
  catalog.providers.push(
    { ...sample, id: "test-gateway", baseUrl: regular },
    { ...sample, id: "another-provider", baseUrl: allFree, auth: { type: "none" }, freeLimits: { allModelsFree: true } },
  );
  const dir = await mkdtemp(join(tmpdir(), "vsemkod-k1-connect-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "keys.json");
  const keys = new KeyStore(path);
  await keys.set("test-gateway", "fixture-test-key");
  const reloaded = new KeyStore(path);
  await reloaded.load();
  expect(reloaded.get("test-gateway")).toBe("fixture-test-key");
  const service = new ConnectService(reloaded);
  await service.refreshCatalogModels(catalog);
  const offers = service.effectiveCatalog(catalog).offers.filter(offer => offer.origin === "discovered");
  expect(offers.filter(offer => offer.providerId === "test-gateway").map(offer => offer.providerModelId))
    .toEqual(["fixture/a-free", "fixture/b:free", "free/c", "fixture/d", "fixture/e", "fixture/f", "fixture/g"]);
  expect(offers.filter(offer => offer.providerId === "another-provider").map(offer => offer.providerModelId))
    .toEqual(["fixture/allfree"]);
});

test("PKCE uses an independent verifier and a base64url SHA-256 challenge", () => {
  const { verifier, challenge } = createPkce();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  expect(createPkce().verifier).not.toBe(verifier);
});

test("OpenRouter accepts one callback, exchanges its code and closes the listener", async () => {
  let challenge = "";
  let callback!: URL;
  let received!: Promise<Response>;
  let request: unknown;
  const upstream = await mockServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ key: "mock-oauth-key" }));
  });
  const key = await openRouterKey({ authorizeUrl: upstream + "/auth", exchangeUrl: upstream + "/api/v1/auth/keys" },
    async raw => {
      const url = new URL(raw);
      expect(url.pathname).toBe("/auth");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      challenge = url.searchParams.get("code_challenge")!;
      callback = new URL(url.searchParams.get("callback_url")!);
      expect(callback.host).toMatch(/^localhost:\d+$/);
      expect(callback.pathname).toBe("/callback");
      callback.searchParams.set("code", "mock-one-time-code");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      received = fetch(callback);
    }, new AbortController().signal, 3000);
  expect(key).toBe("mock-oauth-key");
  const verifier = (request as { code_verifier: string }).code_verifier;
  expect(request).toEqual({ code: "mock-one-time-code", code_verifier: verifier, code_challenge_method: "S256" });
  expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  expect(await (await received).text()).toContain("Готово, вернитесь в vsemkod");
  await expect(fetch(callback)).rejects.toThrow();
});

test.each(["timeout", "cancel"] as const)("OpenRouter releases the callback server on %s", async scenario => {
  const cancel = new AbortController();
  let callback!: URL;
  const waiting = openRouterKey({ authorizeUrl: "https://openrouter.ai/auth", exchangeUrl: "https://openrouter.ai/api/v1/auth/keys" },
    async raw => {
      callback = new URL(new URL(raw).searchParams.get("callback_url")!);
      if (scenario === "cancel") cancel.abort();
    }, cancel.signal, scenario === "timeout" ? 100 : 2000);
  await expect(waiting).rejects.toThrow(scenario === "timeout" ? "Время входа истекло" : "Вход отменён");
  await expect(fetch(callback)).rejects.toThrow();
});

test("clipboard is off until enabled, reads once a second and picks only a full matching key", async () => {
  vi.useFakeTimers();
  const pattern = "^gsk_[A-Za-z0-9]+$";
  expect(keyFromClipboard("текст gsk_abc123", new RegExp(pattern))).toBeUndefined();
  expect(keyFromClipboard(" gsk_abc123\n", new RegExp(pattern))).toBe("gsk_abc123");
  expect(keyFromClipboard("gsk_one\ngsk_two", new RegExp(pattern))).toBeUndefined();
  const read = vi.fn().mockReturnValueOnce("other text").mockResolvedValue("gsk_abc123");
  const watch = new ClipboardWatch(read);
  const found = vi.fn(), expired = vi.fn();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).not.toHaveBeenCalled();
  watch.enable(pattern, found, expired);
  await vi.advanceTimersByTimeAsync(999);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1001);
  expect(found).toHaveBeenCalledExactlyOnceWith("gsk_abc123");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(2);
  watch.close();
});

test("clipboard stops after five minutes even if the switch was toggled", async () => {
  vi.useFakeTimers();
  const watch = new ClipboardWatch(() => "");
  const found = vi.fn(), expired = vi.fn();
  watch.enable("^gsk_[A-Za-z0-9]+$", found, expired);
  await vi.advanceTimersByTimeAsync(clipboardLimit - 1000);
  watch.pause();
  watch.enable("^gsk_[A-Za-z0-9]+$", found, expired);
  await vi.advanceTimersByTimeAsync(1000);
  expect(expired).toHaveBeenCalledTimes(1);
  expect(found).not.toHaveBeenCalled();
  watch.close();
});

test("a custom key is validated, its model streams through Router, and disconnect removes the persisted key", async () => {
  const provider = personalProviders.find(item => item.id === "custom-api")!;
  const key = "mock-personal-key";
  let completion: unknown;
  const upstream = await mockServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + key) { res.writeHead(401).end(); return; }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "mock/chat-v1", name: "Тестовая модель" }] }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    completion = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: [DONE]\n\n");
  });
  await mkdir(".vsemkod-dev", { recursive: true });
  const data = await mkdtemp(join(".vsemkod-dev", "test-keys-"));
  const path = join(data, "keys.json");
  const keys = new KeyStore(path);
  const service = new ConnectService(keys);
  const signal = new AbortController().signal;
  await expect(service.manual(provider, "wrong", upstream + "/v1", signal)).rejects.toThrow("Ключ не подошёл");
  expect(service.key(provider.id)).toBeUndefined();
  await service.manual(provider, key, upstream + "/v1/", signal);
  expect(service.connectedPersonal()).toEqual([provider.id]);
  expect(await readFile(path, "utf8")).not.toContain(key);
  const restarted = new KeyStore(path);
  await restarted.load();
  expect(restarted.get(provider.id)).toBe(key);
  const route = service.personalRoutes()[0];
  const catalog = catalogSchema.parse(bundled);
  const router = new Router({ catalog: () => catalog, personal: () => service.personalRoutes(),
    key: id => service.key(id), health: new ProviderHealth() });
  await router.start();
  cleanup.push(() => router.close());
  const headers = { authorization: "Bearer " + router.token, "content-type": "application/json" };
  const models = await (await fetch(router.baseUrl + "/models", { headers })).json();
  expect(models.data).toContainEqual(expect.objectContaining({ id: route.model.id }));
  const payload = { model: route.model.id, stream: true, messages: [{ role: "user", content: "test" }],
    tools: [{ type: "function", function: { name: "test", parameters: { type: "object" } } }] };
  const send = () => fetch(router.baseUrl + "/chat/completions", { method: "POST", headers, body: JSON.stringify(payload) });
  const response = await send();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("[DONE]");
  expect(completion).toEqual({ ...payload, model: "mock/chat-v1", stream_options: { include_usage: true } });
  await service.disconnect(provider.id);
  await restarted.load();
  expect(restarted.get(provider.id)).toBeUndefined();
  expect(restarted.profile(provider.id)).toBeUndefined();
  expect(service.personalRoutes()).toEqual([]);
  expect((await send()).status).toBe(404);
});
