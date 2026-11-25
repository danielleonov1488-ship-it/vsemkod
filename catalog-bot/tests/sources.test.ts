import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchModel } from "../src/match.js";
import { parseOpenRouter } from "../src/sources/openrouter.js";
import { fetchNumes } from "../src/sources/numes.js";
import { htmlText, normalizeText } from "../src/sources/watchPages.js";

afterEach(() => vi.unstubAllGlobals());

describe("реестр моделей", () => {
  it.each([
    ["moonshotai/Kimi_K3_1_Pro:free", "kimi-k3.1-pro"],
    ["KimiK3.1Pro", "kimi-k3.1-pro"],
    ["z-ai/glm-5.3", "glm-5.3"],
    ["zai/GLM_5_3_FLASH", "glm-5.3-flash"],
    ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "deepseek-v4.1-flash"],
    ["nvidia/nemotron-3-ultra-550b-a55b:free", "nemotron-3-ultra"],
    ["nvidia/nemotron-3.5-super-vl:free", "nemotron-3.5-super"],
    ["Qwen/Qwen3.8-2.4T-A95B", "qwen3.8"],
    ["Qwen/Qwen3.8-Flash", "qwen3.8-flash"],
    ["qwen/Qwen3.8-27B", "qwen3.8-27b"],
    ["openai/gpt_oss_120b", "gpt-oss-120b"],
    ["openai/gpt-oss-20b", "gpt-oss-20b"],
  ])("сопоставляет %s", (providerId, canonicalId) => {
    expect(matchModel(providerId)?.id).toBe(canonicalId);
  });

  it.each(["z-ai/glm-5.3-flashx", "openai/gpt-oss-safeguard-20b", "dealignai/deepseek-v4.1-flash-uncensored-fp8"])(
    "сохраняет отдельную модель %s кандидатом", (id) => expect(matchModel(id)).toBeUndefined(),
  );
});

it("читает бесплатные текстовые модели OpenRouter по нулевым ценам или :free", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/openrouter.json", import.meta.url), "utf8"));
  const observations = parseOpenRouter(fixture);
  expect(observations.map((entry) => entry.providerModelId)).toEqual([
    "nvidia/nemotron-3-ultra-550b-a55b:free", "openai/gpt-oss-120b", "example/model:free",
  ]);
  expect(observations[0]).toMatchObject({ contextWindow: 1000000, supportsTools: true, confidence: "structured" });
  expect(observations[1].supportsTools).toBe(false);
  expect(() => parseOpenRouter({ data: [{ slug: "wrong" }] })).toThrow();
});

it("читает все страницы публичного каталога Numes и использует совместимый ID", async () => {
  const row = { id: "uuid", compatible_request_id: "moonshotai/kimi-k3.1-pro:free", supported_parameters: ["tools"] };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ data: [row], meta: { next_cursor: "page-2" } }))
    .mockResolvedValueOnce(Response.json({
      data: [
        row,
        { compatible_request_id: "z-ai/glm-5.3:free" },
        { compatible_request_id: "example/private:free:org-team" },
        { compatible_request_id: "example/paid" },
      ],
      meta: { next_cursor: null },
    }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await fetchNumes();
  expect(result.observations.map(({ providerModelId }) => providerModelId)).toEqual([
    row.compatible_request_id, "z-ai/glm-5.3:free",
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: "omit" });
});

it("использует ключ только для документированного API Numes", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [
    { id: "z-ai/glm-5.3:free" }, { id: "z-ai/glm-5.3", pricing: { prompt: "0", completion: "0" } },
  ] }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await fetchNumes("test-key")).observations).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith("https://api.numes.ai/api/v1/models", expect.objectContaining({
    headers: { Authorization: "Bearer test-key" },
  }));
});

it("нормализует видимый текст страницы тарифов", () => {
  expect(normalizeText(htmlText("<main><script>volatile</script><p>Free&nbsp;models</p><p>A &amp; B</p></main>")))
    .toBe("Free models\nA & B");
});
