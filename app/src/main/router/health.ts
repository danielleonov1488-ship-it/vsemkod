import { z } from "zod";
import { providerIdSchema, type ProviderId } from "../../shared/catalog-schema";
import { readJson, writeJson } from "../storage";

const counters = z.partialRecord(providerIdSchema, z.object({
  requests: z.int().nonnegative(),
  errors: z.int().nonnegative()
}));

export class ProviderHealth {
  private counts: z.infer<typeof counters> = {};
  private cooling = new Map<ProviderId, { failures: number; until: number; limited: boolean }>();
  private writes = Promise.resolve();

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (this.path) this.counts = await readJson(this.path, counters) ?? {};
  }

  ready(id: ProviderId): boolean {
    return (this.cooling.get(id)?.until ?? 0) <= this.now();
  }

  failures(id: ProviderId): number {
    return this.cooling.get(id)?.failures ?? 0;
  }

  limited(id: ProviderId): boolean {
    return !this.ready(id) && this.cooling.get(id)?.limited === true;
  }

  request(id: ProviderId): void {
    (this.counts[id] ??= { requests: 0, errors: 0 }).requests++;
    this.save();
  }

  success(id: ProviderId): void {
    const state = this.cooling.get(id);
    if (state && state.until <= this.now()) this.cooling.delete(id);
  }

  error(id: ProviderId, cooldown?: "quota" | "unavailable", retryAfter?: string | null): void {
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

  flush(): Promise<void> { return this.writes; }

  private save(): void {
    const path = this.path;
    if (path) this.writes = this.writes.then(() => writeJson(path, this.counts)).catch(() => {});
  }
}
