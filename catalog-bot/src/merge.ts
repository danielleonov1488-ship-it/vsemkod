import { modelSlug, matchModel } from "./match.js";
import { models } from "./registry/models.js";
import { registryPageHash, registryReviewMs } from "./registry/offers.js";
import { providers } from "./registry/providers.js";
import { catalogSchema, offerKey } from "./schema.js";
import type { Candidate, Catalog, Change, Offer } from "./schema.js";
import type { HealthState, Track, State } from "./state.js";
import type { Observation, SourceResult } from "./sources/common.js";

const day = 24 * 60 * 60 * 1000;
const confidenceRank = { structured: 0, page: 1, news: 2 };

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => compare(a, b)));
    }
    return entry;
  }, 2) + "\n";
}

const sortOffers = (a: Offer, b: Offer) =>
  compare(a.modelId, b.modelId) || compare(a.providerId, b.providerId) || compare(a.providerModelId, b.providerModelId);

function sortedCatalog(catalog: Catalog): Catalog {
  const sortSources = <T extends Offer>(entry: T): T => ({
    ...entry,
    sources: [...new Set(entry.sources)].sort(compare),
  });
  return {
    ...catalog,
    models: catalog.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities].sort(compare),
    })).sort((a, b) => a.rank - b.rank || compare(a.id, b.id)),
    providers: catalog.providers.map((provider) => ({
      ...provider, loginMethods: [...provider.loginMethods].sort(compare),
    })).sort((a, b) => compare(a.id, b.id)),
    offers: catalog.offers.map(sortSources).sort(sortOffers),
    candidates: catalog.candidates.map(sortSources).sort(sortOffers),
  };
}

function comparable(catalog: Catalog): string {
  const stripSeen = ({ lastSeen: _lastSeen, ...entry }: Candidate) => entry;
  const { generatedAt: _generatedAt, ...sorted } = sortedCatalog(catalog);
  return stableJson({ ...sorted, offers: sorted.offers.map(stripSeen), candidates: sorted.candidates.map(stripSeen) });
}

export function catalogChanged(previous: Catalog | undefined, next: Catalog): boolean {
  return !previous || comparable(previous) !== comparable(next);
}

interface MergeOptions {
  now: string;
  missingRuns: number;
  retentionDays: number;
  healthFailureThreshold: number;
}

function recoverTrack(offer: Candidate, previous: Catalog): Track {
  // При восстановлении state.json достраиваем счётчики из последнего опубликованного каталога.
  const evidence: Track["evidence"] = {};
  for (const source of offer.sources) {
    let id = "hn";
    if (source === "registry:" + offer.providerId) id = source;
    else if (offer.confidence === "structured") id = offer.providerId;
    else if (offer.confidence === "page") id = "page:" + offer.providerId;
    else if (source.startsWith("https://www.reddit.com/")) id = "reddit";
    else if (source.startsWith("https://github.com/")) id = "github";
    evidence[id] = {
      observation: { ...offer, source, contextWindow: offer.contextWindow || undefined },
      missedRuns: 0,
    };
  }
  return {
    evidence,
    endedAt: offer.status === "ended" ? offer.expiresAt ?? previous.generatedAt : undefined,
    health: offer.lastVerified ? {
      checkedAt: offer.lastVerified, verifiedAt: offer.lastVerified, consecutiveFailures: 0,
    } : undefined,
  };
}

function isRegistryOffer(entry: Observation): entry is Observation & { verifiedAt: string; reviewBy: string } {
  return entry.source === "registry:" + entry.providerId && !!entry.verifiedAt && !!entry.reviewBy;
}

function orderedEvidence(items: Observation[]): Observation[] {
  return items.sort((a, b) => confidenceRank[a.confidence] - confidenceRank[b.confidence] ||
    Number(isRegistryOffer(a)) - Number(isRegistryOffer(b)) ||
    compare(a.source, b.source) || compare(stableJson(a), stableJson(b)));
}

function registryReview(
  registry: Observation & { verifiedAt: string; reviewBy: string },
  state: State, key: string, timestamp: number, lastVerified: string | null,
) {
  const pageId = "page:" + registry.providerId;
  const check = state.pageChecks[pageId];
  const page = state.pages[pageId];
  const recent = timestamp - registryReviewMs;
  const pageConfirmed = !!check && !!page && page.hash === check.hash &&
    Date.parse(check.checkedAt) >= recent && page.observations.some((offer) => offerKey(offer) === key);
  const pageChanged = !!check && check.hash !== registryPageHash(registry.providerId);
  const healthConfirmed = !!lastVerified && Date.parse(lastVerified) >= Math.max(
    recent, Date.parse(registry.verifiedAt), pageChanged ? Date.parse(check.changedAt) : 0,
  );
  const needsReview = (pageChanged || timestamp >= Date.parse(registry.reviewBy)) &&
    !pageConfirmed && !healthConfirmed;
  return { pageConfirmed, needsReview };
}

