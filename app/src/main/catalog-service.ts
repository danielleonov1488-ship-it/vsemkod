import { join } from "node:path";
import type { ZodType } from "zod";
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
    this.value = await readJson(join(this.data, "catalog.json"), catalogSchema) ??
      await readJson(this.bundled, catalogSchema);
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
    const latest = await download(publicOrigin + "/catalog.json", catalogSchema, signal) ??
      await download(mirror + "/catalog.json", catalogSchema, signal);
    if (signal.aborted) return;
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
