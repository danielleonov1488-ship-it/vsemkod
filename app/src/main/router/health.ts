import { z } from "zod";
import { keyIdSchema, nativeIdSchema, type KeyId } from "../../shared/providers";
import type { KeyCredits, ModelLatency, ModelSpeed, ReplySpeed, RouterStats } from "../../shared/api";
import type { Catalog } from "../../shared/catalog-schema";
import { readJson, writeJson } from "../storage";
import { day, keyCredits, parseRateHeaders, providerQuota, rateHeaders } from "./quotas";

const counters = z.partialRecord(keyIdSchema, z.object({
  requests: z.int().nonnegative(),
  errors: z.int().nonnegative()
}));

const sample = z.object({
  modelId: z.string(), providerId: keyIdSchema, averageMs: z.number().nonnegative(), samples: z.int().positive()
});
const windows = z.partialRecord(keyIdSchema, z.array(z.number()));
const headers = z.partialRecord(keyIdSchema, rateHeaders);
const speedSample = z.object({
  modelId: z.string(), providerId: z.union([keyIdSchema, nativeIdSchema]),
  samples: z.array(z.number().positive()).min(1).max(5)
});
const recentReply = z.object({
  sessionId: z.string(), speed: z.object({ tokensPerSecond: z.number().positive(), firstTokenMs: z.number().nonnegative(), estimated: z.boolean().optional() })
});
const usage = z.object({ providers: counters, ttfb: z.array(sample),
  windows: windows.optional(), headers: headers.optional(), credits: keyCredits.optional(), creditsCheckedAt: z.number().optional(), speeds: z.array(speedSample).optional(), replies: z.array(recentReply).optional() });

export class ProviderHealth {
  private counts: z.infer<typeof counters> = {};
  private lastReplies = new Map<string, ReplySpeed>();
  private replySpeeds = new Map<string, z.infer<typeof speedSample>>();
  private firstBytes = new Map<string, z.infer<typeof sample>>();
  private windows: z.infer<typeof windows> = {};
  private headers: z.infer<typeof headers> = {};
  private credits?: KeyCredits;
  private creditsCheckedAt?: number;
  private cooling = new Map<KeyId, { failures: number; until: number; limited: boolean }>();
  private writes = Promise.resolve();

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (!this.path) return;
    const persisted = await readJson(this.path, usage);
    this.counts = persisted?.providers ?? await readJson(this.path, counters) ?? {};
    this.windows = persisted?.windows ?? {};
    this.headers = persisted?.headers ?? {};
    this.credits = persisted?.credits;
    this.creditsCheckedAt = persisted?.creditsCheckedAt;
    for (const entry of persisted?.replies?.slice(-1000) ?? []) this.lastReplies.set(entry.sessionId, entry.speed);
    for (const entry of persisted?.speeds ?? []) this.replySpeeds.set(entry.providerId + "/" + entry.modelId, entry);
    for (const entry of persisted?.ttfb ?? []) this.firstBytes.set(entry.providerId + "/" + entry.modelId, entry);
  }

  speeds(): ModelSpeed[] {
    return [...this.replySpeeds.values()].map(entry => this.averageSpeed(entry));
  }

  lastReply(sessionId: string) { return this.lastReplies.get(sessionId); }

  recordSpeed(modelId: string, providerId: ModelSpeed["providerId"], tokensPerSecond: number, reply?: { sessionId: string; speed: ReplySpeed }) {
    if (reply) {
      this.lastReplies.delete(reply.sessionId);
      this.lastReplies.set(reply.sessionId, reply.speed);
      if (this.lastReplies.size > 1000) this.lastReplies.delete(this.lastReplies.keys().next().value!);
    }
    const key = providerId + "/" + modelId;
    const samples = [...(this.replySpeeds.get(key)?.samples ?? []), tokensPerSecond].slice(-5);
    const entry = { modelId, providerId, samples };
    this.replySpeeds.set(key, entry);
    this.save();
    return this.averageSpeed(entry);
  }

  private averageSpeed({ modelId, providerId, samples }: z.infer<typeof speedSample>): ModelSpeed {
    return { modelId, providerId, tokensPerSecond: samples.reduce((sum, value) => sum + value, 0) / samples.length };
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

  request(id: KeyId, trackWindow = true): void {
    (this.counts[id] ??= { requests: 0, errors: 0 }).requests++;
    if (trackWindow) {
      const now = this.now();
      this.windows[id] = [...(this.windows[id] ?? []).filter(at => at > now - day && at <= now), now];
    }
    this.save();
  }

  response(id: KeyId, responseHeaders: Headers): void {
    const parsed = parseRateHeaders(responseHeaders, this.now());
    if (parsed) this.headers[id] = parsed;
    else if (this.headers[id]) delete this.headers[id];
    else return;
    this.save();
  }

  stats(catalog: Catalog): RouterStats {
    const now = this.now();
    const result: RouterStats = {};
    for (const id of keyIdSchema.options.flatMap(schema => schema.options)) {
      const limits = catalog.providers.find(provider => provider.id === id)?.freeLimits ?? {};
      const entry = this.headers[id];
      const requests = providerQuota(id, limits, entry, this.windows[id] ?? [], now);
      const tokens = entry?.tokens && now < (entry.tokens.resetAt ?? entry.at + day) ? entry.tokens : undefined;
      const credits = id === "openrouter" ? this.credits : undefined;
      if (requests || tokens || credits) result[id] = { requests, tokens, credits };
    }
    return result;
  }

  beginCreditsCheck(): boolean {
    const now = this.now();
    if (this.creditsCheckedAt !== undefined && now < this.creditsCheckedAt + 600_000) return false;
    this.creditsCheckedAt = now;
    this.save();
    return true;
  }

  setCredits(credits: KeyCredits) {
    this.credits = credits;
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

  reset(id: KeyId) {
    this.cooling.delete(id);
    delete this.windows[id];
    delete this.headers[id];
    if (id === "openrouter") this.credits = undefined;
    this.save();
  }

  flush(): Promise<void> { return this.writes; }

  private save(): void {
    const path = this.path;
    if (path) this.writes = this.writes.then(() => writeJson(path, {
      providers: this.counts, ttfb: [...this.firstBytes.values()], windows: this.windows, headers: this.headers,
      credits: this.credits, creditsCheckedAt: this.creditsCheckedAt,
      replies: this.lastReplies.size ? [...this.lastReplies].map(([sessionId, speed]) => ({ sessionId, speed })) : undefined,
      speeds: this.replySpeeds.size ? [...this.replySpeeds.values()] : undefined
    })).catch(() => {});
  }
}
