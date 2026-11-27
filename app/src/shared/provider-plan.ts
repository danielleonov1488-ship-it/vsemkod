import type { Benchmarks } from "./benchmarks";
import { activeOffers, rankedModels, uncensoredModel, visibleFreeModel } from "./catalog";
import type { Catalog, Model, Provider } from "./catalog-schema";

export type ProviderValue = {
  provider: Provider;
  /** Сильные модели (не слабее GPT-5), которые даёт этот источник. */
  models: Model[];
  /** Сколько из них ещё не было ни у одного источника выше по списку. */
  fresh: number;
  limit?: string;
};

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** Коротко о бесплатном лимите: «до 1000 запросов в день», «10 млн токенов в день». */
export function limitText(provider: Provider) {
  const { rpd, tpd, rph, rpm, note } = provider.freeLimits;
  if (tpd && tpd >= 1_000_000) return number.format(tpd / 1_000_000) + " млн токенов в день";
  if (rpd) return "до " + number.format(rpd) + " запросов в день";
  if (rph) return number.format(rph) + " запросов в час";
  if (tpd) return number.format(tpd) + " токенов в день";
  if (rpm) return number.format(rpm) + " запросов в минуту";
  const sentence = note?.split(/(?<=[.!])\s/)[0]?.replace(/[.\s]+$/, "");
  return sentence ? sentence.length > 80 ? sentence.slice(0, 78).trimEnd() + "…" : sentence : undefined;
}

/**
 * Какие источники подключить, чтобы получить все сильные модели минимумом входов.
 * Жадно: каждый следующий — тот, что добавляет больше всего новых сильных моделей
 * (вес — индекс Artificial Analysis), повторы дают небольшой бонус как запас лимитов.
 * Источники без ключа уже работают и считаются покрытыми с самого начала.
 */
export function providerPlan(catalog: Catalog, benchmarks?: Benchmarks, size = 5) {
  const strong = rankedModels(catalog).filter(model => visibleFreeModel(catalog, model) && !uncensoredModel(catalog, model));
  const weight = (model: Model) => benchmarks?.models[model.id]?.index ?? (model.tier === "top" ? 25 : 12);
  const served = new Map<string, Model[]>();
  for (const model of strong) {
    for (const { offer, provider } of activeOffers(catalog, model.id)) {
      if (!offer.supportsTools) continue;
      const list = served.get(provider.id) ?? [];
      if (!list.includes(model)) list.push(model);
      served.set(provider.id, list);
    }
  }
  const sortModels = (list: Model[]) => [...list].sort((a, b) => weight(b) - weight(a));
  const covered = new Set<string>();
  for (const provider of catalog.providers) {
    if (provider.auth.type === "none") for (const model of served.get(provider.id) ?? []) covered.add(model.id);
  }
  const candidates = catalog.providers.filter(provider =>
    (provider.auth.type === "manual_key" || provider.auth.type === "oauth_pkce") && (served.get(provider.id)?.length ?? 0) > 0);
  const score = (provider: Provider) => (served.get(provider.id) ?? [])
    .reduce((sum, model) => sum + weight(model) * (covered.has(model.id) ? 0.25 : 1), 0);
  const recommended: ProviderValue[] = [];
  const rest = [...candidates];
  while (recommended.length < size && rest.length) {
    rest.sort((a, b) => score(b) - score(a) || a.clicksToConnect - b.clicksToConnect);
    const provider = rest.shift()!;
    const models = sortModels(served.get(provider.id) ?? []);
    const fresh = models.filter(model => !covered.has(model.id)).length;
    models.forEach(model => covered.add(model.id));
    recommended.push({ provider, models, fresh, limit: limitText(provider) });
  }
  rest.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, "ru"));
  const others: ProviderValue[] = rest.map(provider => {
    const models = sortModels(served.get(provider.id) ?? []);
    return { provider, models, fresh: 0, limit: limitText(provider) };
  });
  return { recommended, others, strong: strong.length, covered: covered.size };
}

/** Сколько сильных моделей уже доступно с подключёнными источниками. */
export function availableStrong(catalog: Catalog, connected: readonly string[]) {
  const strong = rankedModels(catalog).filter(model => visibleFreeModel(catalog, model) && !uncensoredModel(catalog, model));
  const ready = strong.filter(model => activeOffers(catalog, model.id)
    .some(({ offer, provider }) => offer.supportsTools && (provider.auth.type === "none" || connected.includes(provider.id))));
  return { ready: ready.length, total: strong.length };
}
