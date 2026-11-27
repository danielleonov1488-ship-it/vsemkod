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
  const find = (name: string) => modelRegistry.find(({ id, aliases }) => id === name || aliases.some(alias => alias.test(name)));
  const entry = find(slug) ?? (slug.endsWith("-free") ? find(slug.slice(0, -5)) : undefined);
  if (!entry) return undefined;
  const { aliases: _aliases, ...model } = entry;
  return model;
}

export function normalizeModelName(value: string): string {
  return modelSlug(value).replace(/[.()]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function catalogModelMatcher(models: Pick<Model, "id">[]) {
  const ids = new Set(models.map(({ id }) => id));
  const normalizedIds = new Map<string, string | undefined>();
  for (const id of ids) {
    const normalized = normalizeModelName(id);
    normalizedIds.set(normalized, normalizedIds.has(normalized) ? undefined : id);
  }
  // «gemma-4-31b-it» в каталоге ↔ «Gemma 4 31B» у Artificial Analysis.
  for (const id of ids) {
    const bare = normalizeModelName(id).replace(/-(?:it|instruct|chat)$/, "");
    if (!normalizedIds.has(bare)) normalizedIds.set(bare, id);
  }
  return (names: string[]): string | undefined => {
    for (const name of names) {
      const slug = modelSlug(name);
      if (ids.has(slug)) return slug;
      const id = normalizedIds.get(normalizeModelName(name));
      if (id) return id;
    }
    for (const name of names) {
      const id = (matchModel(name) ?? matchModel(normalizeModelName(name)))?.id;
      if (id && ids.has(id)) return id;
    }
  };
}
