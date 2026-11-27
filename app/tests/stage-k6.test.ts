import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import bundled from "../resources/catalog.json";
import { FileKeys } from "../src/cli/file-keys";
import { ConnectService } from "../src/main/connect-service";
import type { KeyStore } from "../src/main/key-store";
import { Router } from "../src/main/router";
import { ProviderHealth } from "../src/main/router/health";
import { automaticModels, defaultModel } from "../src/shared/catalog";
import { catalogSchema, type Catalog } from "../src/shared/catalog-schema";
import type { Benchmarks } from "../src/shared/benchmarks";
import { modelOptions } from "../src/renderer/models";

vi.mock("../src/renderer/window-controls", () => ({ WindowControls: () => null }));

test("показывает найденные и basic модели только по признаку «без цензуры»", () => {
  const base = catalogSchema.parse(bundled);
  const model = base.models[0];
  const offer = base.offers.find(entry => entry.providerId === "kilo")!;
  const catalog: Catalog = {
    ...base, models: [
      { ...model, id: "x-ordinary", origin: "discovered" },
      { ...model, id: "x-model-heretic", origin: "discovered" },
      { ...model, id: "weak", tier: "basic" },
      { ...model, id: "uncensored-weak", tier: "basic" },
      { ...model, id: "standard", tier: "good" },
    ],
    offers: [],
  };
  catalog.offers = catalog.models.map(item => ({
    ...offer, modelId: item.id, providerModelId: item.id === "standard" ? "alias-abliterated" : item.id,
    expiresAt: null, supportsTools: true, status: "active",
  }));
  catalog.offers.push({ ...catalog.offers[1], providerId: "openrouter" });
  const options = modelOptions({ catalog, connected: ["kilo"], personal: [], subscriptions: [], personalModels: [], zenModels: [] });
  expect(options.map(item => item.model.id)).toEqual(["x-model-heretic", "standard", "uncensored-weak"]);
  expect(options[0].available.map(item => item.provider.id)).toEqual(["kilo"]);
  expect(options[0].locked.map(item => item.provider.id)).toEqual(["openrouter"]);
  expect(automaticModels(catalog)).toEqual([]);
});

test("ставит анонимные быстрые модели перед рейтингом, Ultra оставляет последним", () => {
  const base = catalogSchema.parse(bundled);
  const ids = ["ernie-5.5-flash-preview", "beam-free", "nemotron-3.5-super", "ling-3.2-flash",
    "strong-high", "strong-low", "nemotron-3-ultra", "weak", "uncensored", "x-discovered"];
  const sample = base.models[0];
  const sampleOffer = base.offers.find(offer => offer.providerId === "kilo")!;
  const catalog: Catalog = {
    ...base, models: ids.map((id, rank) => ({
      ...sample, id, rank: id === "strong-high" ? 1000 : rank, origin: id === "x-discovered" ? "discovered" : undefined,
      tier: id === "weak" ? "basic" : "good",
    })), offers: ids.map(id => ({
      ...sampleOffer, modelId: id, providerModelId: id, supportsTools: true, expiresAt: null, status: "active",
    })),
  };
  const benchmarks: Benchmarks = {
    schemaVersion: 1, generatedAt: base.generatedAt,
    source: { name: "Artificial Analysis", url: "https://artificialanalysis.ai/", indexVersion: "5" },
    models: { "strong-high": { index: 60 }, "strong-low": { index: 30 }, "nemotron-3-ultra": { index: 100 } },
  };
  expect(automaticModels(catalog, undefined, benchmarks).map(model => model.id)).toEqual(ids.slice(0, 7));
  for (const id of ids.slice(0, 4)) {
    expect(defaultModel(catalog, undefined, benchmarks)?.id).toBe(id);
    catalog.offers.find(offer => offer.modelId === id)!.supportsTools = false;
  }
  expect(defaultModel(catalog, undefined, benchmarks)?.id).toBe("strong-high");
  expect(defaultModel(catalog)?.id).toBe("strong-low");
});

test("принимает будущие поля провайдера и раздачи и проверяет известные поля", () => {
  const base = catalogSchema.parse(bundled);
  base.providers[0].futureProvider = { value: true };
  base.offers[0].futureOffer = "value";
  const parsed = catalogSchema.parse(base);
  expect(parsed.providers[0].futureProvider).toEqual({ value: true });
  expect(parsed.offers[0].futureOffer).toBe("value");
  const invalid = { ...base, offers: [{ ...base.offers[0], supportsTools: "yes" }] };
  expect(catalogSchema.safeParse(invalid).success).toBe(false);
});

// Cloudflare снят с каталога 2026-11-27 (не подключается у пользователей); поддержка в роутере осталась.
test.skip("Cloudflare сохраняет Account ID и роутит через OpenAI-совместимый адрес", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vsemkod-cloudflare-"));
  const calls: { path?: string; auth?: string; model: string }[] = [];
  const server = createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(chunk);
    calls.push({ path: req.url, auth: req.headers.authorization, model: JSON.parse(Buffer.concat(body).toString()).model });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no test server");
  const originalFetch = fetch;
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => originalFetch(
    String(url).replace("https://api.cloudflare.com", "http://127.0.0.1:" + address.port), init,
  ));
  const catalog = catalogSchema.parse(bundled);
  const cloudflare = catalog.providers.find(provider => provider.id === "cloudflare")!;
  const offer = catalog.offers.find(offer => offer.providerId === cloudflare.id && offer.providerModelId.endsWith("gpt-oss-120b"))!;
  const id = "1234567890abcdef1234567890abcdef";
  const path = join(dir, "keys.json");
  const keys = new FileKeys(path, {});
  const connections = new ConnectService(keys as unknown as KeyStore);
  const router = new Router({
    catalog: () => ({ ...catalog, providers: [cloudflare] }), health: new ProviderHealth(),
    key: providerId => connections.key(providerId), cloudflareAccount: providerId => connections.cloudflareAccount(providerId),
  });
  try {
    await expect(connections.manual(cloudflare, "token", undefined, AbortSignal.timeout(3000), undefined, "../wrong"))
      .rejects.toThrow("Account ID");
    expect(calls).toHaveLength(0);
    await connections.manual(cloudflare, "token", undefined, AbortSignal.timeout(3000), undefined, id);
    await keys.load();
    expect(keys.profile(cloudflare.id)?.accountId).toBe(id);
    expect(connections.connected(catalog)).toContain(cloudflare.id);

    await router.start();
    const result = await fetch(router.baseUrl + "/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + router.token, "content-type": "application/json" },
      body: JSON.stringify({ model: offer.modelId, messages: [] }),
    });
    expect(result.status).toBe(200);
    expect((await result.json()).choices[0].message.content).toBe("pong");
    expect(catalog.models.find(model => model.id === offer.modelId)?.tier).toBe("basic");
    expect(calls).toEqual(Array(2).fill({
      path: "/client/v4/accounts/" + id + "/ai/v1/chat/completions", auth: "Bearer token", model: offer.providerModelId,
    }));
  } finally {
    vi.unstubAllGlobals();
    await router.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
