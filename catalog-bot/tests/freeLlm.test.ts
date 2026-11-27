import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { mergeCatalog, stableJson } from "../src/merge.js";
import { notifyTelegram } from "../src/publish.js";
import { mergeFreeLlmRadar, mergeProviderRadar, mergeRadar, radarChanged } from "../src/radar.js";
import { models } from "../src/registry/models.js";
import { registryBatches } from "../src/registry/offers.js";
import { providersUnderReview } from "../src/registry/providers.js";
import { radarSchema } from "../src/schema.js";
import { fetchFreeLlm, freeLlmModelMatcher, matchFreeLlm, parseFreeLlm, shouldCheckFreeLlm } from "../src/sources/freeLlm.js";
import { fetchRegistryModels } from "../src/sources/registryModels.js";
import { newState, stateSchema } from "../src/state.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL("./fixtures/" + name + ".json", import.meta.url), "utf8"));
const snapshot = fixture("free-llm");
const now = "2026-11-26T00:00:00.000Z";
const later = "2026-11-27T00:00:00.000Z";
const { catalog } = mergeCatalog(undefined, newState(), registryBatches(), {
  now, missingRuns: 6, retentionDays: 7, healthFailureThreshold: 2,
});
const selected = parseFreeLlm(snapshot);
const [cloudflare] = selected;
const unregistered = { ...cloudflare, slug: "fixture-top", baseUrl: "https://fixture-top.example.com/v1" };
const { radar: candidates } = matchFreeLlm([unregistered, ...selected], catalog);

afterEach(() => vi.unstubAllGlobals());

it("фильтрует снимок по бесплатному доступу, транспортному URL, регистрации, типу и denylist", () => {
  expect(selected.map(({ slug }) => slug)).toEqual(["cloudflare-workers-ai", "freeinference", "groq-cloud", "ovh-ai", "runcrate"]);
  expect(selected.find(({ slug }) => slug === "groq-cloud")?.models).toEqual(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
  expect(selected.find(({ slug }) => slug === "runcrate")?.models).toEqual([]);
  const qualified = snapshot.providers.find(({ slug }: { slug: string }) => slug === "ovh-ai");
  const only = (changes: Record<string, unknown>) => parseFreeLlm({ providers: [{ ...qualified, ...changes }] });
  expect(only({ signup_requirement: "credit_card" })).toEqual([]);
  expect(only({ openai_base_url: "http://example.com/v1" })).toEqual([]);
  expect(only({ openai_compatible: false })).toEqual([]);
  expect(only({ type: "Local" })).toEqual([]);
  expect(only({ slug: "pollinations" })).toEqual([]);
  expect(only({ openai_base_url: null, signup_requirement: "no" })[0]).toMatchObject({
    baseUrl: providersUnderReview["ovh-ai-endpoints"].baseUrl, signup: "no",
  });
});

it("узнаёт варианты ID, сохраняя различие между версиями моделей", () => {
  const match = freeLlmModelMatcher(models);
  expect([
    "DeepSeek-V4.1-Flash-1017", "deepseek-v4.1-flash:free", "deepseek-ai/deepseek-v4.1-flash-0731-free",
    "accounts/fireworks/models/glm-5p3", "z-ai/glm-5.3-flash", "zai-org/GLM-5.3-Flash",
    "nvidia/nemotron-3-ultra-550b-a55b", "deepseek-v4-flash", "minimaxai/minimax-m3.1-flash",
  ].map(match)).toEqual([
    "deepseek-v4.1-flash", "deepseek-v4.1-flash", "deepseek-v4.1-flash",
    "glm-5.3", "glm-5.3-flash", "glm-5.3-flash", "nemotron-3-ultra", "deepseek-v4-flash", undefined,
  ]);
});

it("сортирует кандидатов по top-моделям и показывает пропуски у известных провайдеров в журнале", () => {
  const { radar, possible } = matchFreeLlm(selected, catalog);
  expect(radar.map(({ slug }) => slug)).toEqual(["freeinference"]);
  expect(radar[0].models).toEqual([
    { id: "deepseek-v4-flash", catalogModelId: "deepseek-v4-flash" },
    { id: "glm-5.3-flash", catalogModelId: "glm-5.3-flash" },
  ]);
  expect(possible).toEqual([
    { providerId: "cloudflare", id: "@cf/qwen/qwen3.8-27b", catalogModelId: "qwen3.8-27b" },
    { providerId: "ovh-ai-endpoints", id: "DeepSeek-V4.1-Flash-1017", catalogModelId: "deepseek-v4.1-flash" },
    { providerId: "ovh-ai-endpoints", id: "Qwen3.8-27B", catalogModelId: "qwen3.8-27b" },
  ]);
  const missingGroq = matchFreeLlm(selected, { ...catalog, offers: catalog.offers.filter(({ providerId }) => providerId !== "groq") });
  expect(missingGroq.possible.filter(({ providerId }) => providerId === "groq")).toHaveLength(2);
  const basicOnly = { ...selected[0], models: ["openai/gpt-oss-20b"] };
  expect(matchFreeLlm([basicOnly], catalog).radar).toEqual([]);
  const goodOnly = { ...basicOnly, slug: "aaa-good", baseUrl: "https://aaa-good.example.com/v1", models: ["glm-5.3-flash"] };
  expect(matchFreeLlm([goodOnly, unregistered], catalog).radar.map(({ slug }) => slug)).toEqual([
    "fixture-top", "aaa-good",
  ]);
  expect(catalog.providers.map(({ id }) => id)).not.toContain("ovh-ai-endpoints");
  expect(catalog.providers.map(({ id }) => id)).toContain("nvidia-nim");
});

it("сохраняет данные рядом с другими радарами и сообщает о каждом новом провайдере один раз", async () => {
  const zen = mergeRadar(undefined, [], now, {}).radar;
  const first = mergeFreeLlmRadar(zen, candidates.slice(0, 1), now);
  expect(first.added).toEqual([]);
  expect(radarChanged(zen, first.radar)).toBe(true);
  const firstRadar = radarSchema.parse(JSON.parse(stableJson(first.radar)));
  expect(firstRadar.freeLlm).toEqual([{ ...candidates[0], firstSeen: now }]);
  const known = [{ name: "Groq", url: "https://groq.com", section: "provider_api" as const }];
  const current = [...known, { ...known[0], name: "Cohere" }];
  const withOtherSources = mergeProviderRadar(mergeRadar(firstRadar, [], later, {}).radar, known, current, later).radar;
  expect(withOtherSources?.freeLlm).toEqual(firstRadar.freeLlm);
  const state = stateSchema.parse({ ...newState(), freeLlmCheckedAt: now, freeLlmFirstSeen: first.firstSeen });
  const next = mergeFreeLlmRadar(withOtherSources, candidates, later, state.freeLlmFirstSeen);
  expect(next.radar.providers).toMatchObject([{ name: "Cohere" }]);
  expect(next.added).toEqual([{ ...candidates[1], firstSeen: later }]);
  const missing = mergeFreeLlmRadar(next.radar, [], later, next.firstSeen);
  const back = mergeFreeLlmRadar(missing.radar, candidates, later, missing.firstSeen);
  expect(back.added).toEqual([]);
  expect(back.radar.freeLlm).toEqual(next.radar.freeLlm);
  expect(radarChanged(next.radar, back.radar)).toBe(false);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  const telegram = { token: "test-token", chatId: "test-chat" };
  expect(await notifyTelegram(telegram, [], catalog, [], [], first.added)).toBe(false);
  expect(await notifyTelegram(telegram, [], catalog, [], [], next.added)).toBe(true);
  expect(await notifyTelegram(telegram, [], catalog, [], [], back.added)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).text).toBe(
    "Free-LLM: DeepSeek V4 Flash, GLM 5.3 Flash бесплатно у " + candidates[1].provider + " (" +
    (candidates[1].signup === "no" ? "без регистрации" : "с регистрацией") + ") — кандидат в каталог",
  );
  const empty = mergeFreeLlmRadar(zen, [], now);
  expect(radarChanged(zen, empty.radar)).toBe(true);
  expect(mergeFreeLlmRadar(empty.radar, candidates, later, empty.firstSeen).added).toHaveLength(2);
});

