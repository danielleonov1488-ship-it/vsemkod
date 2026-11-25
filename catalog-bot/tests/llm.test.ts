import { expect, it, vi } from "vitest";
import { z } from "zod";
import { watchedPages } from "../src/config.js";
import { LlmClient } from "../src/llm/client.js";
import { newState } from "../src/state.js";
import { processPage } from "../src/sources/watchPages.js";

const config = { baseUrl: "https://api.deepseek.com", key: "test-key", model: "deepseek-flash", maxTokens: 150000 };
const prompt = { system: "Ответ JSON", user: "test" };
const schema = z.object({ offers: z.array(z.string()) });
const reply = (content: string) => Response.json({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

it("повторяет один раз при неверном ответе LLM и учитывает оба вызова", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(reply('{"offers":false}'))
    .mockResolvedValueOnce(reply('{"offers":["model"]}'));
  const client = new LlmClient(config, fetcher);
  expect(await client.json(prompt, schema)).toEqual({ offers: ["model"] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const payload = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(payload).toMatchObject({ model: "deepseek-flash", response_format: { type: "json_object" } });
  expect(client.usage).toMatchObject({ requests: 2, tokens: 30 });
});

it("пропускает результат после двух невалидных JSON", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(reply("invalid JSON")));
  const client = new LlmClient(config, fetcher);
  await expect(client.json(prompt, schema)).rejects.toThrow("два ответа");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("не вызывает LLM без ключа или остатка бюджета", async () => {
  const fetcher = vi.fn();
  const noKey = new LlmClient({ ...config, key: undefined }, fetcher);
  const noBudget = new LlmClient({ ...config, maxTokens: 50 }, fetcher);
  expect(await noKey.json(prompt, schema)).toBeUndefined();
  expect(await noBudget.json(prompt, schema)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it("отдаёт сохранённый результат при неизменном хеше страницы тарифов", async () => {
  const entry = { providerId: "runcrate", providerModelId: "openai/gpt-oss-120b", free: true, promo: false, expiresAt: null };
  const fetcher = vi.fn().mockResolvedValue(reply(JSON.stringify({ offers: [entry] })));
  const client = new LlmClient(config, fetcher);
  const state = newState();
  const first = await processPage(watchedPages[0], "Free gpt-oss-120b", client, state, "2026-11-24T00:00:00Z");
  const next = await processPage(watchedPages[0], "Free gpt-oss-120b", client, state, "2026-11-24T01:00:00Z");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(next).toEqual(first);
  expect(next.observations[0].confidence).toBe("page");
});
