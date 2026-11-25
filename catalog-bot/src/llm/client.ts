import { z } from "zod";
import type { Config } from "../config.js";
import { describeError, request } from "../sources/common.js";

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({
    total_tokens: z.int().nonnegative(),
    prompt_tokens: z.int().nonnegative(),
    completion_tokens: z.int().nonnegative(),
    prompt_cache_hit_tokens: z.int().nonnegative().optional(),
  }).optional(),
});

export type Prompt = { system: string; user: string };

export class LlmClient {
  readonly usage = { tokens: 0, requests: 0, estimatedUsd: 0 };
  readonly #deepSeekPricing: boolean;
  #budgetUsed = 0;

  constructor(readonly config: Config["llm"], private readonly fetcher: typeof fetch = fetch) {
    this.#deepSeekPricing = new URL(config.baseUrl).hostname === "api.deepseek.com" && config.model === "deepseek-flash";
  }

  get costUsd(): number | null {
    return this.#deepSeekPricing || this.usage.requests === 0 ? this.usage.estimatedUsd : null;
  }

  async json<T>(prompt: Prompt, schema: z.ZodType<T>): Promise<T | undefined> {
    if (!this.config.key) return undefined;
    // Резервируем по числу UTF-8 байтов и оставляем запас на разметку chat.
    const inputReserve = Buffer.byteLength(prompt.system + prompt.user, "utf8") + 128;
    for (let attempt = 0; attempt < 2; attempt++) {
      const outputCap = Math.min(2048, this.config.maxTokens - this.#budgetUsed - inputReserve);
      if (outputCap < 64) return undefined;
      this.usage.requests++;
      const sentAt = new Date();
      const payload: Record<string, unknown> = {
        model: this.config.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        response_format: { type: "json_object" },
        max_tokens: outputCap,
        temperature: 0,
      };
      if (this.#deepSeekPricing) payload.thinking = { type: "disabled" };
      let raw: unknown;
      try {
        raw = await request(this.config.baseUrl + "/chat/completions", (response) => response.json(), {
          method: "POST",
          redirect: "error",
          headers: { Authorization: "Bearer " + this.config.key, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }, 0, this.fetcher);
      } catch (error) {
        this.#budgetUsed += inputReserve + outputCap;
        // JSON тела HTTP 200 может оказаться повреждённым.
        if (error instanceof SyntaxError && attempt === 0) continue;
        throw new Error("LLM: " + describeError(error));
      }

      const parsed = responseSchema.safeParse(raw);
      const usage = parsed.success ? parsed.data.usage : undefined;
      const consumed = usage?.total_tokens ?? inputReserve + outputCap;
      this.#budgetUsed += consumed;
      this.usage.tokens += consumed;
      if (this.#deepSeekPricing) {
        const cached = usage ? Math.min(usage.prompt_tokens, usage.prompt_cache_hit_tokens ?? 0) : 0;
        const uncached = (usage?.prompt_tokens ?? inputReserve) - cached;
        const output = usage?.completion_tokens ?? outputCap;
        // https://api-docs.deepseek.com/quick_start/pricing/ (2026-11-24).
        // Код считает китайские праздники рабочими днями для верхней оценки.
        const hour = sentAt.getUTCHours();
        const peak = sentAt.getUTCDay() % 6 !== 0 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
        this.usage.estimatedUsd += (cached * 0.003 + uncached * 0.15 + output * 0.60) * (peak ? 2 : 1) / 1_000_000;
      }
      if (!parsed.success) continue;
      try {
        const value = schema.safeParse(JSON.parse(parsed.data.choices[0].message.content ?? ""));
        if (value.success) return value.data;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    throw new Error("LLM: два ответа не прошли проверку JSON");
  }
}
