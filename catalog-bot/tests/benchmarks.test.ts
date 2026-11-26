import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { stableJson } from "../src/merge.js";
import {
  benchmarksChanged, benchmarksSchema, fetchBenchmarks, shouldRefreshBenchmarks,
} from "../src/sources/artificialAnalysis.js";

const page = JSON.parse(readFileSync(new URL("./fixtures/artificial-analysis.json", import.meta.url), "utf8"));
const hour = 60 * 60 * 1000;
const start = Date.UTC(2026, 10, 26);
const date = (elapsed = 0) => new Date(start + elapsed).toISOString();

afterEach(() => vi.unstubAllGlobals());

it("читает страницы по схеме AA и публикует метрики варианта с наибольшим исходным индексом", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(page))
    .mockResolvedValueOnce(Response.json({
      intelligence_index_version: "5",
      pagination: { page: 2, total_pages: 2 },
      data: [
        {
          name: "OpenAI gpt-oss-120b (high)",
          model_creator: { name: "OpenAI" },
          evaluations: { artificial_analysis_intelligence_index: 62.14 },
          performance_v3: { mean_output_tokens_per_second: 180.44, mean_time_to_first_token_seconds: null },
        },
        {
          name: "Kimi K3.1 Pro",
          evaluations: null,
          performance_v3: { mean_time_to_first_token_seconds: 0.524 },
        },
        { slug: "DeepSeek-AI/DeepSeek_V4.1_Flash" },
        { slug: "nvidia/nemotron-3-ultra-550b-a55b", evaluations: { artificial_analysis_intelligence_index: 10 } },
        { name: "GLM 4.7 Flash", performance: { median_output_tokens_per_second: 999 } },
        { name: "Unmatched", evaluations: { artificial_analysis_intelligence_index: 100 } },
        { model_creator: {} },
      ],
    }));
  vi.stubGlobal("fetch", fetcher);

  const ids = ["kimi-k3-1-pro", "deepseek-v4-1-flash", "gpt-oss-120b", "glm-5.3", "nemotron-3-ultra", "glm-4.7-flash"];
  const benchmarks = await fetchBenchmarks("test-key", ids.map((id) => ({ id })), date());
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://artificialanalysis.ai/api/v2/language/models/free?page=1&page_size=200",
    "https://artificialanalysis.ai/api/v2/language/models/free?page=2&page_size=200",
  ]);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { "x-api-key": "test-key" } });
  const { models, source } = JSON.parse(stableJson(benchmarks));
  expect(Object.keys(models)).toEqual(ids.sort());
  expect(models).toEqual({
    "deepseek-v4-1-flash": {},
    "glm-4.7-flash": {},
    "glm-5.3": { index: 31.7, speed: 62.4, ttft: 3.45 },
    "gpt-oss-120b": { index: 62.1, speed: 180.4 },
    "kimi-k3-1-pro": { ttft: 0.52 },
    "nemotron-3-ultra": { index: 10 },
  });
  expect(source).toEqual({ name: "Artificial Analysis", url: "https://artificialanalysis.ai/", indexVersion: "5" });
  expect(benchmarksChanged(benchmarks, { ...benchmarks, generatedAt: date(24 * hour) })).toBe(false);
  expect(benchmarksChanged(benchmarks, { ...benchmarks, source: { ...source, indexVersion: "5.1" } })).toBe(true);
  expect(benchmarksSchema.safeParse({ ...benchmarks, models: { bad: { speed: "42" } } }).success).toBe(false);
});

it("загружает отсутствующий файл и ждёт больше 20 часов после записи или последней попытки", () => {
  expect(shouldRefreshBenchmarks(date())).toBe(true);
  expect(shouldRefreshBenchmarks(date(20 * hour), date())).toBe(false);
  expect(shouldRefreshBenchmarks(date(20 * hour + 1), date())).toBe(true);
  expect(shouldRefreshBenchmarks(date(39 * hour), date(), date(20 * hour))).toBe(false);
  expect(shouldRefreshBenchmarks(date(41 * hour), date(), date(20 * hour))).toBe(true);
});

it.each([401, 429])("прерывает загрузку при HTTP %i на следующей странице", async (status) => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(page))
    .mockResolvedValueOnce(new Response(null, { status }));
  vi.stubGlobal("fetch", fetcher);
  await expect(fetchBenchmarks("test-key", [{ id: "glm-5.3" }], date())).rejects.toThrow("HTTP " + status);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("пропускает Artificial Analysis без ключа через CLI и не обращается к сети", () => {
  const src = new URL("../src/", import.meta.url);
  const result = execFileSync(process.execPath, [
    "--require", fileURLToPath(new URL("tsx-windows.cjs", src)),
    "--import", "data:text/javascript," + encodeURIComponent("globalThis.fetch = () => { throw new Error('unexpected fetch'); };"),
    "--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("cli.ts", src)), "update", "--only=benchmarks", "--dry-run", "--no-llm",
  ], {
    cwd: fileURLToPath(new URL("./fixtures/", import.meta.url)),
    env: { ...process.env, AA_API_KEY: "" },
    encoding: "utf8",
  });
  expect(result.match(/AA_API_KEY не задан/g)).toHaveLength(1);
  expect(result).toContain("Ошибок источников и проверок: 0.");
});
