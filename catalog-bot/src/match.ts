import { modelRegistry } from "./registry/models.js";
import type { Model } from "./schema.js";

export function modelSlug(providerModelId: string): string {
  return (providerModelId.trim().split("/").at(-1) ?? "")
    .split(":")[0]
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function matchModel(providerModelId: string): Model | undefined {
  const slug = modelSlug(providerModelId);
  const entry = modelRegistry.find(({ id, aliases }) => id === slug || aliases.some((alias) => alias.test(slug)));
  if (!entry) return undefined;
  const { aliases: _aliases, ...model } = entry;
  return model;
}
