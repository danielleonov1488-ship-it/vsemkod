import { z } from "zod";

import { nativeIdSchema, personalIdSchema, providerSlugSchema } from "./providers";

export const providerIdSchema = providerSlugSchema;
const reservedIds = new Set<string>([...personalIdSchema.options, ...nativeIdSchema.options]);
const reservedProviderId = (id: string) => reservedIds.has(id) || id.startsWith("custom-");

export const communityWarning = "Новый сервис: запросы видит его владелец, не отправляйте секреты";
export const tierSchema = z.enum(["top", "good", "new", "basic"]);
export const confidenceSchema = z.enum(["structured", "page", "news"]);
export const dateSchema = z.iso.datetime({ offset: true });

export const limitsSchema = z.object({
  rpm: z.int().positive().optional(),
  rph: z.int().positive().optional(),
  rpd: z.int().positive().optional(),
  tpm: z.int().positive().optional(),
  tpd: z.int().positive().optional(),
  concurrent: z.int().positive().optional(),
  note: z.string().optional(),
  allModelsFree: z.boolean().optional(),
}).strict();

export const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  vendor: z.string().min(1),
  tier: tierSchema,
  description: z.string().min(1),
  contextWindow: z.int().positive(),
  capabilities: z.array(z.enum(["code", "tools", "reasoning", "vision"])),
  rank: z.int().nonnegative(),
  /** Только в приложении: модель найдена в списке бесплатных моделей подключённого провайдера, в каталоге её нет. */
  origin: z.literal("discovered").optional(),
}).strict();

const httpUrl = z.url({ protocol: /^https?$/ });
export const providerSchema = z.object({
  id: providerIdSchema.refine(id => !reservedProviderId(id), "Идентификатор занят личными подключениями"),
  name: z.string().min(1),
  api: z.enum(["openai", "anthropic"]),
  baseUrl: httpUrl,
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("oauth_pkce"), authorizeUrl: httpUrl, exchangeUrl: httpUrl }).strict(),
    z.object({ type: z.literal("device_code"), authorizeUrl: httpUrl, exchangeUrl: httpUrl }).strict(),
    z.object({ type: z.literal("manual_key") }).strict(),
    z.object({ type: z.literal("cloudflare") }).strict(),
  ]),
  loginMethods: z.array(z.string().min(1)),
  signupUrl: httpUrl,
  keyPageUrl: httpUrl.nullable(),
  keyPattern: z.string().nullable(),
  clicksToConnect: z.int().nonnegative(),
  freeLimits: limitsSchema,
  dataPolicy: z.string(),
  termsUrl: httpUrl,
  notes: z.string(),
  trust: z.literal("community").optional(),
}).passthrough().transform(provider => {
  const note = provider.freeLimits.note;
  if (provider.trust !== "community" || note?.includes(communityWarning)) return provider;
  return { ...provider, freeLimits: { ...provider.freeLimits, note: note ? note + " · " + communityWarning : communityWarning } };
});

export const offerSchema = z.object({
  modelId: z.string().min(1),
  providerId: providerIdSchema,
  providerModelId: z.string().min(1),
  free: z.literal(true),
  promo: z.boolean(),
  expiresAt: dateSchema.nullable(),
  supportsTools: z.boolean(),
  contextWindow: z.int().nonnegative(),
  limits: limitsSchema,
  status: z.enum(["active", "unverified", "degraded", "ended"]),
  confidence: confidenceSchema,
  sources: z.array(z.string().min(1)).min(1),
  firstSeen: dateSchema,
  lastSeen: dateSchema,
  lastVerified: dateSchema.nullable(),
  verifiedAt: dateSchema.optional(),
  reviewBy: dateSchema.optional(),
  /** Только в приложении: раздача найдена в списке бесплатных моделей подключённого провайдера. */
  origin: z.literal("discovered").optional(),
}).passthrough();

