import { join } from "node:path";
import type { ZodType } from "zod";
import { catalogSchema, changesSchema, type Catalog, type Change } from "../shared/catalog-schema";
import { readJson, writeJson } from "./storage";

const publicOrigin = "https://vsemkod.ru";
const mirror = "https://raw.githubusercontent.com/danielleonov1488-ship-it/vsemkod/main/catalog-bot/data";

async function download<T>(url: string, schema: ZodType<T>): Promise<T | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (response.ok) return schema.parse(await response.json());
  } catch { /* The next catalog source can still be available. */ }
}

export class CatalogService {
  private value?: Catalog;
  private refreshing?: Promise<void>;
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
    void this.refresh();
    this.interval ??= setInterval(() => void this.refresh(), 30 * 60_000);
    this.interval.unref();
  }

  stop(): void {
    clearInterval(this.interval);
    this.interval = undefined;
  }

  refresh(): Promise<void> {
    return this.refreshing ??= this.update().finally(() => { this.refreshing = undefined; });
  }

  private async update(): Promise<void> {
    const previous = this.value;
    const cache = join(this.data, "catalog.json");
    const latest = await download(publicOrigin + "/catalog.json", catalogSchema) ??
      await download(mirror + "/catalog.json", catalogSchema);
    this.value = latest ?? previous ?? await readJson(cache, catalogSchema) ?? await readJson(this.bundled, catalogSchema);
    if (!this.value) return;
    if (latest) await writeJson(cache, latest).catch(() => {});
    const changes = latest && previous && Date.parse(latest.generatedAt) > Date.parse(previous.generatedAt)
      ? await download(publicOrigin + "/changes.json", changesSchema) ?? await download(mirror + "/changes.json", changesSchema)
      : undefined;
    const news = changes?.filter(change =>
      change.type === "offer_added" && Date.parse(change.date) > Date.parse(previous!.generatedAt) &&
      this.value?.models.some(model => model.id === change.modelId && model.tier === "top")
    ) ?? [];
    this.onUpdate(this.value, news);
  }
}
