import { feedIds, readConfig, sourceSelectors, structuredIds, watchedPages } from "./config.js";
import { checkOffers } from "./health.js";
import { LlmClient } from "./llm/client.js";
import { mergeCatalog } from "./merge.js";
import { notifyTelegram, publish, readBenchmarks, readCatalog, readPublication, readRadar } from "./publish.js";
import { mergeProviderRadar, mergeRadar, radarChanged } from "./radar.js";
import { registryBatches, registryPageHash } from "./registry/offers.js";
import type { RadarProvider } from "./schema.js";
import { benchmarksChanged, fetchBenchmarks, shouldRefreshBenchmarks } from "./sources/artificialAnalysis.js";
import type { Benchmarks } from "./sources/artificialAnalysis.js";
import { describeError } from "./sources/common.js";
import type { SourceResult } from "./sources/common.js";
import { fetchFeed, processFeed } from "./sources/feeds.js";
import { fetchFreeListProviders, shouldCheckFreeList } from "./sources/freeList.js";
import { fetchKilo } from "./sources/kilo.js";
import { fetchNumes } from "./sources/numes.js";
import { fetchOpenCodeZen } from "./sources/opencodeZen.js";
import { fetchOpenRouter } from "./sources/openrouter.js";
import { fetchPageText, processPage } from "./sources/watchPages.js";
import { pruneState } from "./state.js";

function parseFlags(args: string[]) {
  let dryRun = false;
  let noLlm = false;
  let only: string | undefined;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-llm") noLlm = true;
    else if (arg.startsWith("--only=") && only === undefined) only = arg.slice("--only=".length);
    else throw new Error("Неизвестный или повторный флаг " + arg);
  }
  if (only !== undefined && !sourceSelectors.includes(only)) {
    throw new Error("--only ожидает один из источников " + sourceSelectors.join(", "));
  }
  return { dryRun, noLlm, only };
}

