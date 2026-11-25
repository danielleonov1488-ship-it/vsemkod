import { z } from "zod";
import { providers } from "../registry/providers.js";
import type { ProviderId } from "../schema.js";
import { requestJson } from "./common.js";
import type { Observation, SourceResult } from "./common.js";

const price = z.union([z.string(), z.number()]).nullable().optional();

export const modelList = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(250),
    pricing: z.object({ prompt: price, completion: price }).nullable().optional(),
    context_length: z.int().nonnegative().nullable().optional(),
    supported_parameters: z.array(z.string()).nullable().optional(),
    output_modalities: z.array(z.string()).nullable().optional(),
    architecture: z.object({ output_modalities: z.array(z.string()).nullable().optional() }).nullable().optional(),
  })),
});

export function hasQualifier(id: string, qualifier: string): boolean {
  return id.toLowerCase().split(":").slice(1).includes(qualifier);
}

function isZero(value: string | number | null | undefined): boolean {
  if (typeof value === "number") return value === 0;
  return typeof value === "string" && /^(?:0+\.?0*|\.0+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

export function parseOpenAIModels(
  input: unknown,
  providerId: Extract<ProviderId, "openrouter" | "kilo" | "numes">,
): Observation[] {
  return modelList.parse(input).data.flatMap((model) => {
    if (providerId === "numes") {
      // Только маршруты, которые не переключаются на платный inference, без приватных org-вариантов.
      if (!hasQualifier(model.id, "free") || /:org-/i.test(model.id)) return [];
    } else if (!hasQualifier(model.id, "free") &&
      !(isZero(model.pricing?.prompt) && isZero(model.pricing?.completion))) {
      return [];
    }
    const output = model.output_modalities ?? model.architecture?.output_modalities;
    if (output?.length && !output.includes("text")) return [];
    if (model.id === "openrouter/free" || model.id === "kilo-auto/free") return [];

    return [{
      providerId,
      providerModelId: model.id,
      confidence: "structured",
      source: providerId + ":/api/v1/models",
      contextWindow: model.context_length || undefined,
      supportsTools: model.supported_parameters?.includes("tools") ?? false,
    }];
  });
}

export function parseOpenRouter(input: unknown): Observation[] {
  return parseOpenAIModels(input, "openrouter");
}

export async function fetchOpenRouter(): Promise<SourceResult> {
  const response = await requestJson(providers.openrouter.baseUrl + "/models");
  return { id: "openrouter", observations: parseOpenRouter(response) };
}
