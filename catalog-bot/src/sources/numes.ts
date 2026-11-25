import { z } from "zod";
import { numesPublicModelsUrl, providers } from "../registry/providers.js";
import { requestJson } from "./common.js";
import type { Observation, SourceResult } from "./common.js";
import { hasQualifier, parseOpenAIModels } from "./openrouter.js";

const publicPageSchema = z.object({
  data: z.array(z.object({
    compatible_request_id: z.string().min(1).max(250),
    context_length: z.int().nonnegative().nullable().optional(),
    supported_parameters: z.array(z.string()).nullable().optional(),
    output_modalities: z.array(z.string()).nullable().optional(),
  })),
  meta: z.object({
    next_cursor: z.string().min(1).nullish(),
    catalogue: z.object({ stale: z.boolean().optional() }).optional(),
  }),
});

async function fetchPublic(): Promise<Observation[]> {
  const url = new URL(numesPublicModelsUrl);
  url.searchParams.set("limit", "100");
  const observations = new Map<string, Observation>();
  const cursors = new Set<string>();
  for (;;) {
    const { data, meta } = publicPageSchema.parse(await requestJson(url, {
      headers: { Accept: "application/json" },
      credentials: "omit",
    }));
    if (meta.catalogue?.stale) throw new Error("Публичный каталог Numes помечен как устаревший");
    for (const row of data) {
      const id = row.compatible_request_id;
      if (!hasQualifier(id, "free") || /:org-/i.test(id) ||
          (row.output_modalities?.length && !row.output_modalities.includes("text"))) continue;
      observations.set(id, {
        providerId: "numes",
        providerModelId: id,
        confidence: "structured",
        source: numesPublicModelsUrl,
        contextWindow: row.context_length || undefined,
        supportsTools: row.supported_parameters?.includes("tools") ?? false,
      });
    }
    const cursor = meta.next_cursor;
    if (!cursor) return [...observations.values()];
    if (cursors.has(cursor) || cursors.size >= 49) {
      throw new Error("Пагинация публичного каталога Numes не завершилась");
    }
    cursors.add(cursor);
    url.searchParams.set("cursor", cursor);
  }
}

export async function fetchNumes(key?: string): Promise<SourceResult> {
  if (!key) return { id: "numes", observations: await fetchPublic() };
  const response = await requestJson(providers.numes.baseUrl + "/models", {
    headers: { Authorization: "Bearer " + key },
    redirect: "error",
  });
  return { id: "numes", observations: parseOpenAIModels(response, "numes") };
}
