import type { Catalog, Model, Offer, Provider } from "./catalog-schema";

const tierOrder = { top: 0, good: 1, new: 2, basic: 3 };

export function rankedModels(catalog: Catalog): Model[] {
  return [...catalog.models].sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.rank - b.rank);
}

const quickModels = ["nemotron-3.5-lightning", "beam-free", "ernie-5.5-flash-preview", "glyph-cluster", "flint-v1.0"];

export function automaticModels(catalog: Catalog, now = Date.now()): Model[] {
  const ranked = rankedModels(catalog).filter(model => model.origin !== "discovered");
  const anonymous = ranked.filter(model => model.tier !== "basic" && activeOffers(catalog, model.id, now)
    .some(({ offer, provider }) => offer.supportsTools && provider.auth.type === "none"));
  const preferred = quickModels.flatMap(id => anonymous.filter(model => model.id === id));
  const stable = ranked.filter(model => model.tier === "top" || model.tier === "good");
  const experimental = anonymous.filter(model => model.tier === "new");
  return [...new Set([...preferred, ...stable, ...experimental])];
}

export function defaultModel(catalog: Catalog, now = Date.now()): Model | undefined {
  return automaticModels(catalog, now).find(model => activeOffers(catalog, model.id, now)
    .some(({ offer, provider }) => offer.supportsTools && provider.auth.type === "none"));
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
