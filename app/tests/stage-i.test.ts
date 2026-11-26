
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import bundled from "../resources/catalog.json";
import { ConnectService, modelReference } from "../src/main/connect-service";
import { KeyStore } from "../src/main/key-store";
import { Router } from "../src/main/router";
import { ProviderHealth } from "../src/main/router/health";
import { automaticModels } from "../src/shared/catalog";
import { catalogSchema } from "../src/shared/catalog-schema";
import { effectiveCatalog, normalizeModelId } from "../src/shared/model-merge";
import { personalProviders } from "../src/shared/providers";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test-backend",
    encryptString: (input: string) => Buffer.from(input).reverse(),
    decryptString: (input: Buffer) => Buffer.from(input).reverse().toString()
  }
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

async function upstream(handler: RequestListener) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return "http://127.0.0.1:" + address.port + "/v1";
}

async function keyStore() {
  const root = await mkdtemp(join(tmpdir(), "vsemkod-stage-i-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "keys.json");
  return { path, keys: new KeyStore(path) };
}

test("groups equivalent upstream IDs and respects catalog offers and model identity", () => {
  const flash = "deepseek-v4.1-flash";
  const ids = [
    "deepseek/deepseek-v4.1-flash:free", "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4.1-Flash-1017", "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017"
  ];
  expect(ids.map(normalizeModelId)).toEqual(Array(4).fill(flash));
  expect(normalizeModelId("dealignai/deepseek-v4.1-flash-uncensored-fp8:free")).toBe(flash + "-uncensored");
  expect(normalizeModelId("DeepSeek-V4-Flash-0731")).toBe("deepseek-v4-flash");
  expect(normalizeModelId("VENDOR/My_Model fp8-20261126:trial")).toBe("my-model");
  const base = catalogSchema.parse(bundled);
  base.providers.sort((a, b) => Number(b.id === "numes") - Number(a.id === "numes"));
  base.offers = base.offers.filter(offer => offer.modelId !== flash || offer.providerId === "modelscope");
  const curated = base.offers.find(offer => offer.modelId === flash && offer.providerId === "modelscope")!;
  curated.supportsTools = false;
  const list = (...models: { id: string; name: string; context?: number; vision?: boolean }[]) => ({ models, updatedAt: Date.now() });
  const remote = (id: string) => ({ id, name: id });
  const catalog = effectiveCatalog(base, {
    numes: list(remote(ids[3]), { id: "vendor/Other_Model-FP8", name: "vendor/Other Model (free)", context: 64_000 }),
    modelscope: list(remote(ids[2]), { ...remote("other-model-1017"), vision: true }),
    openrouter: list(remote(ids[0]), remote("vendor/other-model:free"), remote("vendor/deepseek-v4.1-flash-uncensored-fp8:free"))
  });
  expect(catalogSchema.safeParse(catalog).success).toBe(true);
  const flashOffers = catalog.offers.filter(offer => offer.modelId === flash);
  expect(flashOffers.filter(offer => offer.origin === "discovered").map(offer => offer.providerId).sort())
    .toEqual(["numes", "openrouter"]);
  expect(flashOffers.find(offer => offer.providerId === "modelscope")).toBe(curated);
  expect(curated.supportsTools).toBe(false);
  expect(catalog.models.find(model => model.id === "x-other-model")).toMatchObject({
    origin: "discovered", tier: "new", name: "Other Model", capabilities: ["code", "tools", "vision"]
  });
  expect(catalog.offers.filter(offer => offer.modelId === "x-other-model")).toHaveLength(3);
  expect(catalog.models.some(model => model.id === "x-deepseek-v4.1-flash-uncensored")).toBe(true);
  expect(automaticModels(catalog).every(model => model.origin !== "discovered")).toBe(true);
  expect(base.models.some(model => model.origin)).toBe(false);
});

test("opens an old model reference through the merged catalog and fails over to its other provider", async () => {
  const firstId = "org/New_Model-FP8";
  const secondId = "new-model-1017";
  const visited: string[] = [];
  const server = (model: string, status: number) => upstream((req, res) => {
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: model }] }));
    } else {
      visited.push(model);
      res.writeHead(status).end("{}");
    }
  });
  const base = catalogSchema.parse(bundled);
  base.providers = base.providers.filter(provider => provider.id === "numes" || provider.id === "modelscope");
  base.providers.find(provider => provider.id === "numes")!.baseUrl = await server(firstId, 502);
  base.providers.find(provider => provider.id === "modelscope")!.baseUrl = await server(secondId, 200);
  for (const provider of base.providers) provider.clicksToConnect = provider.id === "numes" ? 0 : 1;
  const { keys } = await keyStore();
  await keys.set("numes", "numes-key");
  await keys.set("modelscope", "modelscope-key");
  const service = new ConnectService(keys);
  await service.refreshCatalogModels(base);
  const router = new Router({ catalog: () => service.effectiveCatalog(base), key: id => service.key(id),
    health: new ProviderHealth(), legacyModel: id => service.legacyCatalogModel(base, id) });
  await router.start();
  cleanups.push(() => router.close());
  const send = (model: string) => fetch(router.baseUrl + "/chat/completions", {
    method: "POST", headers: { authorization: "Bearer " + router.token, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [] })
  });
  const reply = await send(modelReference("numes", firstId));
  expect(reply.status).toBe(200);
  expect(reply.headers.get("x-vsemkod-model")).toBe("x-new-model");
  expect(visited).toEqual([firstId, secondId]);
  const missing = await send(modelReference("numes", "removed"));
  expect(missing.status).toBe(404);
  expect((await missing.json()).error.message).toContain("Выберите её заново");
});

