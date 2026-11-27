import { z } from "zod";
import { isFreeRoute, toolSupport } from "../../../app/src/shared/free-model.js";
import { providers } from "../registry/providers.js";
import { request, type Observation, type SourceResult } from "./common.js";

const metadata = z.object({ id: z.string().min(1).max(250) }).passthrough();
const list = z.object({ data: z.array(metadata) });
const types = z.object({ model_id: z.string(), model_name: z.string().optional() }).passthrough();

const aihubmixDetails = "https://aihubmix.com/api/v1/models";
const pollinationsDetails = "https://text.pollinations.ai/models";
const synapFree = "https://www.synap402.com/api/account/free-tier";
const tokenRouterPricing = "https://api.tokenrouter.com/api/pricing";
const beatCatalog = "https://api.beatapi.io/v1/text/models";

type Settings = {
  extra?: string;
  tools?: readonly string[];
  free?: readonly string[];
  sharedCredit?: boolean;
  endpoint?: string;
};

// В этих списках маршруты меняются, а capabilities бывают только в карточках моделей.
export const publicModelProviders = {
  aihubmix: { extra: aihubmixDetails },
  crowllm: { tools: [
    "ernie-5.5-flash-preview:free", "k2-horizon-375b-a23b:free", "longcat-2.5:free",
    "glm-5.3-flash:free", "deepseek-v4-flash-0731-thinking:free", "deepseek-v4-flash-0731:free",
    "nemotron-3.5-super-vl:free", "nemotron-3-ultra-550b-a55b:free", "step-5-preview:free",
  ] },
  bazaarlink: { tools: ["beam-free", "reflection/beam-free:free", "nemotron-3.5-lightning-free",
    "nvidia/nemotron-3.5-lightning-free:free", "deepseek/deepseek-v4-flash-0731free:free"] },
  nous: {},
  vercel: {},
  pollinations: { extra: pollinationsDetails, free: ["openai-fast"] },
  cheapllm: { free: ["deepseek-v4.1-flash-1017"], tools: ["deepseek-v4.1-flash-1017"] },
  // Общий ежемесячный баланс: https://gonkabroker.com/free-llm-api/
  gonkabroker: { sharedCredit: true },
  synap: { extra: synapFree },
  // https://docs.beatapi.io/free-models и карточки Text API для DeepSeek, GLM и Hunyuan.
  beatapi: { endpoint: beatCatalog, tools: ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "hy4-flash-free"] },
  // Цены и наличие в группе default проверяются в публичном каталоге TokenRouter.
  tokenrouter: { endpoint: tokenRouterPricing, tools: [
    "deepseek/deepseek-v4.1-flash-1017-free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  ] },
  llm7: {},
} satisfies Record<string, Settings>;

function context(item: Record<string, unknown>) {
  const value = z.int().positive();
  const object = z.object({ tokens: value }).safeParse(item.context_window);
  return [item.context_length, item.context_window, item.max_model_len, object.data?.tokens]
    .map(entry => value.safeParse(entry).data).find(entry => entry !== undefined);
}

export function parsePublicModels(providerId: keyof typeof publicModelProviders, input: unknown, extra?: unknown): Observation[] {
  const settings: Settings = publicModelProviders[providerId];
  const url = settings.endpoint ?? providers[providerId].baseUrl + "/models";
  const detail = new Map<string, Record<string, unknown>>();
  if (providerId === "aihubmix" && extra !== undefined) for (const row of z.object({ data: z.array(types) }).parse(extra).data) {
    detail.set(row.model_id, { ...row, name: row.model_name });
  }
  if (providerId === "pollinations" && extra !== undefined) for (const row of z.array(z.object({
    name: z.string(), tier: z.string(), tools: z.boolean(),
  })).parse(extra)) {
    detail.set(row.name, { free: row.tier === "anonymous", tool_call: row.tools });
  }

  if (providerId === "synap" && extra !== undefined) {
    const promo = z.object({ live: z.boolean(), model: z.string() }).parse(extra);
    if (promo.live) detail.set(promo.model, { free: true, is_free: true });
  }
  const models = listedModels(providerId, input);
  return models.flatMap(row => {
    const item = { ...row, ...detail.get(row.id) } as typeof row & Parameters<typeof toolSupport>[0];
    if (item.available === false || /^(?:auto|free|router)(?::free|-free)?$/i.test(item.id)) return [];
    const free = settings.sharedCredit || isFreeRoute(item, settings.free?.includes(item.id));
    const tools = toolSupport(item) ?? settings.tools?.includes(item.id);
    if (!free || !tools) return [];
    const name = [item.name, item.display_name].find((value): value is string => typeof value === "string" && !!value.trim());
    const expiry = [item.expiration_date, item.expires_at, item.expires].find((value): value is string =>
      typeof value === "string" && Number.isFinite(Date.parse(value)));
    return [{
      providerId, providerModelId: item.id, name: name?.trim(), confidence: "structured", source: url,
      documentedRoute: true, supportsTools: true, contextWindow: context(item),
      ...(expiry ? { promo: true, expiresAt: new Date(expiry).toISOString() } : {}),
    }];
  });
}

function listedModels(providerId: keyof typeof publicModelProviders, input: unknown) {
  if (providerId === "beatapi") return z.object({ data: list }).parse(input).data.data.filter(row => row.family === "free");
  if (providerId === "tokenrouter") {
    const pricing = z.object({ data: z.array(z.object({
      model_name: z.string(), model_price: z.number(), model_ratio: z.number(),
      enable_groups: z.array(z.string()), supported_endpoint_types: z.array(z.string()),
    })) });
    return pricing.parse(input).data.filter(row =>
      row.model_price === 0 && row.model_ratio === 0 && row.enable_groups.includes("default") &&
      row.supported_endpoint_types.includes("openai"),
    ).map(row => ({ id: row.model_name, free: true } as z.infer<typeof metadata>));
  }
  return list.parse(input).data;
}

export async function fetchPublicModels(providerId: keyof typeof publicModelProviders): Promise<SourceResult> {
  const settings: Settings = publicModelProviders[providerId];
  const get = (url: string) => request(url, response => response.json(), { redirect: "error" }, 0);
  const [input, extra] = await Promise.all([
    get(settings.endpoint ?? providers[providerId].baseUrl + "/models"), settings.extra ? get(settings.extra) : undefined,
  ]);
  return { id: providerId, observations: parsePublicModels(providerId, input, extra) };
}
