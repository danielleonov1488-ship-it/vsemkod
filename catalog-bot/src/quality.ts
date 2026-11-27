import { isUncensored } from "../../app/src/shared/uncensored.js";
import { fallbackModels, qualityFloor, qualityOverrides } from "./config.js";
import type { Catalog } from "./schema.js";
import type { Benchmarks } from "./sources/artificialAnalysis.js";

export function classifyCatalog(catalog: Catalog, previous?: Catalog, benchmarks?: Benchmarks): Catalog {
  const version = benchmarks?.source.indexVersion;
  const comparable = version === qualityFloor.indexVersion;
  const priorTiers = new Map(previous?.models.map(model => [model.id, model.tier]));
  const uncensored = new Set(catalog.offers.filter(offer => isUncensored(offer.providerModelId)).map(offer => offer.modelId));

  return {
    ...catalog,
    models: catalog.models.map(model => {
      if (!comparable) return { ...model, tier: priorTiers.get(model.id) ?? model.tier };
      if (uncensored.has(model.id) || isUncensored(model.id, model.name)) return model;
      const index = benchmarks?.models[model.id]?.index;
      const tier = fallbackModels.has(model.id) ? "good" : qualityOverrides.get(model.id)?.tier ??
        (index === undefined || index < qualityFloor.minIndex ? "basic" : index >= 25 ? "top" : "good");
      return { ...model, tier };
    }),
  };
}

export function indexVersionWarning(benchmarks?: Benchmarks): string | undefined {
  const version = benchmarks?.source.indexVersion;
  if (version && version !== qualityFloor.indexVersion) {
    return "AA сменил индекс на v" + version + " — обновите qualityFloor";
  }
}

export function qualitySummary(catalog: Catalog, benchmarks?: Benchmarks): string[] {
  return (["top", "good", "new", "basic"] as const).map(tier => {
    const models = catalog.models.filter(model => model.tier === tier);
    return tier + " (" + models.length + "): " + models.map(({ id }) => {
      const index = benchmarks?.models[id]?.index;
      return id + (index === undefined ? " (без оценки)" : " (" + index + ")");
    }).join(", ");
  });
}