export function mergeCatalog(
  previous: Catalog | undefined,
  state: State,
  batches: SourceResult[],
  options: MergeOptions,
  healthUpdates: Record<string, HealthState> = {},
): { catalog: Catalog; tracks: State["tracks"]; changes: Change[] } {
  const { now, missingRuns } = options;
  const timestamp = Date.parse(now);
  const cutoff = timestamp - options.retentionDays * day;
  const tracks = structuredClone(state.tracks);
  const previousEntries = new Map<string, Candidate>();
  const previousOffers = new Map(previous?.offers.map((offer) => [offerKey(offer), offer]));
  const seen = new Set<string>();

  if (previous) {
    for (const entry of [...previous.offers, ...previous.candidates]) {
      const key = offerKey(entry);
      previousEntries.set(key, entry);
      tracks[key] ??= recoverTrack(entry, previous);
    }
  }

  for (const batch of batches) {
    const byKey = new Map<string, Observation>();
    for (const observation of orderedEvidence([...batch.observations])) {
      const key = offerKey(observation);
      if (!byKey.has(key)) byKey.set(key, observation);
    }
    if (batch.complete !== false) {
      for (const [key, track] of Object.entries(tracks)) {
        const entry = track.evidence[batch.id];
        if (entry && !byKey.has(key)) entry.missedRuns = Math.min(missingRuns, entry.missedRuns + 1);
      }
    }
    for (const [key, observation] of byKey) {
      tracks[key] ??= { evidence: {} };
      tracks[key].evidence[batch.id] = { observation, missedRuns: 0 };
      seen.add(key);
    }
  }

  const offers: Offer[] = [];
  const candidates: Candidate[] = [];
  for (const [key, track] of Object.entries(tracks)) {
    track.health = healthUpdates[key] ?? track.health;
    const prior = previousEntries.get(key);
    const priorOffer = previousOffers.get(key);
    const verified = track.health?.verifiedAt ?? prior?.lastVerified ?? null;
    const current = orderedEvidence(Object.values(track.evidence)
      .filter(({ missedRuns }) => missedRuns < missingRuns)
      .map(({ observation }) => observation));
    const registry = current.find(isRegistryOffer);
    const review = registry && registryReview(registry, state, key, timestamp, verified);
    const live = review && !review.pageConfirmed
      ? current.filter((entry) => entry.confidence !== "page" || isRegistryOffer(entry))
      : current;
    const evidence = live.length ? live : orderedEvidence(Object.values(track.evidence).map(({ observation }) => observation));
    const strongest = evidence[0];
    if (!strongest) {
      delete tracks[key];
      continue;
    }
    const model = matchModel(strongest.providerModelId);
    const confirmed = model !== undefined && (live.some((entry) => entry.confidence !== "news") || (live.length > 0 && verified !== null));
    const eligible = model !== undefined && (confirmed || priorOffer !== undefined);
    // Для завершившегося публичного предложения сохраняем исходное подтверждение.
    const endedByAbsence = !live.length || (priorOffer !== undefined && !confirmed && model !== undefined);
    const authoritative = evidence.filter((entry) => entry.confidence !== "news");
    const details = endedByAbsence && priorOffer ? [] : (authoritative.length ? authoritative : evidence);
    const priorDetails = prior?.confidence === "news" && authoritative.length ? undefined : prior;
    const firstDefined = <T>(field: (entry: Observation) => T | undefined) =>
      details.map(field).find((value) => value !== undefined);

    const freeLimits = providers[strongest.providerId].freeLimits;
    const observedExpiry = firstDefined((entry) => entry.expiresAt);
    const expiresAt = observedExpiry === undefined ? priorDetails?.expiresAt ?? null : observedExpiry;
    const expired = expiresAt !== null && Date.parse(expiresAt) <= timestamp;
    if (endedByAbsence || expired) {
      const end = expired ? expiresAt : now;
      if (!track.endedAt || Date.parse(end) < Date.parse(track.endedAt)) track.endedAt = end;
      if (Date.parse(track.endedAt) <= cutoff) {
        delete tracks[key];
        continue;
      }
    } else {
      delete track.endedAt;
    }
    const failed = (track.health?.consecutiveFailures ?? 0) >= options.healthFailureThreshold;
    const needsReview = review?.needsReview && strongest.confidence !== "structured";
    const sources = live.length && !endedByAbsence
      ? live.map((entry) => entry.source)
      : prior?.sources ?? evidence.map((entry) => entry.source);
    const entry: Offer = {
      modelId: model?.id ?? (modelSlug(strongest.providerModelId) || strongest.providerModelId),
      providerId: strongest.providerId,
      providerModelId: strongest.providerModelId,
      free: true,
      promo: firstDefined((observation) => observation.promo) ?? priorDetails?.promo ?? false,
      expiresAt,
      supportsTools: track.health?.supportsTools ?? firstDefined((observation) => observation.supportsTools) ?? priorDetails?.supportsTools ?? false,
      contextWindow: firstDefined((observation) => observation.contextWindow) ?? priorDetails?.contextWindow ?? model?.contextWindow ?? 0,
      limits: { ...freeLimits, ...(firstDefined((observation) => observation.limits) ?? (endedByAbsence ? prior?.limits : undefined)) },
      status: track.endedAt ? "ended" : !eligible || needsReview ? "unverified" : failed ? "degraded" : "active",
      confidence: endedByAbsence && priorOffer ? priorOffer.confidence : strongest.confidence,
      sources,
      firstSeen: prior?.firstSeen ?? now,
      lastSeen: seen.has(key) ? now : prior?.lastSeen ?? now,
      lastVerified: verified,
      verifiedAt: registry?.verifiedAt ?? prior?.verifiedAt,
      reviewBy: registry?.reviewBy ?? prior?.reviewBy,
    };
    if (eligible) offers.push(entry);
    else candidates.push({
      ...entry,
      suggestedTier: evidence.find((observation) => observation.suggestedTier)?.suggestedTier ?? prior?.suggestedTier,
      suggestedDescription: evidence.find((observation) => observation.suggestedDescription)?.suggestedDescription ?? prior?.suggestedDescription,
    });
  }

  const catalog = sortedCatalog({
    schemaVersion: 1, generatedAt: now, models, providers: Object.values(providers), offers, candidates,
  });
  catalogSchema.parse(catalog);
  return { catalog, tracks, changes: makeChanges(previous, catalog) };
}