test("the free and paid route sets are disjoint even when the free routes are paused", async () => {
  const flash = "deepseek-v4.1-flash";
  const hits: string[] = [];
  const free = await upstream((req, res) => {
    hits.push("free");
    expect(req.headers.authorization).toBeUndefined();
    res.writeHead(hits.length <= 2 ? 402 : 200).end("{}");
  });
  const paid = await upstream((req, res) => {
    hits.push("paid");
    expect(req.headers.authorization).toBe("Bearer paid-key");
    res.writeHead(503).end();
  });
  const { keys } = await keyStore();
  await keys.set("deepseek-api", "paid-key", { baseUrl: paid, models: [{ id: flash, name: "DeepSeek Flash" }] });
  const service = new ConnectService(keys);
  const paidId = service.personalRoutes()[0].model.id;
  const catalog = catalogSchema.parse(bundled);
  catalog.providers = catalog.providers.filter(provider => provider.id === "kilo" || provider.id === "numes");
  for (const provider of catalog.providers) {
    provider.baseUrl = free;
    provider.auth = { type: "none" };
  }
  catalog.offers = [flash, "nemotron-3.5-lightning"].map((modelId, index) => ({
    ...catalog.offers.find(offer => offer.providerId === "kilo" && offer.status === "active")!,
    modelId, providerId: index === 0 ? "kilo" : "numes", providerModelId: modelId
  }));
  const health = new ProviderHealth();
  const router = new Router({ catalog: () => catalog, key: id => service.key(id), personal: () => service.personalRoutes(),
    health, auto: () => true });
  await router.start();
  cleanups.push(() => router.close());
  const send = (model: string) => fetch(router.baseUrl + "/chat/completions", {
    method: "POST", headers: { authorization: "Bearer " + router.token, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [] })
  });
  expect((await send(flash)).status).toBe(429);
  expect((await send("auto")).status).toBe(429);
  expect(hits).toEqual(["free", "free"]);
  router.resetProvider("kilo");
  router.resetProvider("numes");
  expect((await send(paidId)).status).toBe(502);
  expect(hits).toEqual(["free", "free", "paid"]);
});