it("запрашивает снимок после 20 часов и возвращает ошибку источника при сбое сети", async () => {
  expect(shouldCheckFreeLlm(now, newState().freeLlmCheckedAt)).toBe(true);
  expect(shouldCheckFreeLlm("2026-11-26T19:59:59.999Z", now)).toBe(false);
  expect(shouldCheckFreeLlm("2026-11-26T20:00:00.000Z", now)).toBe(false);
  expect(shouldCheckFreeLlm("2026-11-26T20:00:00.001Z", now)).toBe(true);
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(Response.json(snapshot));
  vi.stubGlobal("fetch", fetcher);
  await expect(fetchFreeLlm()).rejects.toThrow("fetch failed");
  await expect(fetchFreeLlm()).resolves.toEqual(selected);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe("https://raw.githubusercontent.com/nejib1/Free-LLM/main/router/catalog.snapshot.json");
});

it.each([
  ["nvidia-nim", ["nvidia/nemotron-3-ultra-550b-a55b", "z-ai/glm-5.3-flash"], ["nemotron-3-ultra", "glm-5.3-flash"]],
  ["ovh-ai-endpoints", ["DeepSeek-V4.1-Flash-1017", "Qwen3.8-27B"], ["deepseek-v4.1-flash", "qwen3.8-27b"]],
] as const)("читает официальный /models провайдера %s", async (id, rawIds, matchedIds) => {
  const provider = providersUnderReview[id];
  const fetcher = vi.fn().mockResolvedValue(Response.json(fixture(id + "-models")));
  vi.stubGlobal("fetch", fetcher);
  const ids = await fetchRegistryModels(id);
  expect(ids).toEqual(expect.arrayContaining([...rawIds]));
  expect(ids.map(freeLlmModelMatcher(models))).toEqual(expect.arrayContaining([...matchedIds]));
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(provider.baseUrl + "/models", expect.not.objectContaining({ headers: expect.anything() }));
  expect(provider.auth.type).toBe("manual_key");
  expect(provider.keyPageUrl).toMatch(/^https:\/\//);
  expect(provider.freeLimits.note).toBeTruthy();
});
