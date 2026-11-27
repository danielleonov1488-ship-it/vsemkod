import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { catalogChanged, compare, stableJson } from "./merge.js";
import { radarChanged } from "./radar.js";
import { catalogSchema, changesSchema, legacyProviderIds, offerKey, radarSchema } from "./schema.js";
import type { Catalog, Change, Discovered, Limits, Radar, RadarFreeLlmProvider, RadarObservation, RadarProvider } from "./schema.js";
import { newState, stateSchema } from "./state.js";
import type { State } from "./state.js";
import type { Config } from "./config.js";
import { providers } from "./registry/providers.js";
import { benchmarksChanged, benchmarksSchema } from "./sources/artificialAnalysis.js";
import type { Benchmarks } from "./sources/artificialAnalysis.js";
import { request } from "./sources/common.js";

const dataDir = "data";
const catalogFile = "catalog.json";
const catalogV2File = "catalog-v2.json";
const changesFile = "changes.json";
const stateFile = "state.json";
const radarFile = "radar.json";
const benchmarksFile = "benchmarks.json";
const pendingFile = ".pending.json";

const pendingSchema = z.object({
  catalog: catalogSchema.optional(),
  catalogV2: catalogSchema.optional(),
  changes: changesSchema.optional(),
  state: stateSchema.optional(),
  radar: radarSchema.optional(),
  benchmarks: benchmarksSchema.optional(),
});
type Pending = z.infer<typeof pendingSchema>;

