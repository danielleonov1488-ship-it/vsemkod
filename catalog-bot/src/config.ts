import { loadEnvFile } from "node:process";
import { z } from "zod";
import type { ProviderId } from "./schema.js";

export const watchedPages = [
  { providerId: "runcrate", url: "https://www.runcrate.ai/inference/free" },
  { providerId: "zai", url: "https://docs.z.ai/guides/overview/pricing" },
  { providerId: "modelscope", url: "https://www.modelscope.cn/docs/model-service/API-Inference/limits.md" },
  { providerId: "groq", url: "https://console.groq.com/docs/rate-limits" },
  { providerId: "numes", url: "https://numes.ai/docs/models.md" },
] as const;

export const feedIds = ["hn", "reddit", "github"] as const;
export const structuredIds = ["openrouter", "kilo", "numes"] as const;
export const sourceSelectors = [
  ...structuredIds, "opencode-zen", "benchmarks", "free-list", "free-llm", "watchPages", "feeds", "telegram", "freeinference", ...feedIds,
  ...watchedPages.map(({ providerId }) => "page:" + providerId),
];

// У неофициальных прокси и реселлеров условия бесплатного доступа и обработки
// запросов зависят от посредника. Pollinations тоже исключён, условия доступа менялись.
export const freeLlmDenylist = new Set([
  "api-airforce", "pollinations", "pollinations-ai", "aihubmix", "bazaarlink", "token-harbor", "llmtr", "zro",
]);

export interface Config {
  llm: { baseUrl: string; key?: string; model: string; maxTokens: number };
  numesKey?: string;
  aaKey?: string;
  missingRuns: number;
  retentionDays: number;
  healthIntervalHours: number;
  healthFailureThreshold: number;
  healthKeys: Partial<Record<ProviderId, string>>;
  telegram?: { token: string; chatId: string };
  telegramChannels?: string[];
  discoveryKeyBases?: Partial<Record<ProviderId, string>>;
}

export function readConfig(): Config {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const env = (name: string) => process.env[name]?.trim() || undefined;
  const positiveInt = (name: string, fallback: number) => {
    const value = Number(env(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(name + " должна быть целым положительным числом");
    }
    return value;
  };

  // 2026-11-24: https://api-docs.deepseek.com/quick_start/pricing/
  const baseUrl = env("LLM_BASE_URL") ?? "https://api.deepseek.com";
  const parsedUrl = z.url({ protocol: /^https?$/ }).safeParse(baseUrl);
  if (!parsedUrl.success) throw new Error("LLM_BASE_URL должна быть HTTP(S)-ссылкой");

  const healthKeys: Config["healthKeys"] = Object.create(null);
  const discoveryKeyBases: NonNullable<Config["discoveryKeyBases"]> = Object.create(null);
  for (const name of Object.keys(process.env)) {
    const match = /^HEALTH_([A-Z0-9][A-Z0-9_-]{1,40})_(KEY|BASE_URL)$/.exec(name);
    if (!match) continue;
    const id = match[1].toLowerCase().replaceAll("_", "-");
    (match[2] === "KEY" ? healthKeys : discoveryKeyBases)[id] = env(name);
  }
  const telegramChannels = [...new Set((process.env.TELEGRAM_CHANNELS ?? "rubiconzone").toLowerCase()
    .split(/[\s,]+/).map(channel => channel.replace(/^@/, "")).filter(Boolean))];
  if (telegramChannels.some(channel => !/^[a-z0-9_]{5,32}$/.test(channel))) {
    throw new Error("TELEGRAM_CHANNELS ожидает имена публичных каналов через запятую");
  }
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  return {
    llm: {
      baseUrl: parsedUrl.data.replace(/\/+$/, ""),
      key: env("LLM_API_KEY"),
      model: env("LLM_MODEL") ?? "deepseek-flash",
      maxTokens: positiveInt("LLM_MAX_TOKENS_PER_RUN", 150000),
    },
    numesKey: env("NUMES_API_KEY"),
    aaKey: env("AA_API_KEY"),
    missingRuns: positiveInt("OFFER_MISSING_RUNS", 6),
    retentionDays: positiveInt("OFFER_ENDED_RETENTION_DAYS", 7),
    healthIntervalHours: positiveInt("HEALTH_INTERVAL_HOURS", 6),
    healthFailureThreshold: positiveInt("HEALTH_FAILURE_THRESHOLD", 2),
    healthKeys,
    discoveryKeyBases,
    telegramChannels,
    telegram: token && chatId ? { token, chatId } : undefined,
  };
}