function makeChanges(previous: Catalog | undefined, next: Catalog): Change[] {
  const changes: Change[] = [];
  const priorOffers = new Map(previous?.offers.map((offer) => [offerKey(offer), offer]));
  const activeKeys = new Set(next.offers.map(offerKey));
  const priorCandidates = new Set(previous?.candidates.map(offerKey));
  const modelNames = new Map(next.models.map(({ id, name }) => [id, name]));
  const date = next.generatedAt;
  const nameFor = (offer: Offer) => modelNames.get(offer.modelId) ?? offer.providerModelId;
  const offerChange = (type: Change["type"], offer: Offer, text: string) => changes.push({
    type, date, text, modelId: offer.modelId, providerId: offer.providerId, providerModelId: offer.providerModelId,
  });
  const ended = (offer: Offer) => offerChange("offer_ended", offer, "Раздача " + nameFor(offer) + " у " + providers[offer.providerId].name + " закончилась");
  const details = ({ status, limits, contextWindow, supportsTools, promo, expiresAt }: Offer) =>
    stableJson({ status, limits, contextWindow, supportsTools, promo, expiresAt });
  for (const offer of next.offers) {
    const prior = priorOffers.get(offerKey(offer));
    if (offer.status === "ended") {
      if (prior && prior.status !== "ended") ended(offer);
    } else if (offer.status === "unverified") {
      if (prior && prior.status !== "unverified" && prior.status !== "ended") {
        offerChange("offer_changed", offer, "Раздача " + nameFor(offer) + " у " + providers[offer.providerId].name + " требует перепроверки");
      }
    } else if (!prior || prior.status === "ended") {
      offerChange("offer_added", offer, nameFor(offer) + " теперь бесплатно у " + providers[offer.providerId].name);
    } else if (details(prior) !== details(offer)) {
      offerChange("offer_changed", offer, "Условия раздачи " + nameFor(offer) + " у " + providers[offer.providerId].name + " изменились");
    }
  }
  for (const [key, entry] of priorOffers) {
    if (!activeKeys.has(key) && entry.status !== "ended") ended(entry);
  }
  for (const candidate of next.candidates) {
    if (candidate.status === "ended" || priorCandidates.has(offerKey(candidate))) continue;
    offerChange("candidate_added", candidate, "Проверяем сведения о бесплатной модели " + nameFor(candidate) + " у " + providers[candidate.providerId].name);
  }

  const priorModels = new Map(previous?.models.map((model) => [model.id, model]));
  for (const model of next.models) {
    const prior = priorModels.get(model.id);
    if (prior && prior.tier !== model.tier) {
      changes.push({ type: "model_tier_changed", date, modelId: model.id, text: "Уровень " + model.name + " изменился на " + model.tier });
    }
  }
  return changes;
}
