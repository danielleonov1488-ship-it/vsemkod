import { personalProviders, type PersonalKind, type PersonalModel } from "./providers";

export { isUncensored } from "./uncensored";

const subscriptionIds = new Set(["github-copilot", "openai", "xai"]);

/** Своя модель — подписка, кодинг-план, платный ключ или свой поставщик. «free» — бесплатная модель из списка провайдера (до объединения с каталогом). */
export function personalKind(model: PersonalModel, catalogProviders: readonly string[]): PersonalKind | "free" {
  if (model.kind) return model.kind;
  if (subscriptionIds.has(model.providerId)) return "subscription";
  if (model.providerId === "opencode") return "zen";
  if (catalogProviders.includes(model.providerId)) return "free";
  if (model.providerId === "custom-api" || model.providerId.startsWith("custom-")) return "custom";
  return personalProviders.find(provider => provider.id === model.providerId)?.kind ?? "api";
}

/** Адрес из документации часто вставляют целиком: …/v1/chat/completions. Оставляем базу. */
export function customBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\/(?:chat\/completions|completions|models)$/i, "").replace(/\/+$/, "");
}
