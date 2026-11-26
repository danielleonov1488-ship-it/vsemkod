import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { stableJson } from "../src/merge.js";
import { notifyTelegram } from "../src/publish.js";
import { mergeProviderRadar, mergeRadar, radarChanged } from "../src/radar.js";
import { radarSchema } from "../src/schema.js";
import { fetchFreeListProviders, parseFreeList, shouldCheckFreeList } from "../src/sources/freeList.js";
import { newState, stateSchema } from "../src/state.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/awesome-free-llm-apis.json", import.meta.url), "utf8"));
const providers = parseFreeList(fixture);
const now = "2026-11-26T00:00:00.000Z";
const later = "2026-11-27T00:00:00.000Z";

afterEach(() => vi.unstubAllGlobals());

it("читает провайдеров и категории из data.json, дубли схлопывает", () => {
  const doubled = { ...fixture, providers: [...fixture.providers, { name: "groq", category: "inference_provider" }] };
  expect(parseFreeList(doubled).map(({ name, section }) => [name, section])).toEqual([
    ["Cohere", "provider_api"], ["Google Gemini", "provider_api"], ["groq", "inference_provider"], ["OpenRouter", "inference_provider"],
  ]);
  expect(providers.every(({ url }) => url.startsWith("https://"))).toBe(true);
});

it("первую выборку использует как базу, а новые записи сохраняет рядом с Zen", async () => {
  const { freeListProviders: _freeListProviders, ...oldState } = newState();
  const state = stateSchema.parse(oldState);
  const initial = mergeRadar(undefined, [], now, {}).radar;
  const first = mergeProviderRadar(initial, state.freeListProviders, providers.slice(0, 2), now);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  const config = { token: "test-token", chatId: "test-chat" };
  const catalog = { schemaVersion: 1 as const, generatedAt: now, models: [], providers: [], offers: [], candidates: [] };
  expect(first.radar).toBe(initial);
  expect(first.added).toEqual([]);
  expect(await notifyTelegram(config, [], catalog, [], first.added)).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();

  const next = mergeProviderRadar(initial, providers.slice(0, 2), providers, later);
  expect(next.added.map(({ name }) => name)).toEqual(["Groq", "OpenRouter"]);
  expect(next.radar).toBeDefined();
  expect(radarChanged(initial, next.radar!)).toBe(true);
  const validated = radarSchema.parse(JSON.parse(stableJson(next.radar)));
  expect(validated.providers).toEqual(next.added);
  const zen = mergeRadar(validated, [], later, {});
  expect(zen.radar.providers).toEqual(next.added);
  expect(mergeProviderRadar(zen.radar, providers.slice(0, 2), providers, later).added).toEqual([]);

  expect(await notifyTelegram(config, [], catalog, [], next.added)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).text).toContain(
    "Новый бесплатный провайдер в awesome-free-llm-apis: Groq (инференс-провайдер)",
  );
});

it("проверяет список раз в сутки и не подменяет старый список пустым при ошибке", async () => {
  expect(shouldCheckFreeList(now)).toBe(true);
  expect(shouldCheckFreeList("2026-11-26T23:59:59.999Z", now)).toBe(false);
  expect(shouldCheckFreeList(later, now)).toBe(true);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ providers: [] }));
  vi.stubGlobal("fetch", fetcher);
  await expect(fetchFreeListProviders()).rejects.toThrow("HTTP 404");
  await expect(fetchFreeListProviders()).rejects.toThrow("В data.json не найдено провайдеров");
});
