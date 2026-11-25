import type { Catalog, Model, Offer, Provider } from "./catalog-schema";

const tierOrder = { top: 0, good: 1, new: 2, basic: 3 };

export function rankedModels(catalog: Catalog): Model[] {
  return [...catalog.models].sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.rank - b.rank);
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
