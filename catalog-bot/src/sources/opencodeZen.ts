import { z } from "zod";
import type { RadarObservation } from "../schema.js";
import { isZeroPrice, priceSchema, requestJson } from "./common.js";

const modelList = z.object({
  data: z.array(z.object({
    id: z.string().trim().min(1),
    name: z.string().nullish(),
    description: z.string().nullish(),
    limit: z.object({ context: z.int().nonnegative().nullish() }).nullish(),
    capabilities: z.object({ tools: z.object({ supported: z.boolean().nullish() }).nullish() }).nullish(),
    cost: z.object({
      text: z.object({
        input: z.object({ price: priceSchema }).nullish(),
        output: z.object({ price: priceSchema }).nullish(),
      }).nullish(),
    }).nullish(),
  })),
});

export function parseOpenCodeZen(input: unknown): RadarObservation[] {
  return modelList.parse(input).data.flatMap((model): RadarObservation[] => {
    const cost = model.cost?.text;
    if (!model.id.toLowerCase().endsWith("-free") &&
        !(isZeroPrice(cost?.input?.price) && isZeroPrice(cost?.output?.price))) return [];
    return [{
      source: "opencode-zen",
      id: model.id,
      name: model.name?.trim() || model.id,
      description: model.description?.trim() ?? "",
      contextWindow: model.limit?.context ?? 0,
      tools: model.capabilities?.tools?.supported ?? false,
      free: true,
    }];
  });
}

export async function fetchOpenCodeZen(): Promise<RadarObservation[]> {
  return parseOpenCodeZen(await requestJson("https://opencode.ai/zen/v1/models"));
}
