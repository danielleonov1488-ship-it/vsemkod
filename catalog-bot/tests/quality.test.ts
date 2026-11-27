import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { classifyCatalog, indexVersionWarning } from "../src/quality.js";
import { makeChanges, mergeCatalog } from "../src/merge.js";
import { legacyCatalog, notifyTelegram } from "../src/publish.js";
import { registryBatches } from "../src/registry/offers.js";
import { catalogSchema, type Catalog } from "../src/schema.js";
import { fetchBenchmarks, type Benchmarks } from "../src/sources/artificialAnalysis.js";
import { newState } from "../src/state.js";
import { catalogSchema as legacySchema } from "./fixtures/catalog-0.1.5/catalog-schema.js";

const now = "2026-11-27T11:00:00Z";
const options = { now, missingRuns: 1, retentionDays: 7, healthFailureThreshold: 2 };
const snapshot = (version: string, models: Benchmarks["models"]): Benchmarks => ({
  schemaVersion: 1, generatedAt: now,
  source: { name: "Artificial Analysis", url: "https://artificialanalysis.ai/", indexVersion: version }, models,
});
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

afterEach(() => vi.unstubAllGlobals());

it("применяет границы 12 и 25 и сохраняет исключения", () => {
  const base = catalogSchema.parse(read("../data/catalog-v2.json"));
  const ids = ["below", "floor", "good", "top", "unknown", "nemotron-3-ultra", "kimi-k2.7-code", "special", "custom-uncensored"];
  const catalog: Catalog = { ...base, models: ids.map(id => ({ ...base.models[0], id, name: id, tier: "new" })),
    offers: [{ ...base.offers[0], modelId: "special", providerModelId: "model-heretic" }] };
  const data = snapshot("5", { below: { index: 11.99 }, floor: { index: 12 }, good: { index: 24.99 },
    top: { index: 25 }, "nemotron-3-ultra": { index: 11.8 } });
  const classified = classifyCatalog(catalog, undefined, data);
  expect(classified.models.map(m => m.tier)).toEqual(["basic", "good", "good", "top", "basic", "good", "good", "new", "new"]);
  expect(classified.offers).toBe(catalog.offers);
  expect(makeChanges(catalog, classified).filter(c => c.type === "model_tier_changed")).toHaveLength(7);
});

it("замораживает уровни после смены версии и отправляет владельцу предупреждение", async () => {
  const previous = catalogSchema.parse(read("../data/catalog-v2.json"));
  const [old] = previous.models;
  const newModel = { ...old, id: "new-model", tier: "new" as const };
  const next = { ...previous, models: [{ ...old, tier: "basic" as const }, newModel] };
  const data = snapshot("6", { [old.id]: { index: 200 }, [newModel.id]: { index: 2 } });
  expect(classifyCatalog(next, previous, data).models).toEqual([old, newModel]);
  const warning = indexVersionWarning(data);
  expect(warning).toBe("AA сменил индекс на v6 — обновите qualityFloor");
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  expect(await notifyTelegram({ token: "test", chatId: "owner" }, [], previous, [], [], [], [], warning)).toBe(true);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ chat_id: "owner", text: warning });
});

it("сопоставляет имена и ID AA, даты, VL и уровни рассуждений", async () => {
  const models = [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "qwen3.8-27b", name: "Qwen3.8 27B" },
    { id: "nemotron-3.5-super", name: "Nemotron 3.5 Super VL" },
    { id: "custom-one", name: "Provider Model Pro" },
  ];
  const rows = [
    ["GLM-5.3-Flash Max", 27.7], ["GLM-5.3-Flash Minimal", 12],
    ["DeepSeek V4.1 Flash 1017 Max", 32.4], ["DeepSeek V4.1 Flash 0813 Non-reasoning", 10],
    ["Qwen3.8 27B Xhigh", 20.1], ["Nemotron 3.5 Super VL", 13.6],
    ["Provider Model Pro 0813 VL High", 11.99], ["Other Provider Model Pro", 99],
  ] as const;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    intelligence_index_version: "5", data: rows.map(([name, index]) => ({
      name, evaluations: { artificial_analysis_intelligence_index: index },
    })),
  })));
  const data = await fetchBenchmarks("test", models, now);
  expect(Object.fromEntries(Object.entries(data.models).map(([id, metrics]) => [id, metrics.index]))).toEqual({
    "glm-5.3-flash": 27.7, "deepseek-v4.1-flash": 32.4, "qwen3.8-27b": 20.1, "nemotron-3.5-super": 13.6,
    "custom-one": 11.99,
  });
});

it("сохраняет слабую новую модель вместе с оффером до окончания раздачи", () => {
  const observation = { providerId: "kilo", providerModelId: "weak-70b:free", confidence: "structured" as const,
    supportsTools: true, contextWindow: 131072, source: "https://ai-gateway.kilo.ai/api/v1/models" };
  const state = newState();
  const { catalog, tracks } = mergeCatalog(undefined, state, [{ id: "kilo", observations: [observation] }], options);
  const classified = classifyCatalog(catalog, undefined, snapshot("5", {}));
  expect(classified.models.find(model => model.id === "weak-70b")?.tier).toBe("basic");
  const next = mergeCatalog(classified, { ...state, tracks }, [{ id: "kilo", observations: [] }], options).catalog;
  expect(next.offers.find(offer => offer.modelId === "weak-70b")?.status).toBe("ended");
  expect(next.models.some(model => model.id === "weak-70b")).toBe(true);
});

it("каталог проходит строгую схему 0.1.5 и сохраняет семь старых провайдеров", () => {
  const raw = read("../data/catalog-v2.json");
  const previous = catalogSchema.parse(raw);
  const v2 = mergeCatalog(previous, newState(), registryBatches(), { ...options, now: previous.generatedAt }).catalog;
  for (const catalog of [raw, JSON.parse(JSON.stringify(v2))]) {
    const compatible = legacySchema.parse(catalog);
    expect(compatible.providers.some(p => p.id === "cloudflare")).toBe(false);
    expect(compatible.offers.some(o => o.providerId === "cloudflare")).toBe(false);
    const pollinations = { ...catalog.providers[0], extra: true };
    if (pollinations.auth.type === "cloudflare") pollinations.auth = { type: "none" };
    expect(legacySchema.safeParse({ ...catalog, providers: [pollinations, ...catalog.providers.slice(1)] }).success).toBe(false);
  }
  expect(catalogSchema.parse(legacyCatalog(v2)).providers).toHaveLength(7);
  expect(catalogSchema.parse(read("../data/catalog.json")).providers).toHaveLength(7);
});
