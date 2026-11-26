import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";
import { benchmarksSchema, type Benchmarks } from "../shared/benchmarks";
import { catalogSchema, changesSchema, type Catalog, type Change } from "../shared/catalog-schema";
import { readJson, writeJson } from "./storage";

const publicOrigin = "https://vsemkod.ru";
const mirror = "https://raw.githubusercontent.com/danielleonov1488-ship-it/vsemkod/main/catalog-bot/data";

async function download<T>(url: string, schema: ZodType<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return;
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
    if (response.ok) return schema.parse(await response.json());
  } catch { /* The next catalog source can still be available. */ }
}

export class CatalogService {
  private value?: Catalog;
  benchmarks?: Benchmarks;

  private get benchmarkCache() { return join(this.data, "benchmarks.json"); }
  private get benchmarkBundle() { return join(dirname(this.bundled), "benchmarks.json"); }
  private refreshing?: Promise<void>;
  private refreshAbort?: AbortController;
  private interval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly data: string,
    private readonly bundled: string,
    private readonly onUpdate: (catalog: Catalog, news: Change[]) => void = () => {}
  ) {}

  get current(): Catalog {
    if (!this.value) throw new Error("Каталог моделей недоступен.");
    return this.value;
  }

  async loadInitial(): Promise<void> {
    const [cached, bundled, cachedBenchmarks, bundledBenchmarks] = await Promise.all([
      readJson(join(this.data, "catalog.json"), catalogSchema), readJson(this.bundled, catalogSchema),
      readJson(this.benchmarkCache, benchmarksSchema), readJson(this.benchmarkBundle, benchmarksSchema)
    ]);
    this.benchmarks = [cachedBenchmarks, bundledBenchmarks].filter((item): item is Benchmarks => !!item)
      .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))[0];
    this.value = cached && (!bundled || Date.parse(cached.generatedAt) >= Date.parse(bundled.generatedAt)) ? cached : bundled;
    if (!this.value) await this.refresh();
    void this.current;
  }

  start(): void {
    if (this.interval) return;
    void this.refresh();
    this.interval = setInterval(() => void this.refresh(), 30 * 60_000);
    this.interval.unref();
  }

  stop(): void {
    clearInterval(this.interval);
    this.interval = undefined;
    this.refreshAbort?.abort();
  }

  async clearCache() {
    this.refreshAbort?.abort();
    await this.refreshing;
    await Promise.all([rm(join(this.data, "catalog.json"), { force: true }), rm(this.benchmarkCache, { force: true })]);
    this.benchmarks = await readJson(this.benchmarkBundle, benchmarksSchema);
  }

  refresh(): Promise<void> {
    if (this.refreshing && this.refreshAbort?.signal.aborted) return this.refreshing.then(() => {
      if (this.interval) return this.refresh();
    });
    if (this.refreshing) return this.refreshing;
    const controller = new AbortController();
    this.refreshAbort = controller;
    return this.refreshing = this.update(controller.signal).finally(() => {
      this.refreshing = undefined;
      this.refreshAbort = undefined;
    });
  }

  private async update(signal: AbortSignal): Promise<void> {
    const previous = this.value;
    const cache = join(this.data, "catalog.json");
    const fromSources = async <T>(name: string, schema: ZodType<T>) =>
      await download(publicOrigin + "/" + name, schema, signal) ?? await download(mirror + "/" + name, schema, signal);
    const [downloaded, benchmarks] = await Promise.all([
      fromSources("catalog.json", catalogSchema), fromSources("benchmarks.json", benchmarksSchema)
    ]);
    if (signal.aborted) return;
    if (benchmarks && (!this.benchmarks || Date.parse(benchmarks.generatedAt) >= Date.parse(this.benchmarks.generatedAt))) {
      this.benchmarks = benchmarks;
      await writeJson(this.benchmarkCache, benchmarks).catch(() => {});
    }
    const latest = downloaded && (!previous || Date.parse(downloaded.generatedAt) >= Date.parse(previous.generatedAt)) ? downloaded : undefined;
    const current = latest ?? previous ?? await readJson(cache, catalogSchema) ?? await readJson(this.bundled, catalogSchema);
    if (!current) return;
    const changes = latest && previous && Date.parse(latest.generatedAt) > Date.parse(previous.generatedAt)
      ? await download(publicOrigin + "/changes.json", changesSchema, signal) ?? await download(mirror + "/changes.json", changesSchema, signal)
      : undefined;
    if (signal.aborted) return;
    this.value = current;
    if (latest) await writeJson(cache, latest).catch(() => {});
    const news = changes?.filter(change =>
      change.type === "offer_added" && Date.parse(change.date) > Date.parse(previous!.generatedAt) &&
      current.models.some(model => model.id === change.modelId && model.tier === "top")
    ) ?? [];
    this.onUpdate(current, news);
  }
}
