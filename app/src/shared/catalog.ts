import type { Catalog, Model, Offer, Provider } from "./catalog-schema";
import { compareByBenchmark, type Benchmarks } from "./benchmarks";
import { isUncensored } from "./uncensored";

const tierOrder = { top: 0, good: 1, new: 2, basic: 3 };

export function rankedModels(catalog: Catalog): Model[] {
  return [...catalog.models].sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.rank - b.rank);
}

const quickModels = ["ernie-5.5-flash-preview", "beam-free", "nemotron-3.5-super", "ling-3.2-flash"];
const fallback = "nemotron-3-ultra";

export function uncensoredModel(catalog: Catalog, model: Model): boolean {
  return isUncensored(model.name, model.id) ||
    catalog.offers.some(offer => offer.modelId === model.id && isUncensored(offer.providerModelId));
}

export function visibleFreeModel(catalog: Catalog, model: Model): boolean {
  return (model.tier !== "basic" && model.origin !== "discovered" && !model.id.startsWith("x-")) ||
    uncensoredModel(catalog, model);
}

function anonymous(catalog: Catalog, model: Model, now: number) {
  return activeOffers(catalog, model.id, now).some(({ offer, provider }) => offer.supportsTools && provider.auth.type === "none");
}

export function automaticModels(catalog: Catalog, now = Date.now(), benchmarks?: Benchmarks): Model[] {
  const ranked = rankedModels(catalog).filter(model =>
    visibleFreeModel(catalog, model) && !uncensoredModel(catalog, model));
  const preferred = quickModels.flatMap(id => ranked.filter(model => model.id === id && anonymous(catalog, model, now)));
  const stable = ranked.filter(model => model.id !== fallback && (model.tier === "top" || model.tier === "good"))
    .sort((a, b) => benchmarks?.models[a.id]?.index !== undefined || benchmarks?.models[b.id]?.index !== undefined
      ? compareByBenchmark(a, b, benchmarks) : 0);
  return [...new Set([...preferred, ...stable, ...ranked.filter(model => model.id === fallback)])];
}

export function defaultModel(catalog: Catalog, now = Date.now(), benchmarks?: Benchmarks): Model | undefined {
  return automaticModels(catalog, now, benchmarks).find(model => anonymous(catalog, model, now));
}

export function activeOffers(catalog: Catalog, modelId: string, now = Date.now()) {
  const offers: { offer: Offer; provider: Provider }[] = [];
  for (const offer of catalog.offers) {
    if (offer.modelId !== modelId || offer.status !== "active" || (offer.expiresAt && Date.parse(offer.expiresAt) <= now)) continue;
    const provider = catalog.providers.find(({ id }) => id === offer.providerId);
    if (provider?.api === "openai") offers.push({ offer, provider });
  }
  return offers.sort((a, b) => a.provider.clicksToConnect - b.provider.clicksToConnect);
}
