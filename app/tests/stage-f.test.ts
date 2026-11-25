import { afterEach, describe, expect, it, vi } from "vitest";
import bundled from "../resources/catalog.json";
import { catalogSchema } from "../src/shared/catalog-schema";
import { ProviderHealth } from "../src/main/router/health";
import { Router } from "../src/main/router";
import { day, localQuota, parseRateHeaders, providerQuota } from "../src/main/router/quotas";
import { providerCachePercent, readReplyUsage } from "../src/main/router/reply-usage";
import { cachePercent, modelDisplayName, replySpeed } from "../src/shared/usage";

const now = Date.UTC(2026, 10, 25, 12);
const hour = 3_600_000;
const catalog = catalogSchema.parse(bundled);
afterEach(() => vi.restoreAllMocks());

describe("Квоты провайдеров", () => {
  it("разбирает заголовки запросов и токенов, включая нулевой остаток", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "2m59.56s", "x-ratelimit-limit-tokens": "8000",
      "x-ratelimit-remaining-tokens": "7600", "x-ratelimit-reset-tokens": "1s25ms"
    });
    expect(parseRateHeaders(headers, now)).toEqual({ at: now,
      requests: { limit: 1000, remaining: 0, resetAt: now + 179_560 },
      tokens: { limit: 8000, remaining: 7600, resetAt: now + 1025 }
    });
  });

  it("разбирает общий стиль заголовков и время сброса в секундах и миллисекундах", () => {
    const reset = now + 34 * 60_000;
    for (const value of [String(reset), String(reset / 1000), "2040", new Date(reset).toISOString()]) {
      const headers = new Headers({ "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "37", "X-RateLimit-Reset": value });
      const parsed = parseRateHeaders(headers, now);
      expect(parsed?.requests).toEqual({ limit: 50, remaining: 37, resetAt: reset });
      expect(providerQuota("openrouter", { rpd: 50 }, parsed, [now], now)?.source).toBe("headers");
      expect(providerQuota("openrouter", { rpd: 50 }, parsed, [now], reset)).toMatchObject({ remaining: 49, source: "local" });
    }
    expect(parseRateHeaders(new Headers({ "X-RateLimit-Limit": "-10" }), now)).toBeUndefined();
  });

  it("считает скользящий час и ближайшее пополнение", () => {
    const times = [now - hour, now - hour + 1000, now - 200, now + 1];
    expect(localQuota(times, { rph: 2 }, now)).toEqual({ limit: 2, remaining: 0, resetAt: now + 1000, period: "hour", source: "local" });
    expect(localQuota(times.slice(0, -1), { rph: 2 }, now + 1000)?.remaining).toBe(1);
    expect(localQuota([], { rph: 200 }, now)).toMatchObject({ remaining: 200, resetAt: undefined });
  });

  it("обнуляет дневное окно ровно в полночь UTC", () => {
    const midnight = Math.floor(now / day) * day;
    const times = [midnight - 1, midnight, now];
    expect(localQuota(times, { rpd: 50 }, now)).toMatchObject({ remaining: 48, resetAt: midnight + day, period: "day" });
    expect(localQuota(times, { rpd: 50 }, midnight + day)).toMatchObject({ remaining: 50 });
  });

  it("читает кредиты OpenRouter один раз за десять минут", async () => {
    let time = now;
    const health = new ProviderHealth(undefined, () => time);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      data: { usage: 2.5, limit: 10, limit_remaining: 7.5, is_free_tier: false, label: "ignored" }
    }));
    const router = new Router({ catalog: () => catalog, health, key: id => id === "openrouter" ? "test-key" : undefined });
    router.stats();
    router.stats();
    await vi.waitFor(() => expect(router.stats().openrouter?.credits).toEqual({ usage: 2.5, limit: 10, remaining: 7.5, isFreeTier: false }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({ headers: { authorization: "Bearer test-key" } }));
    time += 599_999;
    router.stats();
    expect(fetch).toHaveBeenCalledTimes(1);
    time++;
    router.stats();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("Статистика ответа", () => {
  it("считает скорость от первого токена и включает рассуждения", () => {
    expect(replySpeed(60, 24, 0, 1200, 3200)).toEqual({ tokensPerSecond: 42, firstTokenMs: 1200 });
    expect(replySpeed(60, 24, 0, undefined, 3200)).toBeUndefined();
    expect(replySpeed(60, 24, 0, 3200, 3200)).toBeUndefined();
  });

  it("различает нулевое попадание в кэш и отсутствующее поле", () => {
    expect(cachePercent(13, 87)).toBe(87);
    expect(cachePercent(13, undefined)).toBeUndefined();
    expect(cachePercent(0, 0)).toBeUndefined();
    expect(providerCachePercent({ input: 13, cache: { read: 87 } })).toBe(87);
    expect(providerCachePercent({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 87 } })).toBe(87);
    expect(providerCachePercent({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } })).toBe(0);
    expect(providerCachePercent({ prompt_tokens: 100 })).toBeUndefined();
  });

  it("читает финальную статистику SSE, разрезанную между чанками", () => {
    const observer = readReplyUsage(true);
    const encode = (text: string) => new TextEncoder().encode(text);
    observer.push(encode('data: {"usage":null}\r\n\r'));
    observer.push(encode('\ndata: {"usage":{"prompt_tokens":100,"prompt_tokens_'));
    observer.push(encode('details":{"cached_tokens":87}}}\r\n\r\ndata: [DONE]\n\n'));
    expect(observer.finish()).toBe(87);
  });

  it("предпочитает имя каталога и очищает префикс и суффикс", () => {
    expect(modelDisplayName("nvidia/upstream", "NVIDIA: Nemotron 3.5 Lightning (free)")).toBe("Nemotron 3.5 Lightning");
    expect(modelDisplayName("Llama (free)")).toBe("Llama");
    expect(modelDisplayName("DeepSeek V4 (Preview)")).toBe("DeepSeek V4 (Preview)");
  });
});
