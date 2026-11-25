import { z } from "zod";
import { providers } from "../registry/providers.js";
import type { ProviderId } from "../schema.js";
import { isZeroPrice, priceSchema, requestJson } from "./common.js";
import type { Observation, SourceResult } from "./common.js";

export const modelDetailsSchema = z.object({
  name: z.string().nullish(),
  context_length: z.int().nonnegative().nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  input_modalities: z.array(z.string()).nullish(),
  output_modalities: z.array(z.string()).nullish(),
  architecture: z.object({
    input_modalities: z.array(z.string()).nullish(),
    output_modalities: z.array(z.string()).nullish(),
  }).nullish(),
  reasoning: z.union([z.boolean(), z.object({})]).nullish(),
});

export const modelList = z.object({
  data: z.array(modelDetailsSchema.extend({
    id: z.string().min(1).max(250),
    pricing: z.object({ prompt: priceSchema, completion: priceSchema }).nullish(),
    autoRouting: z.unknown().optional(),
  })),
});

export function hasQualifier(id: string, qualifier: string): boolean {
  return id.toLowerCase().split(":").slice(1).includes(qualifier);
}

export function textModelDetails(model: z.infer<typeof modelDetailsSchema>) {
  const output = model.output_modalities ?? model.architecture?.output_modalities;
  if (output?.length && !output.includes("text")) return undefined;
  const input = model.input_modalities ?? model.architecture?.input_modalities;
  const parameters = model.supported_parameters ?? [];
  return {
    name: model.name?.trim() || undefined,
    contextWindow: model.context_length || undefined,
    supportsTools: parameters.includes("tools"),
    supportsReasoning: parameters.some((parameter) => ["reasoning", "include_reasoning", "reasoning_effort"].includes(parameter)) || !!model.reasoning,
    supportsVision: input?.includes("image") ?? false,
  };
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
      !(isZeroPrice(model.pricing?.prompt) && isZeroPrice(model.pricing?.completion))) {
      return [];
    }
    const details = textModelDetails(model);
    if (!details || model.autoRouting || model.id === "openrouter/free" || model.id === "kilo-auto/free") return [];

    return [{
      providerId,
      providerModelId: model.id,
      confidence: "structured",
      source: providerId + ":/api/v1/models",
      ...details,
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
