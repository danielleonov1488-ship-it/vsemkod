import { z } from "zod";
import { keyIdSchema, type KeyId } from "../../shared/providers";
import type { ModelLatency } from "../../shared/api";
import { readJson, writeJson } from "../storage";

const counters = z.partialRecord(keyIdSchema, z.object({
  requests: z.int().nonnegative(),
  errors: z.int().nonnegative()
}));

const sample = z.object({
  modelId: z.string(), providerId: keyIdSchema, averageMs: z.number().nonnegative(), samples: z.int().positive()
});
const usage = z.object({ providers: counters, ttfb: z.array(sample) });

export class ProviderHealth {
  private counts: z.infer<typeof counters> = {};
  private firstBytes = new Map<string, z.infer<typeof sample>>();
  private cooling = new Map<KeyId, { failures: number; until: number; limited: boolean }>();
  private writes = Promise.resolve();

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (!this.path) return;
    const persisted = await readJson(this.path, usage);
    this.counts = persisted?.providers ?? await readJson(this.path, counters) ?? {};
    for (const entry of persisted?.ttfb ?? []) this.firstBytes.set(entry.providerId + "/" + entry.modelId, entry);
  }

  latencies(): ModelLatency[] {
    return [...this.firstBytes.values()].map(({ modelId, providerId, averageMs }) => ({ modelId, providerId, averageMs }));
  }

  firstByte(providerId: KeyId, modelId: string, ms: number): number {
    const key = providerId + "/" + modelId;
    const previous = this.firstBytes.get(key);
    const samples = (previous?.samples ?? 0) + 1;
    const averageMs = previous ? previous.averageMs + (ms - previous.averageMs) / samples : ms;
    this.firstBytes.set(key, { modelId, providerId, averageMs, samples });
    this.save();
    return averageMs;
  }

  ready(id: KeyId): boolean {
    return (this.cooling.get(id)?.until ?? 0) <= this.now();
  }

  failures(id: KeyId): number {
    return this.cooling.get(id)?.failures ?? 0;
  }

  limited(id: KeyId): boolean {
    return !this.ready(id) && this.cooling.get(id)?.limited === true;
  }

  request(id: KeyId): void {
    (this.counts[id] ??= { requests: 0, errors: 0 }).requests++;
    this.save();
  }

  success(id: KeyId): void {
    const state = this.cooling.get(id);
    if (state && state.until <= this.now()) this.cooling.delete(id);
  }

  error(id: KeyId, cooldown?: "quota" | "unavailable", retryAfter?: string | null): void {
    (this.counts[id] ??= { requests: 0, errors: 0 }).errors++;
    if (cooldown) {
      const failures = this.failures(id) + 1;
      const now = this.now();
      const retryMs = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim())
        ? Number(retryAfter) * 1000
        : (retryAfter ? Date.parse(retryAfter) - now : NaN);
      const delay = Number.isFinite(retryMs) && retryMs >= 0
        ? retryMs : 30_000 * 2 ** Math.min(failures - 1, 8);
      this.cooling.set(id, {
        failures, until: Math.max(now + delay, this.cooling.get(id)?.until ?? 0), limited: cooldown === "quota"
      });
    }
    this.save();
  }

  reset(id: KeyId) { this.cooling.delete(id); }

  flush(): Promise<void> { return this.writes; }

  private save(): void {
    const path = this.path;
    if (path) this.writes = this.writes.then(() => writeJson(path, {
      providers: this.counts, ttfb: [...this.firstBytes.values()]
    })).catch(() => {});
  }
}
