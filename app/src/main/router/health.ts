import { z } from "zod";
import { keyIdSchema, type KeyId } from "../../shared/providers";
import { readJson, writeJson } from "../storage";

const counters = z.partialRecord(keyIdSchema, z.object({
  requests: z.int().nonnegative(),
  errors: z.int().nonnegative()
}));

export class ProviderHealth {
  private counts: z.infer<typeof counters> = {};
  private cooling = new Map<KeyId, { failures: number; until: number; limited: boolean }>();
  private writes = Promise.resolve();

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (this.path) this.counts = await readJson(this.path, counters) ?? {};
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
    if (path) this.writes = this.writes.then(() => writeJson(path, this.counts)).catch(() => {});
  }
}
