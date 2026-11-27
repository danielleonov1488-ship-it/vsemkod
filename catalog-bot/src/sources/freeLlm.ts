import { z } from "zod";
import { freeLlmDenylist } from "../config.js";
import { catalogModelMatcher, modelSlug } from "../match.js";
import { compare } from "../merge.js";
import { providers, providersUnderReview, retiredProviders } from "../registry/providers.js";
import type { Catalog, Model, RadarFreeLlmProvider } from "../schema.js";
import { request } from "./common.js";

const snapshotUrl = "https://raw.githubusercontent.com/nejib1/Free-LLM/main/router/catalog.snapshot.json";
const refreshMs = 20 * 60 * 60 * 1000;
const signupSchema = z.enum(["no", "registration"]);
const httpsUrl = z.url({ protocol: /^https$/ });

const snapshotSchema = z.object({
  providers: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1),
    type: z.string(),
    base_url: z.string().nullish(),
    openai_base_url: z.string().nullish(),
    openai_compatible: z.boolean(),
    free_tier: z.string(),
    signup_requirement: z.string(),
    rate_limit: z.string().nullish(),
    key_help_url: z.string().nullish(),
    models: z.array(z.object({ id: z.string().trim().nullish(), kind: z.string() })),
  })).min(1),
});

export type FreeLlmProvider = Omit<RadarFreeLlmProvider, "firstSeen">;
type SnapshotProvider = Omit<FreeLlmProvider, "models"> & { models: string[] };

const registeredProviders = { ...providers, ...providersUnderReview };
const providerIdsByUrl = new Map(Object.values(registeredProviders).map(({ baseUrl, id }) => [baseUrl, id]));
const providerAliases = new Map([
  ["groq-cloud", "groq"], ["kilo-gateway", "kilo"], ["z-ai", "zai"], ["ovh-ai", "ovh-ai-endpoints"],
]);

function registeredProviderId(slug: string, baseUrl: string): string | undefined {
  if (Object.hasOwn(registeredProviders, slug)) return slug;
  return providerAliases.get(slug) ?? providerIdsByUrl.get(baseUrl.replace(/\/+$/, ""));
}

export function shouldCheckFreeLlm(now: string, checkedAt?: string): boolean {
  return !checkedAt || Date.parse(now) - Date.parse(checkedAt) > refreshMs;
}

export function parseFreeLlm(input: unknown): SnapshotProvider[] {
  const selected = new Map<string, SnapshotProvider>();
  for (const provider of snapshotSchema.parse(input).providers) {
    const { slug } = provider;
    if (provider.free_tier !== "truly_free" || !provider.openai_compatible ||
        provider.type.trim().toLowerCase() === "local" || freeLlmDenylist.has(slug)) continue;
    const signup = signupSchema.safeParse(provider.signup_requirement);
    const baseUrl = httpsUrl.safeParse(provider.openai_base_url ?? provider.base_url);
    if (!signup.success || !baseUrl.success) continue;
    selected.set(slug, {
      provider: provider.name, slug, baseUrl: baseUrl.data, signup: signup.data,
      rateLimit: provider.rate_limit ?? "",
      keyHelpUrl: httpsUrl.safeParse(provider.key_help_url).data,
      models: provider.models.flatMap(({ id, kind }) => kind === "chat" && id ? [id] : []),
    });
  }
  return [...selected.values()];
}

export async function fetchFreeLlm(): Promise<SnapshotProvider[]> {
  return parseFreeLlm(await request(snapshotUrl, (response) => response.json(), {}, 0));
}

export function freeLlmModelMatcher(models: Pick<Model, "id">[]) {
  const match = catalogModelMatcher(models);
  return (id: string) => {
    const slug = modelSlug(id);
    const normalized = slug.replace(/-free$/, "").replace(/-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/, "")
      .replace(/(\d)p(?=\d)/g, "$1.");
    return match([slug, normalized]);
  };
}

export function matchFreeLlm(snapshot: SnapshotProvider[], catalog: Pick<Catalog, "models" | "offers">) {
  const match = freeLlmModelMatcher(catalog.models);
  const tiers = new Map(catalog.models.map(({ id, tier }) => [id, tier]));
  const existing = new Set(catalog.offers.map(({ providerId, modelId }) => providerId + ":" + modelId));
  const possible: { providerId: string; id: string; catalogModelId: string }[] = [];
  const candidates: { provider: FreeLlmProvider; top: number }[] = [];

  for (const { models: ids, ...provider } of snapshot) {
    const models = [...new Set(ids)].sort(compare).flatMap((id) => {
      const catalogModelId = match(id);
      return catalogModelId ? [{ id, catalogModelId }] : [];
    });
    const providerId = registeredProviderId(provider.slug, provider.baseUrl);
    if (providerId && retiredProviders.has(providerId)) continue;
    if (providerId) {
      for (const model of models) {
        if (!existing.has(providerId + ":" + model.catalogModelId)) possible.push({ providerId, ...model });
      }
      continue;
    }

    const matchedIds = new Set(models.map(({ catalogModelId }) => catalogModelId));
    const top = [...matchedIds].filter((id) => tiers.get(id) === "top").length;
    if (top || [...matchedIds].some((id) => tiers.get(id) === "good")) {
      candidates.push({ provider: { ...provider, models }, top });
    }
  }

  const radar = candidates.sort((a, b) => b.top - a.top || compare(a.provider.slug, b.provider.slug))
    .map(({ provider }) => provider);
  return { radar, possible };
}
