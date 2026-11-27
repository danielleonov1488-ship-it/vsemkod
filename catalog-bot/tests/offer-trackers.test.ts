import { expect, it } from "vitest";
import { parsePublicModels } from "../src/sources/publicModels.js";
import { parseClawTracker, parseCodingTracker, parseMarkdownTracker, parseOpenRouterRadar, trackerUrls } from "../src/sources/offerTrackers.js";

it("публичный каталог включает только бесплатные маршруты с инструментами", () => {
  const data = [
    { id: "a", is_free: true, capabilities: { tools: true } },
    { id: "b", name: "Model B (free)", tags: ["tool-use"] },
    { id: "c", pricing: { input: "0", output: 0 }, supported_parameters: ["tools"], context_window: 64_000 },
    { id: "d", free: true, supports_tools: false },
    { id: "f-free", pricing: { input: "0.01", output: "0.01" }, tools_calling: true },
    { id: "auto:free", tool_call: true },
  ];
  expect(parsePublicModels("vercel", { data }).map(m => [m.providerModelId, m.contextWindow]))
    .toEqual([["a", undefined], ["b", undefined], ["c", 64_000]]);
  expect(parsePublicModels("aihubmix", { data: [{ id: "model" }] }, {
    data: [{ model_id: "model", model_name: "Model (free)", tool_call: true }],
  })[0]).toMatchObject({ name: "Model (free)", documentedRoute: true });
  expect(parsePublicModels("synap", { data: [
    { id: "free-with-account", is_free: false, supported_parameters: ["tools"] },
    { id: "paid", is_free: false, supported_parameters: ["tools"] },
  ] }, { live: true, model: "free-with-account" }).map(m => m.providerModelId)).toEqual(["free-with-account"]);
  expect(parsePublicModels("pollinations", { data: [{ id: "openai-fast" }] }, [
    { name: "openai-fast", tools: true, tier: "anonymous" },
  ])[0]).toMatchObject({ providerModelId: "openai-fast", supportsTools: true });
});

it("извлекает ID, URL и дату раздачи из трекеров", () => {
  const data = { entries: [{ id: "service", name: "Service", free_part: "models", url: "https://service.example",
    api: { openai_compatible: true, base_url: "https://api.service.example/v1", model_ids: ["org/model:free"] } }] };
  const history = JSON.stringify({ id: "service", event: "models", detail: "available until 2026-12-08" });
  const [coding] = parseCodingTracker(data, history);
  expect(coding).toMatchObject({ id: "service", models: ["org/model:free"], endsAt: "2026-12-08T23:59:59.000Z",
    sources: [trackerUrls.coding, trackerUrls.history] });
  expect(parseClawTracker({ models: [
    { kind: "chat", source: "https://openrouter.ai/org/a:free", id: "org/a:free", expires: "2026-12-05" },
  ] })[0]).toMatchObject({ id: "openrouter", models: ["org/a:free"], endsAt: "2026-12-05T23:59:59.000Z" });
  expect(parseOpenRouterRadar({ free_ids: ["org/a:free", "bad normal"] })[0].models).toEqual(["org/a:free"]);
  const text = "### Example API\n**Endpoint**: https://api.service.example/v1\nFree model: \x60org/model:free\x60\n";
  expect(parseMarkdownTracker(text)[0]).toMatchObject({ name: "Example API", baseUrl: "https://api.service.example/v1",
    models: ["org/model:free"] });
});
