import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { fetchBenchmarks } from "../src/sources/artificialAnalysis.js";

const fixture = readFileSync(new URL("./fixtures/artificial-analysis-real.json", import.meta.url), "utf8");
const catalog = JSON.parse(readFileSync(new URL("../data/catalog.json", import.meta.url), "utf8"));

test("реальный ответ Artificial Analysis сопоставляется с каталогом", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } })));
  const result = await fetchBenchmarks("test", catalog.models, "2026-11-26T00:00:00.000Z");
  vi.unstubAllGlobals();
  expect(result.source.indexVersion).toBe("5");
  expect(result.models).toMatchObject({
    "kimi-k3.1-pro": { index: 46.6 },
    "deepseek-v4.1-flash": { index: 32.4, speed: 177.6 },
    "glm-5.3": { index: 31.6 },
    "glm-5.3-flash": { index: 27.7 },
    "nemotron-3-ultra": { index: 11.8 },
    "nemotron-3.5-lightning": { index: 5.5 },
    "gpt-oss-120b": { index: 3.8 },
    "minimax-m3": { index: 19 },
    "qwen3.8-27b": { index: 20.1 },
    "gemma-4-31b-it": { index: 4.4 },
  });
});