async function update(args: string[]): Promise<void> {
  const { dryRun, noLlm, only } = parseFlags(args);
  const config = readConfig();
  const now = new Date().toISOString();
  const previous = await readPublication(dryRun);
  const state = structuredClone(previous.state);
  pruneState(state, now);
  const llm = new LlmClient(config.llm);
  const useLlm = !noLlm && !!config.llm.key;
  const batches: SourceResult[] = only ? [] : registryBatches();
  const errors: string[] = [];
  const failure = (id: string, error: unknown) => errors.push(id + " — " + describeError(error));

  const structured = { openrouter: fetchOpenRouter, kilo: fetchKilo, numes: () => fetchNumes(config.numesKey) };
  const structuredJobs = structuredIds.filter((id) => !only || only === id)
    .map((id) => ({ id, load: structured[id] }));
  const pages = watchedPages.filter(({ providerId }) =>
    (!only || only === "watchPages" || only === "page:" + providerId) &&
    (useLlm || registryPageHash(providerId) !== undefined),
  );
  const feeds = useLlm ? feedIds.filter((id) => !only || only === "feeds" || only === id) : [];

  const checkFreeList = (!only || only === "free-list") && shouldCheckFreeList(now, state.freeListCheckedAt);

  const [apiResults, pageResults, feedResults, [zenResult], [freeListResult]] = await Promise.all([
    Promise.allSettled(structuredJobs.map(({ load }) => load())),
    Promise.allSettled(pages.map(fetchPageText)),
    Promise.allSettled(feeds.map((id) => fetchFeed[id]())),
    Promise.allSettled(!only || only === "opencode-zen" ? [fetchOpenCodeZen()] : []),
    Promise.allSettled(checkFreeList ? [fetchFreeListProviders()] : []),
  ]);
  for (const [i, result] of apiResults.entries()) {
    if (result.status === "fulfilled") batches.push(result.value);
    else failure(structuredJobs[i].id, result.reason);
  }
  for (const [i, result] of pageResults.entries()) {
    const page = pages[i];
    const id = "page:" + page.providerId;
    if (result.status === "rejected") {
      failure(id, result.reason);
      continue;
    }
    try {
      const batch = await processPage(page, result.value, useLlm ? llm : undefined, state, now);
      if (useLlm && batch.complete === false) errors.push(id + " — отложено из-за бюджета LLM");
      batches.push(batch);
    } catch (error) {
      failure(id, error);
    }
  }
  for (const [i, result] of feedResults.entries()) {
    const id = feeds[i];
    if (result.status === "rejected") {
      failure(id, result.reason);
      continue;
    }
    const batch = await processFeed(id, result.value, llm, state, now);
    batches.push(batch);
    errors.push(...batch.errors.map((error) => id + " — " + error));
    if (batch.complete === false && !batch.errors.length) errors.push(id + " — часть записей отложена из-за бюджета LLM");
  }
  const zen = zenResult?.status === "fulfilled"
    ? mergeRadar(previous.radar, zenResult.value, now, state.radarMissingSince)
    : undefined;
  if (zen) state.radarMissingSince = zen.missingSince;
  if (zenResult?.status === "rejected") failure("opencode-zen", zenResult.reason);

  let radar = zen?.radar ?? previous.radar;
  let providersAdded: RadarProvider[] = [];
  if (freeListResult) {
    state.freeListCheckedAt = now;
    if (freeListResult.status === "fulfilled") {
      const current = freeListResult.value;
      const result = mergeProviderRadar(radar, state.freeListProviders, current, now);
      state.freeListProviders = current;
      radar = result.radar;
      providersAdded = result.added;
    } else {
      failure("awesome-free-llm-apis", freeListResult.reason);
    }
  }

  const options = { now, ...config };
  let merged = mergeCatalog(previous.catalog, state, batches, options);
  if (!dryRun && !only && Object.keys(config.healthKeys).length) {
    const health = await checkOffers(merged.catalog, merged.tracks, config, now);
    if (Object.keys(health.updates).length) merged = mergeCatalog(previous.catalog, state, batches, options, health.updates);
    errors.push(...health.errors.map((error) => "Health-check " + error));
  }
  state.tracks = merged.tracks;
  const { catalog, changes } = merged;
  let benchmarks: Benchmarks | undefined;
  if (!only || only === "benchmarks") {
    if (!config.aaKey) console.log("Artificial Analysis пропущен: AA_API_KEY не задан.");
    else if (shouldRefreshBenchmarks(now, previous.benchmarks?.generatedAt, state.benchmarksAttemptedAt)) {
      // Дата попытки ограничивает расход квоты при ошибке и при ответе без изменений.
      state.benchmarksAttemptedAt = now;
      try {
        benchmarks = await fetchBenchmarks(config.aaKey, catalog.models, now);
      } catch (error) {
        failure("Artificial Analysis", error);
      }
    }
  }
  const changed = await publish(previous, catalog, changes, state, dryRun, radar, benchmarks);
  if (config.telegram && !dryRun) {
    try {
      if (await notifyTelegram(config.telegram, changes, catalog, zen?.added, providersAdded)) {
        console.log("Telegram: отправлено одно сообщение.");
      }
    } catch (error) {
      failure("Telegram", error);
    }
  }

  const active = catalog.offers.filter((offer) => offer.status === "active");
  const degraded = catalog.offers.filter((offer) => offer.status === "degraded");
  const unverified = catalog.offers.filter((offer) => offer.status === "unverified");
  const ended = catalog.offers.filter((offer) => offer.status === "ended");
  if (!useLlm) console.log("LLM выключена. Страницы реестра проверяются по хешам.");
  console.log("Предложения: " + active.length + " активных, " + unverified.length + " на перепроверке, " + degraded.length + " с ошибками, " + ended.length + " завершённых. Кандидаты: " + catalog.candidates.length + ".");
  for (const { id, observations } of batches) console.log("  " + id + " — наблюдений " + observations.length);
  if (zen) {
    const active = zen.radar.models.filter((model) => model.active).length;
    console.log("Радар OpenCode Zen: " + active + " активных, " + zen.added.length + " новых.");
    for (const model of zen.added) console.log("  " + model.name + " (" + model.id + ")");
  }
  if (freeListResult?.status === "fulfilled") {
    console.log("Радар awesome-free-llm-apis: " + freeListResult.value.length + " провайдеров, " + providersAdded.length + " новых.");
  }
  if (radar && radarChanged(previous.radar, radar)) {
    console.log(dryRun ? "Пробный запуск: радар изменился бы." : "Радар записан.");
  }
  if (benchmarks) {
    const updated = benchmarksChanged(previous.benchmarks, benchmarks);
    console.log("Artificial Analysis: моделей " + Object.keys(benchmarks.models).length + ". " +
      (updated ? (dryRun ? "Пробный запуск: benchmarks.json изменился бы." : "benchmarks.json записан.") : "benchmarks.json не изменился."));
  }
  const added = changes.filter(({ type }) => type === "offer_added").length;
  const finished = changes.filter(({ type }) => type === "offer_ended").length;
  console.log("Добавлено " + added + ", завершено " + finished + ".");
  for (const change of changes) console.log("  " + change.text);
  console.log("Ошибок источников и проверок: " + errors.length + ".");
  for (const error of errors) console.log("  " + error);
  const cost = llm.costUsd;
  console.log("LLM: " + llm.usage.requests + " запросов, " + llm.usage.tokens + " токенов" +
    (cost === null ? ", стоимость зависит от тарифа." : ", около $" + cost.toFixed(5) + "."));
  console.log(dryRun ? (changed ? "Пробный запуск: каталог изменился бы." : "Пробный запуск: изменений каталога нет.")
    : changed ? "Каталог записан." : "Каталог не изменился.");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate" && !args.length) {
    const [catalog, radar, benchmarks] = await Promise.all([readCatalog(), readRadar(), readBenchmarks()]);
    if (!catalog) throw new Error("Отсутствует data/catalog.json");
    console.log("data/catalog.json соответствует схеме v" + catalog.schemaVersion + ".");
    if (radar) console.log("data/radar.json соответствует схеме v" + radar.schemaVersion + ".");
    if (benchmarks) console.log("data/benchmarks.json соответствует схеме v" + benchmarks.schemaVersion + ".");
  } else if (command === "update") {
    await update(args);
  } else {
    throw new Error("Команды: update [--dry-run] [--no-llm] [--only=<источник>], validate");
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  if (error instanceof Error && error.cause) console.error(describeError(error.cause));
  process.exitCode = 1;
});
