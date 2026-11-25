import { modelSlug } from "./match.js";
import { models } from "./registry/models.js";
import type { Model } from "./schema.js";
import type { Observation } from "./sources/common.js";

const rank = Math.max(...models.map((model) => model.rank)) + 1;
const vendors = new Map(Object.entries({
  anthropic: "Anthropic", arcee: "Arcee AI", "arcee-ai": "Arcee AI",
  baidu: "Baidu", dealignai: "DeAlign AI", deepseek: "DeepSeek", "deepseek-ai": "DeepSeek",
  google: "Google", humansand: "Humans&", inclusionai: "inclusionAI", liquid: "Liquid AI",
  meta: "Meta", "meta-llama": "Meta", minimax: "MiniMax", mistralai: "Mistral AI",
  moonshotai: "Moonshot AI", nvidia: "NVIDIA", openai: "OpenAI", "particle-ai": "Particle AI",
  qwen: "Alibaba", recursive: "Recursive", reflection: "Reflection AI", xiaomi: "Xiaomi",
  "z-ai": "Z.ai", zai: "Z.ai", "zai-org": "Z.ai",
}));

function isSmall(id: string): boolean {
  const size = /(?:^|-)(?:(\d+)x)?(\d+(?:\.\d+)?)([mbt])(?:-|$)/.exec(id);
  if (!size) return false;
  const unit = size[3] === "m" ? 0.001 : size[3] === "t" ? 1000 : 1;
  return Number(size[1] ?? 1) * Number(size[2]) * unit < 20;
}

export function newModel(observation: Observation): Model | undefined {
  const { providerModelId, contextWindow, supportsTools, confidence } = observation;
  if (confidence !== "structured" || !supportsTools || contextWindow === undefined || contextWindow < 128_000) {
    return undefined;
  }
  const id = modelSlug(providerModelId);
  const route = providerModelId.trim().toLowerCase().split(":")[0];
  if (!id || route === "openrouter/free" || route === "kilo-auto/free" || isSmall(id) ||
      /(?:^|-)(?:embeddings?|embed|rerank(?:er|ing)?|moderat(?:ion|or)|safeguard|tts|stt|whisper|text-to-(?:audio|image)|(?:audio|image)-generation)(?:-|$)/i.test(id) ||
      // Любительские дообучения без цензуры/«аблитерации» и роулплей — не для кодинга, людям не показываем.
      /(?:^|-)(?:uncensored|abliterated|jailbreak|nsfw|roleplay|rp|erotic)(?:-|$)/i.test(id)) {
    return undefined;
  }

  const vendor = route.includes("/") ? vendors.get(route.split("/")[0]) : undefined;
  const capabilities: Model["capabilities"] = ["tools"];
  if (observation.supportsReasoning) capabilities.push("reasoning");
  if (observation.supportsVision) capabilities.push("vision");
  return {
    id,
    name: observation.name || id.split("-").filter(Boolean).map((word) =>
      /^\d/.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1),
    ).join(" ") || id,
    vendor: vendor ?? "Неизвестно",
    tier: "new",
    description: "Новая бесплатная модель. Мало проверена — может работать нестабильно.",
    contextWindow,
    capabilities,
    rank,
  };
}