test("creates and updates independent custom profiles, probes manual models and uses the legacy profile", async () => {
  const probes: { auth?: string; body: unknown }[] = [];
  let modelsStatus = 404;
  let completionStatus = 200;
  const baseUrl = await upstream(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(modelsStatus, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "manual/model" }] }));
      return;
    }
    expect(req.url).toBe("/v1/chat/completions");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    probes.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(completionStatus).end("{}");
  });
  const { path, keys } = await keyStore();
  const connections = new ConnectService(keys);
  const models = [{ id: "manual/model", name: "Personal", context: 8192, output: 4096 }];
  await expect(connections.customProviderModels({ baseUrl, key: "first-key" }))
    .rejects.toThrow("Сервер не отдаёт список моделей. Впишите id модели вручную.");
  const input = { baseUrl, name: "  Local  ", models };
  const id = await connections.saveCustomProvider({ ...input, key: "first-key" });
  expect(id).toMatch(/^custom-[a-z0-9]{8}$/);
  expect(probes).toEqual([{ auth: "Bearer first-key", body: {
    model: "manual/model", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false
  } }]);
  await connections.saveCustomProvider({ ...input, id, name: "Renamed" });
  expect(probes[1].auth).toBe("Bearer first-key");
  modelsStatus = 200;
  const other = await connections.saveCustomProvider({ ...input, key: "second-key" });
  expect(other).not.toBe(id);
  await expect(connections.saveCustomProvider({ ...input, models: [{ id: "missing", name: "Missing" }], key: "second-key" }))
    .rejects.toThrow("Выберите доступные модели");
  expect(await connections.customProviderModels({ id })).toEqual(models);
  await keys.set("custom-api", "old-key", { baseUrl, models });
  expect(connections.customProviders()).toEqual([
    { ...input, id, name: "Renamed" }, { ...input, id: other, name: "Local" },
    { id: "custom-api", baseUrl, models, name: "Свой OpenAI-совместимый" }
  ]);
  expect(connections.personalRoutes().map(route => [route.model.providerName, route.model.kind])).toEqual([
    ["Renamed", "custom"], ["Local", "custom"], ["Свой OpenAI-совместимый", "custom"]
  ]);
  const stored = await readFile(path, "utf8");
  expect(stored).not.toMatch(/first-key|second-key|old-key/);
  const restart = new KeyStore(path);
  await restart.load();
  expect(restart.get(id)).toBe("first-key");
  expect(restart.profile(id)?.name).toBe("Renamed");

  modelsStatus = 404;
  completionStatus = 401;
  await expect(connections.saveCustomProvider({ ...input, id, key: "bad-key" })).rejects.toThrow("Ключ не подошёл");
  expect(keys.get(id)).toBe("first-key");
  completionStatus = 404;
  await expect(connections.saveCustomProvider({ ...input, id })).rejects.toThrow("Модель manual/model не найдена у поставщика");
  await connections.disconnect(id);
  await connections.disconnect("custom-api");
  expect(keys.get(id)).toBeUndefined();
  expect(connections.customProviders().map(provider => provider.id)).toEqual([other]);
});

test("validates a coding plan with a one-token POST when it has a static model list", async () => {
  const calls: { path?: string; body: unknown }[] = [];
  const baseUrl = await upstream(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.end("{}");
  });
  const provider = personalProviders.find(provider => provider.id === "kimi-code")!;
  const { keys } = await keyStore();
  const connections = new ConnectService(keys);
  await connections.manual({ ...provider, baseUrl }, "test-plan-key", undefined, new AbortController().signal);
  expect(calls).toEqual([{ path: "/v1/chat/completions", body: expect.objectContaining({
    model: provider.models![0].id, max_tokens: 1
  }) }]);
  expect(connections.personalRoutes().every(route => route.model.kind === "plan")).toBe(true);
});
