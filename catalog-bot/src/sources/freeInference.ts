import { z } from "zod";
import type { DiscoveredInput } from "../schema.js";
import { requestJson } from "./common.js";
import { allowedDiscovery, discoveryId, isModelId, providerBase, publicUrl } from "./discovery.js";

export const freeInferenceUrl = "https://freeinference.dev/data/providers.json";
export const discoveryIntervalMs = 24 * 60 * 60 * 1000;

const modelSchema = z.object({
  name: z.string().min(1), cost: z.string(),
  rpm: z.string().optional(), rpd: z.string().optional(),
  tpm: z.string().optional(), tpd: z.string().optional(),
});
const snapshot = z.object({
  providers: z.array(z.object({
    name: z.string().min(1), base_url: z.string().optional(), url: z.string(),
    free_type: z.string(), models: z.array(modelSchema),
  })),
});

function limit(value: string | undefined) {
  const match = /^([\d,]+(?:\.\d+)?)\s*([KM])?(?:\/day|\/min| tokens\/day|\/day shared)?$/i.exec(value?.trim() ?? "");
  if (!match) return;
  const scaled = Number(match[1].replaceAll(",", "")) * ({ k: 1000, m: 1000000 }[match[2]?.toLowerCase()] ?? 1);
  return Number.isSafeInteger(scaled) && scaled > 0 ? scaled : undefined;
}

export function parseFreeInference(value: unknown): DiscoveredInput[] {
  return snapshot.parse(value).providers.flatMap(provider => {
    const baseUrl = provider.base_url && providerBase(provider.base_url);
    if (!baseUrl || /(?:card required|paid only|subscription only)/i.test(provider.free_type)) return [];
    const free = provider.models.filter(model => /^(?:\$0(?:\.0+)?|free)(?:$|[\s(])/i.test(model.cost) &&
      !/(?<!no )card required/i.test(model.cost));
    if (!free.length) return [];
    const models = [...new Set(free.map(model => model.name).filter(isModelId))];
    const limits = Object.fromEntries((["rpm", "rpd", "tpm", "tpd"] as const).flatMap(field => {
      const values = free.map(model => limit(model[field]));
      return values[0] !== undefined && values.every(value => value === values[0]) ? [[field, values[0]]] : [];
    }));
    const item: DiscoveredInput = {
      id: discoveryId(baseUrl), name: provider.name, baseUrl, signupUrl: publicUrl(provider.url)?.href ?? null,
      models, endsAt: null, limits, sources: [freeInferenceUrl],
    };
    return allowedDiscovery(item) ? [item] : [];
  });
}

export async function fetchFreeInference() {
  return parseFreeInference(await requestJson(freeInferenceUrl));
}
