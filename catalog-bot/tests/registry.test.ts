import { expect, it, vi } from "vitest";
import { watchedPages } from "../src/config.js";
import { LlmClient } from "../src/llm/client.js";
import { mergeCatalog } from "../src/merge.js";
import { registryBatches, registryPages } from "../src/registry/offers.js";
import { catalogSchema, legacyProviderIds, offerKey } from "../src/schema.js";
import { newState, stateSchema } from "../src/state.js";
import { processPage } from "../src/sources/watchPages.js";

const start = "2026-11-24T15:00:00Z";
const changedAt = "2026-11-25T15:00:00Z";
const reviewBy = "2026-12-08T00:00:00.000Z";
const options = (now: string) => ({ now, missingRuns: 6, retentionDays: 7, healthFailureThreshold: 2 });
const runcratePage = watchedPages[0];
const legacyIds = new Set<string>(legacyProviderIds.map(id => 'registry:' + id));
const registry = registryBatches().filter(batch => legacyIds.has(batch.id));
const target = (catalog: ReturnType<typeof mergeCatalog>["catalog"]) =>
  catalog.offers.find((offer) => offer.providerId === "runcrate" && offer.providerModelId === "zai-org/GLM-5.3")!;

function mockWatchClient(offers: unknown[]) {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({
    choices: [{ message: { content: JSON.stringify({ offers }) } }],
  })));
  return new LlmClient({
    baseUrl: "https://api.deepseek.com", key: "test-key", model: "deepseek-flash", maxTokens: 150000,
  }, fetcher);
}

it("добавляет 13 курируемых раздач в offers без LLM", () => {
  const { catalog } = mergeCatalog(undefined, newState(), registry, options(start));
  expect(catalogSchema.parse(catalog).schemaVersion).toBe(1);
  expect(catalog.offers).toHaveLength(13);
  expect(catalog.candidates).toEqual([]);
  for (const offer of catalog.offers) {
    expect(offer).toMatchObject({
      confidence: "page", status: "active", verifiedAt: "2026-11-24T00:00:00Z", reviewBy,
      sources: ["registry:" + offer.providerId],
    });
  }
  expect(catalog.offers.find((offer) => offer.providerModelId === "qwen/qwen3.8-27b")?.contextWindow).toBe(131072);
  expect(catalog.offers.filter((offer) => offer.providerId === "modelscope")).toHaveLength(4);
});

it("читает состояние старого формата и после reviewBy оставляет раздачи в offers со статусом unverified", () => {
  const { pageChecks: _pageChecks, ...legacy } = newState();
  const state = stateSchema.parse(legacy);
  const first = mergeCatalog(undefined, state, registry, options(start));
  state.tracks = first.tracks;
  const next = mergeCatalog(first.catalog, state, registry, options(reviewBy));
  expect(next.catalog.offers).toHaveLength(13);
  expect(next.catalog.offers.every((offer) => offer.status === "unverified")).toBe(true);
  expect(next.changes.every((event) => event.type === "offer_changed")).toBe(true);
});

it("замечает смену страницы без LLM и сохраняет состояние до подтверждения", async () => {
  const state = newState();
  state.pageChecks["page:runcrate"] = { hash: registryPages.runcrate.hash, checkedAt: start, changedAt: start };
  const first = mergeCatalog(undefined, state, registry, options(start));
  state.tracks = first.tracks;
  const key = offerKey(target(first.catalog));
  const oldHealth = { checkedAt: start, verifiedAt: start, consecutiveFailures: 0 };
  const pending = await processPage(runcratePage, "Опубликованы новые условия", undefined, state, changedAt);
  const next = mergeCatalog(first.catalog, state, [...registry, pending], options(changedAt), { [key]: oldHealth });
  expect(next.catalog.offers.filter((offer) => offer.status === "unverified")).toHaveLength(5);
  expect(target(next.catalog).sources).toEqual(["registry:runcrate"]);
  state.tracks = next.tracks;
  const later = "2026-11-26T15:00:00Z";
  expect(target(mergeCatalog(next.catalog, state, registry, options(later)).catalog).status).toBe("unverified");
  const verified = { checkedAt: later, verifiedAt: later, consecutiveFailures: 0 };
  const restored = mergeCatalog(next.catalog, state, registry, options(later), { [key]: verified });
  expect(target(restored.catalog)).toMatchObject({ status: "active", lastVerified: later, reviewBy });
});

it("применяет актуальный результат watchPages к точному ID и сохраняет его без LLM при том же хеше", async () => {
  const state = newState();
  const text = "В новых условиях Runcrate GLM 5.3 получает 15 бесплатных запросов в минуту";
  const client = mockWatchClient([{
    providerId: "runcrate", providerModelId: "glm-5.3", free: true, promo: false, expiresAt: null,
    limits: { rpm: 15 }, supportsTools: false, contextWindow: 32768,
  }]);
  const first = await processPage(runcratePage, text, client, state, changedAt);
  const confirmed = mergeCatalog(undefined, state, [...registry, first], options(changedAt));
  expect(target(confirmed.catalog)).toMatchObject({
    status: "active", contextWindow: 32768, supportsTools: false, limits: { rpm: 15 },
    sources: [runcratePage.url, "registry:runcrate"], reviewBy,
  });
  expect(confirmed.catalog.offers.filter((offer) => offer.providerId === "runcrate")).toHaveLength(5);
  state.tracks = confirmed.tracks;
  const cached = await processPage(runcratePage, text, undefined, state, reviewBy);
  const afterReview = mergeCatalog(confirmed.catalog, state, [...registry, cached], options(reviewBy));
  expect(target(afterReview.catalog).status).toBe("active");
  expect(afterReview.catalog.offers.filter((offer) => offer.status === "active")).toHaveLength(1);
  state.tracks = afterReview.tracks;
  const newer = "2026-12-09T00:00:00Z";
  const pending = await processPage(runcratePage, "Условия снова изменились", undefined, state, newer);
  const stale = mergeCatalog(afterReview.catalog, state, [...registry, pending], options(newer));
  expect(target(stale.catalog)).toMatchObject({
    status: "unverified", sources: ["registry:runcrate"], contextWindow: 1048576,
  });
});

it("не считает подтверждением новый разбор страницы, в котором раздача исчезла", async () => {
  const state = newState();
  const known = [{ providerId: "runcrate", providerModelId: "zai-org/GLM-5.3", free: true, promo: false, expiresAt: null }];
  const existing = await processPage(runcratePage, "GLM 5.3 бесплатно", mockWatchClient(known), state, start);
  const first = mergeCatalog(undefined, state, [...registry, existing], options(start));
  state.tracks = first.tracks;
  const missing = await processPage(runcratePage, "Изменился список раздач", mockWatchClient([]), state, changedAt);
  const next = mergeCatalog(first.catalog, state, [...registry, missing], options(changedAt));
  expect(target(next.catalog)).toMatchObject({ status: "unverified", sources: ["registry:runcrate"] });
});