async function read<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const content = await readFile(join(dataDir, file), "utf8");
    return schema.parse(JSON.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(dataDir + "/" + file + ": не удалось прочитать или проверить JSON", { cause: error });
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const path = join(dataDir, file);
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, stableJson(data), { encoding: "utf8", flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function writePending(pending: Pending): Promise<void> {
  if (pending.changes) await writeAtomic(changesFile, pending.changes);
  if (pending.catalog) await writeAtomic(catalogFile, pending.catalog);
  if (pending.catalogV2) await writeAtomic(catalogV2File, pending.catalogV2);
  if (pending.radar) await writeAtomic(radarFile, pending.radar);
  if (pending.benchmarks) await writeAtomic(benchmarksFile, pending.benchmarks);
  if (pending.state) await writeAtomic(stateFile, pending.state);
}

export async function readCatalog(): Promise<Catalog | undefined> {
  return read(catalogFile, catalogSchema);
}

export function readCatalogV2(): Promise<Catalog | undefined> {
  return read(catalogV2File, catalogSchema);
}

const legacyIds = new Set<string>(legacyProviderIds);

export function legacyCatalog(catalog: Catalog): Catalog {
  const legacyLimits = ({ allModelsFree: _allModelsFree, ...limits }: Limits) => limits;
  const legacyOffers = <T extends Catalog["offers"][number]>(offers: T[]) => offers
    .filter(({ providerId }) => legacyIds.has(providerId))
    .map(offer => ({ ...offer, limits: legacyLimits(offer.limits) }));
  const modelsInV2Only = new Set(catalog.offers.filter(offer => !legacyIds.has(offer.providerId)).map(offer => offer.modelId));
  const offers = legacyOffers(catalog.offers);
  const legacyModelIds = new Set(offers.map(({ modelId }) => modelId));
  for (const offer of offers) modelsInV2Only.delete(offer.modelId);
  return { ...catalog,
    models: catalog.models.filter(model => !modelsInV2Only.has(model.id) || legacyModelIds.has(model.id)),
    providers: catalog.providers.filter(provider => legacyIds.has(provider.id))
      .map(({ trust: _trust, ...provider }) => ({ ...provider, freeLimits: legacyLimits(provider.freeLimits) })),
    offers, candidates: legacyOffers(catalog.candidates),
  };
}

export async function readRadar(): Promise<Radar | undefined> {
  return read(radarFile, radarSchema);
}

export async function readBenchmarks(): Promise<Benchmarks | undefined> {
  return read(benchmarksFile, benchmarksSchema);
}

export async function readPublication(dryRun: boolean): Promise<{
  catalog?: Catalog; legacy?: Catalog; hasV2: boolean; changes: Change[]; state: State; radar?: Radar; benchmarks?: Benchmarks;
}> {
  const pending = await read(pendingFile, pendingSchema);
  if (pending && !dryRun) {
    await writePending(pending);
    await unlink(join(dataDir, pendingFile));
  }
  const [catalogV2, legacy, changes, state, radar, benchmarks] = await Promise.all([
    pending?.catalogV2 ?? readCatalogV2(),
    pending?.catalog ?? readCatalog(),
    pending?.changes ?? read(changesFile, changesSchema),
    pending?.state ?? read(stateFile, stateSchema),
    pending?.radar ?? readRadar(),
    pending?.benchmarks ?? readBenchmarks(),
  ]);
  return { catalog: catalogV2 ?? legacy, legacy, hasV2: !!catalogV2, changes: changes ?? [], state: state ?? newState(), radar, benchmarks };
}

export async function publish(
  previous: Awaited<ReturnType<typeof readPublication>>,
  catalog: Catalog, events: Change[], state: State, dryRun: boolean,
  radar?: Radar, benchmarks?: Benchmarks,
): Promise<boolean> {
  const changed = !previous.hasV2 || catalogChanged(previous.catalog, catalog);
  if (dryRun) return changed;
  const pending: Pending = {};
  const legacy = legacyCatalog(catalog);
  if (changed) pending.catalogV2 = catalog;
  if (catalogChanged(previous.legacy, legacy)) pending.catalog = legacy;
  if (radar && radarChanged(previous.radar, radar)) pending.radar = radar;
  if (benchmarks && benchmarksChanged(previous.benchmarks, benchmarks)) pending.benchmarks = benchmarks;
  if (events.length || !previous.catalog) {
    pending.changes = [...events, ...previous.changes].sort((a, b) =>
      Date.parse(b.date) - Date.parse(a.date) ||
      compare(a.type, b.type) || compare(a.modelId, b.modelId) ||
      compare(a.providerId ?? "", b.providerId ?? "") ||
      compare(a.providerModelId ?? "", b.providerModelId ?? ""),
    ).slice(0, 200).map(event => event.providerId && !legacyIds.has(event.providerId)
      ? { ...event, providerId: undefined } : event);
  }
  if (stableJson(state) !== stableJson(previous.state) || !previous.catalog) pending.state = state;
  if (Object.keys(pending).length === 0) return changed;

  await mkdir(dataDir, { recursive: true });
  if (Object.keys(pending).length === 1) {
    await writePending(pending);
  } else {
    await writeAtomic(pendingFile, pending);
    await writePending(pending);
    await unlink(join(dataDir, pendingFile));
  }
  return changed;
}

export function saveState(state: State): Promise<void> {
  return writeAtomic(stateFile, state);
}

export async function notifyTelegram(
  config: NonNullable<Config["telegram"]>, events: Change[], catalog: Catalog,
  radarAdded: RadarObservation[] = [], providerAdded: RadarProvider[] = [],
  freeLlmAdded: RadarFreeLlmProvider[] = [], discovered: Discovered[] = [], qualityWarning?: string,
): Promise<boolean> {
  const models = new Map(catalog.models.map((model) => [model.id, model]));
  const active = new Set(catalog.offers.filter(({ status }) => status === "active").map(offerKey));
  const lines = new Set<string>();
  for (const event of events) {
    const { providerId, providerModelId } = event;
    const model = models.get(event.modelId);
    if (event.type !== "offer_added" || !providerId || !providerModelId || model?.tier !== "top" ||
        !active.has(offerKey({ providerId, providerModelId }))) continue;
    lines.add(model.name + " бесплатно у " + providers[providerId].name);
  }
  const notices = radarAdded.map(({ name }) => "Радар: в OpenCode Zen появилась бесплатная модель " + name);
  notices.push(...providerAdded.map(({ name, section }) =>
    "Новый бесплатный провайдер в awesome-free-llm-apis: " + name +
    (section === "provider_api" ? " (разработчик моделей)" : " (инференс-провайдер)")));
  notices.push(...freeLlmAdded.map(({ provider, signup, models: matches }) => {
    const names = [...new Set(matches.map(({ catalogModelId }) => models.get(catalogModelId)?.name ?? catalogModelId))];
    const access = signup === "no" ? "без регистрации" : "с регистрацией";
    return "Free-LLM: " + names.join(", ") + " бесплатно у " + provider + " (" + access + ") — кандидат в каталог";
  }));
  notices.push(...discovered.map(item => "Новый бесплатный источник: " + item.name + " " + item.baseUrl +
    ", модели " + (item.models.slice(0, 8).join(", ") || item.probedModel || "не указаны") +
    ", проверка: " + item.probe.status + (item.probe.tools === null ? "" : ", tools " + (item.probe.tools ? "да" : "нет")) +
    ", источник: " + item.sources.at(-1)));
  if (lines.size) notices.unshift(lines.size === 1
    ? "🦛 Новая раздача: " + [...lines][0] + ". Подключить — в vsemkod"
    : "🦛 Новые раздачи\n" + [...lines].map((line) => "• " + line).join("\n").slice(0, 3700) + "\nПодключить — в vsemkod");
  if (qualityWarning) notices.unshift(qualityWarning);
  if (!notices.length) return false;
  const messages: string[] = [];
  let current = "";
  for (const notice of notices) {
    const line = notice.slice(0, 4096);
    if (current && current.length + line.length + 1 > 4096) {
      messages.push(current);
      current = "";
    }
    current = current ? current + "\n" + line : line;
  }
  if (current) messages.push(current);
  for (const text of messages) {
    const response = await request("https://api.telegram.org/bot" + config.token + "/sendMessage",
      (result) => result.json(), {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text }),
      }, 0);
    if (!z.object({ ok: z.literal(true) }).safeParse(response).success) throw new Error("Telegram не подтвердил отправку");
  }
  return true;
}
