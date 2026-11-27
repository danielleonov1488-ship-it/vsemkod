
import { offerKey, type Catalog, type Model, type ProviderId } from "./catalog-schema";
import type { RemoteModel } from "./providers";

export type DiscoveredModels = Partial<Record<ProviderId, { models: RemoteModel[]; updatedAt: number }>>;

export function normalizeModelId(id: string) {
  return id.trim().toLowerCase().split("/").at(-1)!.split(":")[0].replace(/[_\s]+/g, "-")
    .replace(/(?:-(?:fp8|int4|awq|gguf|\d{4}|\d{6,8}))+$/, "");
}

/** В бесплатных списках бывают модели картинок, музыки, судьи и мета-роутеры («openrouter/free») — в меню кода им не место. */
function chatCandidate(id: string, normalized: string) {
  return !/image|lyria|music|judger|xiyansql|sqlcoder|embed|rerank|(?:^|[-_/])(?:tts|ocr|audio)(?:[-_/.:]|$)/i.test(id) &&
    !["free", "auto", "router"].includes(normalized);
}

export function effectiveCatalog(base: Catalog, discovered: DiscoveredModels): Catalog {
  const models = [...base.models];
  const offers = [...base.offers];
  const byId = new Map(models.map(model => [model.id, model]));
  const aliases = new Map(models.map(model => [normalizeModelId(model.id), model.id]));
  const occupied = new Set<string>();
  const offerKeys = new Set<string>();
  const sources = new Map<string, string[]>();
  for (const offer of offers) {
    const alias = normalizeModelId(offer.providerModelId);
    if (!aliases.has(alias)) aliases.set(alias, offer.modelId);
    occupied.add(offer.modelId + "/" + offer.providerId);
    offerKeys.add(offerKey(offer));
  }

  for (const provider of base.providers) {
    const list = Object.hasOwn(discovered, provider.id) ? discovered[provider.id] : undefined;
    if (!list || provider.api !== "openai") continue;
    // Если каталог проверил раздачи провайдера и ни одна не умеет инструменты (так у ModelScope), найденные тоже не умеют.
    const known = base.offers.filter(offer => offer.providerId === provider.id);
    const supportsTools = provider.freeLimits.allModelsFree || !known.length || known.some(offer => offer.supportsTools);
    const seen = new Date(list.updatedAt).toISOString();
    for (const remote of list.models) {
      const normalized = normalizeModelId(remote.id);
      if (!normalized || !chatCandidate(remote.id, normalized)) continue;
      const id = aliases.get(normalized) ?? "x-" + normalized;
      let model = byId.get(id);
      if (!model) {
        model = {
          id, origin: "discovered", tier: "new", rank: 1_000_000,
          name: remote.name.split("/").at(-1)!.replace(/\s*(?::free|\(free\))\s*$/i, "").trim() || normalized,
          vendor: remote.id.includes("/") ? remote.id.split("/")[0].replace(/^hf:/i, "") || provider.name : provider.name,
          contextWindow: remote.context ?? 32_768, capabilities: ["code", "tools"], description: "Найдена в бесплатном списке"
        };
        models.push(model);
        byId.set(id, model);
        aliases.set(normalized, id);
        sources.set(id, []);
      }
      if (sources.has(id) && remote.vision && !model.capabilities.includes("vision")) model.capabilities.push("vision");
      const pair = id + "/" + provider.id;
      const key = offerKey({ providerId: provider.id, providerModelId: remote.id });
      if (occupied.has(pair) || offerKeys.has(key)) continue;
      occupied.add(pair);
      offerKeys.add(key);
      sources.get(id)?.push(provider.name);
      offers.push({
        modelId: id, providerId: provider.id, providerModelId: remote.id, origin: "discovered",
        free: true, promo: false, expiresAt: null, supportsTools, contextWindow: remote.context ?? model.contextWindow,
        limits: {}, status: "active", confidence: "structured", sources: [provider.baseUrl.replace(/\/+$/, "") + "/models"],
        firstSeen: seen, lastSeen: seen, lastVerified: seen
      });
    }
  }
  for (const [id, providers] of sources) byId.get(id)!.description += " " + providers.join(", ");
  return { ...base, models, offers, candidates: base.candidates.filter(candidate => !offerKeys.has(offerKey(candidate))) };
}

export function catalogModelId(catalog: Catalog, upstreamId: string) {
  const normalized = normalizeModelId(upstreamId);
  return catalog.models.find(model => normalizeModelId(model.id) === normalized)?.id ??
    catalog.offers.find(offer => normalizeModelId(offer.providerModelId) === normalized)?.modelId;
}
