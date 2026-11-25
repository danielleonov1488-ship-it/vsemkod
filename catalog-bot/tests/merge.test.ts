import { describe, expect, it } from "vitest";
import { catalogChanged, mergeCatalog, stableJson } from "../src/merge.js";
import { catalogSchema, offerKey } from "../src/schema.js";
import { newState } from "../src/state.js";
import type { Observation, SourceResult } from "../src/sources/common.js";

const start = "2026-11-24T00:00:00Z";
const later = (hours: number) => new Date(Date.parse(start) + hours * 3600000).toISOString();
const options = (now = start) => ({ now, missingRuns: 6, retentionDays: 7, healthFailureThreshold: 2 });
const known: Observation = {
  providerId: "openrouter", providerModelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
  confidence: "structured", source: "openrouter:/api/v1/models", supportsTools: true,
};
const unknown: Observation = { ...known, providerModelId: "example/model:free", suggestedTier: "good", suggestedDescription: "Быстрая модель" };
const batch = (...observations: Observation[]): SourceResult => ({ id: "openrouter", observations });

describe("слияние", () => {
  it("добавляет известную модель и оставляет неизвестную кандидатом", () => {
    const { catalog, changes } = mergeCatalog(undefined, newState(), [batch(known, unknown)], options());
    expect(catalog.offers[0]).toMatchObject({ modelId: "nemotron-3-ultra", status: "active", firstSeen: start });
    expect(catalog.candidates[0]).toMatchObject({ status: "unverified", suggestedTier: "good" });
    expect(catalog.models.some(({ id }) => id === "model")).toBe(false);
    expect(changes.map(({ type }) => type)).toEqual(["offer_added", "candidate_added"]);
  });

  it("держит предложение пять успешных пропусков, на шестом завершает, через семь дней убирает", () => {
    const state = newState();
    let result = mergeCatalog(undefined, state, [batch(known)], options());
    for (let n = 1; n <= 5; n++) {
      state.tracks = result.tracks;
      result = mergeCatalog(result.catalog, state, [batch()], options(later(n)));
      expect(result.catalog.offers[0].status).toBe("active");
      expect(result.catalog.offers[0].lastSeen).toBe(start);
    }
    state.tracks = result.tracks;
    let next = mergeCatalog(result.catalog, state, [batch()], options(later(6)));
    expect(next.catalog.offers[0].status).toBe("ended");
    expect(next.changes[0].type).toBe("offer_ended");
    state.tracks = next.tracks;
    next = mergeCatalog(next.catalog, state, [batch()], options(later(6 + 7 * 24)));
    expect(next.catalog.offers).toHaveLength(0);
  });

  it("не считает пропуском ошибку источника, неполный результат или запуск другого источника", () => {
    const state = newState();
    const first = mergeCatalog(undefined, state, [batch(known)], options());
    state.tracks = first.tracks;
    const broken = [{ id: "openrouter", observations: [], complete: false }, { id: "kilo", observations: [] }];
    const next = mergeCatalog(first.catalog, state, broken, { ...options(later(1)), missingRuns: 1 });
    expect(next.catalog.offers[0].status).toBe("active");
    expect(next.tracks[offerKey(known)].evidence.openrouter.missedRuns).toBe(0);
  });

  it("завершает акцию по дате и убирает её через семь дней даже при повторном наблюдении", () => {
    const state = newState();
    const promo = { ...known, promo: true, expiresAt: later(1) };
    const first = mergeCatalog(undefined, state, [batch(promo)], options());
    state.tracks = first.tracks;
    const next = mergeCatalog(first.catalog, state, [batch(promo)], options(later(1)));
    expect(next.catalog.offers[0].status).toBe("ended");
    state.tracks = next.tracks;
    expect(mergeCatalog(next.catalog, state, [batch(promo)], options(later(1 + 7 * 24))).catalog.offers).toHaveLength(0);
    expect(mergeCatalog(next.catalog, state, [batch({ ...promo, expiresAt: null, promo: false })], options(later(2)))
      .catalog.offers[0]).toMatchObject({ status: "active", expiresAt: null, promo: false });
  });

  it("подтверждает кандидата из новостей через структурированный источник или health-check", () => {
    const state = newState();
    const news: SourceResult = { id: "hn", observations: [{ ...known, confidence: "news", source: "https://news.ycombinator.com/item?id=1" }] };
    const first = mergeCatalog(undefined, state, [news], options());
    expect(first.catalog.offers).toHaveLength(0);
    expect(first.catalog.candidates[0].status).toBe("unverified");
    state.tracks = first.tracks;
    const confirmed = mergeCatalog(first.catalog, state, [batch(known)], options(later(1)));
    expect(confirmed.catalog.offers[0]).toMatchObject({ firstSeen: start, confidence: "structured" });
    expect(confirmed.catalog.candidates).toHaveLength(0);
    expect(confirmed.changes[0].type).toBe("offer_added");
    const healthy = mergeCatalog(first.catalog, state, [], options(later(1)), {
      [offerKey(known)]: { verifiedAt: later(1), checkedAt: later(1), consecutiveFailures: 0 },
    });
    expect(healthy.catalog.offers[0]).toMatchObject({ confidence: "news", lastVerified: later(1) });
  });

  it("сохраняет health-метку при сбоях и меняет статус после двух ошибок", () => {
    const state = newState();
    const first = mergeCatalog(undefined, state, [batch(known)], options());
    state.tracks = first.tracks;
    const next = mergeCatalog(first.catalog, state, [batch(known)], options(later(1)), {
      [offerKey(known)]: { verifiedAt: start, checkedAt: later(1), consecutiveFailures: 2 },
    });
    expect(next.catalog.offers[0]).toMatchObject({ status: "degraded", lastVerified: start });
    expect(next.changes[0].type).toBe("offer_changed");
  });

  it("не применяет срок и лимиты из новости к раздаче, активной по данным API", () => {
    const state = newState();
    const news: SourceResult = { id: "hn", observations: [{
      ...known, confidence: "news", source: "https://news.ycombinator.com/item?id=1",
      promo: true, expiresAt: later(1), limits: { rpd: 7 },
    }] };
    const first = mergeCatalog(undefined, state, [news], options());
    state.tracks = first.tracks;
    const next = mergeCatalog(first.catalog, state, [batch(known)], options(later(2)));
    expect(next.catalog.offers[0]).toMatchObject({
      status: "active", promo: false, expiresAt: null, limits: { rpd: 50 },
    });
  });

  it("сортирует выход и пропускает перезапись при изменении generatedAt и lastSeen", () => {
    const state = newState();
    const first = mergeCatalog(undefined, state, [batch(known, unknown)], options());
    const opposite = mergeCatalog(undefined, state, [batch(unknown, known)], options());
    expect(stableJson(first.catalog)).toBe(stableJson(opposite.catalog));
    expect(first.catalog.providers.map(({ id }) => id)).toEqual(["groq", "kilo", "modelscope", "numes", "openrouter", "runcrate", "zai"]);
    expect(stableJson({ z: 1, a: 2 })).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
    state.tracks = first.tracks;
    const next = mergeCatalog(first.catalog, state, [batch(known, unknown)], options(later(1)));
    expect(next.catalog.offers[0].lastSeen).toBe(later(1));
    expect(catalogChanged(first.catalog, next.catalog)).toBe(false);
    expect(next.changes).toEqual([]);
  });
});

it("валидирует каталог и запрещает непроверенные новости в offers", () => {
  const { catalog } = mergeCatalog(undefined, newState(), [batch(known)], options());
  expect(catalogSchema.safeParse(catalog).success).toBe(true);
  expect(catalogSchema.safeParse({ ...catalog, schemaVersion: 2 }).success).toBe(false);
  const offers = [{ ...catalog.offers[0], confidence: "news", lastVerified: null }];
  expect(catalogSchema.safeParse({ ...catalog, offers }).success).toBe(false);
  expect(catalogSchema.safeParse({ ...catalog, models: [] }).success).toBe(false);
});
