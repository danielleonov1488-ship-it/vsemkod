import { z } from "zod";
import type { QuotaPeriod, RequestQuota } from "../../shared/api";
import type { Provider } from "../../shared/catalog-schema";

const minute = 60_000;
const hour = 60 * minute;
export const day = 24 * hour;
const duration = { minute, hour, day };

const counter = z.object({ limit: z.number().positive().optional(), remaining: z.number().nonnegative().optional(), resetAt: z.number().optional() });
export const rateHeaders = z.object({ at: z.number(), requests: counter.optional(), tokens: counter.optional() });
export type RateHeaders = z.infer<typeof rateHeaders>;

function resetTime(value: string | null, now: number) {
  if (!value?.trim()) return;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1e12) return n;
    if (n >= 1e9) return n * 1000;
    return now + n * 1000;
  }
  const parts = /(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/.exec(raw);
  if (parts?.[0] === raw) {
    const [, d = "0", h = "0", m = "0", s = "0", ms = "0"] = parts;
    return now + +d * day + +h * hour + +m * minute + +s * 1000 + +ms;
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? date : undefined;
}

export function parseRateHeaders(headers: Headers, at: number): RateHeaders | undefined {
  function read(metric: string, suffix: string) {
    return headers.get("x-ratelimit-" + metric + suffix);
  }
  function parse(suffix: string, fallback?: string) {
    const header = (metric: string) => read(metric, suffix) ?? (fallback === undefined ? null : read(metric, fallback));
    const count = (metric: string) => {
      const value = header(metric);
      return value && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
    };
    const limit = count("limit") || undefined;
    const remaining = count("remaining");
    const resetAt = resetTime(header("reset"), at);
    if (limit !== undefined || remaining !== undefined || resetAt !== undefined) return { limit, remaining, resetAt };
  }
  const requests = parse("-requests", "");
  const tokens = parse("-tokens");
  return requests || tokens ? { at, requests, tokens } : undefined;
}

type RequestLimits = Pick<Provider["freeLimits"], "rph" | "rpd">;

export function localQuota(times: readonly number[], limits: RequestLimits, now: number): RequestQuota | undefined {
  const midnight = Math.floor(now / day) * day;
  const candidates: RequestQuota[] = [];
  if (limits.rph) {
    const recent = times.filter(at => at > now - hour && at <= now);
    candidates.push({ limit: limits.rph, remaining: Math.max(0, limits.rph - recent.length),
      resetAt: recent.length ? recent[Math.max(0, recent.length - limits.rph)] + hour : undefined, period: "hour", source: "local" });
  }
  if (limits.rpd) {
    const used = times.filter(at => at >= midnight && at <= now).length;
    candidates.push({ limit: limits.rpd, remaining: Math.max(0, limits.rpd - used),
      resetAt: midnight + day, period: "day", source: "local" });
  }
  return candidates.sort((a, b) => a.remaining / a.limit - b.remaining / b.limit)[0];
}

export function providerQuota(id: string, limits: Provider["freeLimits"], headers: RateHeaders | undefined,
  times: readonly number[], now: number): RequestQuota | undefined {
  const request = headers?.requests;
  if (headers && request?.limit && request.remaining !== undefined) {
    const period: QuotaPeriod | undefined = id === "groq" || id === "groq-api" || id === "openrouter" || limits.rpd === request.limit
      ? "day" : id === "kilo" || limits.rph === request.limit ? "hour" : limits.rpm === request.limit ? "minute" : undefined;
    if (now < (request.resetAt ?? headers.at + (period ? duration[period] : day))) {
      return { limit: request.limit, remaining: Math.min(request.remaining, request.limit), resetAt: request.resetAt, period, source: "headers" };
    }
  }
  return localQuota(times, limits, now);
}

export const keyCredits = z.object({
  usage: z.number().nonnegative(), limit: z.number().nonnegative().nullable(),
  remaining: z.number().nullable().optional(), isFreeTier: z.boolean()
});

const openRouterKey = z.object({ data: z.object({
  usage: z.number().nonnegative(), limit: z.number().nonnegative().nullable(),
  limit_remaining: z.number().nullable().optional(), is_free_tier: z.boolean()
}) });

export function parseKeyCredits(value: unknown) {
  const parsed = openRouterKey.safeParse(value);
  if (!parsed.success) return;
  const { usage, limit, limit_remaining, is_free_tier } = parsed.data.data;
  return { usage, limit, remaining: limit_remaining, isFreeTier: is_free_tier };
}