export const candidateSchema = offerSchema.extend({
  suggestedTier: tierSchema.optional(),
  suggestedDescription: z.string().min(1).max(240).optional(),
});

const supportedCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: dateSchema,
  models: z.array(modelSchema),
  providers: z.array(providerSchema),
  offers: z.array(offerSchema),
  candidates: z.array(candidateSchema),
}).strict().superRefine((catalog, ctx) => {
  const unique = (values: string[], field: string) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: [field], message: "Повторяющийся идентификатор" });
    }
  };
  const models = new Set(catalog.models.map(({ id }) => id));
  const providers = new Set(catalog.providers.map(({ id }) => id));
  unique(catalog.models.map(({ id }) => id), "models");
  unique(catalog.providers.map(({ id }) => id), "providers");
  unique([...catalog.offers, ...catalog.candidates].map(offerKey), "offers/candidates");

  for (const field of ["offers", "candidates"] as const) {
    for (const [i, offer] of catalog[field].entries()) {
      const check = (ok: boolean, message: string) => {
        if (!ok) ctx.addIssue({ code: "custom", path: [field, i], message });
      };
      check(providers.has(offer.providerId), "Неизвестный провайдер");
      check(Date.parse(offer.firstSeen) <= Date.parse(offer.lastSeen), "Некорректный порядок дат наблюдений");
      if (offer.verifiedAt || offer.reviewBy || offer.sources.includes("registry:" + offer.providerId)) {
        check(!!offer.verifiedAt && !!offer.reviewBy &&
          Date.parse(offer.verifiedAt) < Date.parse(offer.reviewBy), "Некорректный срок перепроверки реестра");
      }
      if (field === "offers") {
        check(models.has(offer.modelId), "Модели нет в реестре");
        check(offer.confidence !== "news" || offer.lastVerified !== null, "Предложение из новостей требует проверки");
      }
    }
  }
});

const catalogEntries = z.object({
  providers: z.array(z.unknown()),
  offers: z.array(z.unknown()),
  candidates: z.array(z.unknown()),
}).passthrough();
const providerEnvelope = z.object({ id: providerIdSchema, api: z.string(), auth: z.unknown() });
const authEnvelope = z.object({ type: z.string() });
const offerEnvelope = z.object({ providerId: providerIdSchema });
const supportedAuth = new Set(["none", "manual_key", "oauth_pkce", "device_code", "cloudflare"]);

export const catalogSchema = z.preprocess(input => {
  const parsed = catalogEntries.safeParse(input);
  if (!parsed.success) return input;
  const { providers, offers, candidates } = parsed.data;
  const ignored = new Set<string>();
  const compatible = providers.filter(entry => {
    const result = providerEnvelope.safeParse(entry);
    if (!result.success) return true;
    const { id, api, auth } = result.data;
    const type = authEnvelope.safeParse(auth).data?.type;
    if (api === "openai" && (!type || supportedAuth.has(type)) && !reservedProviderId(id)) return true;
    ignored.add(id);
    return false;
  });
  const visible = (entry: unknown) => {
    const result = offerEnvelope.safeParse(entry);
    return !result.success || !ignored.has(result.data.providerId);
  };
  return { ...parsed.data, providers: compatible, offers: offers.filter(visible), candidates: candidates.filter(visible) };
}, supportedCatalogSchema);

export const changeSchema = z.object({
  type: z.enum(["offer_added", "offer_ended", "offer_changed", "candidate_added", "model_tier_changed"]),
  date: dateSchema,
  text: z.string().min(1),
  modelId: z.string().min(1),
  providerId: providerIdSchema.optional(),
  providerModelId: z.string().min(1).optional(),
}).strict();
export const changesSchema = z.array(changeSchema).max(200);

export type ProviderId = z.infer<typeof providerIdSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Offer = z.infer<typeof offerSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Limits = z.infer<typeof limitsSchema>;

export function offerKey(offer: Pick<Offer, "providerId" | "providerModelId">): string {
  return offer.providerId + ":" + offer.providerModelId;
}
