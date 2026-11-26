import { z } from "zod";
import { dateSchema, freeListProviderSchema } from "./schema.js";
import { observationSchema } from "./sources/common.js";

export const healthStateSchema = z.object({
  checkedAt: dateSchema,
  verifiedAt: dateSchema.nullable(),
  consecutiveFailures: z.int().nonnegative(),
  supportsTools: z.boolean().optional(),
});

const trackSchema = z.object({
  evidence: z.record(z.string(), z.object({
    observation: observationSchema,
    missedRuns: z.int().nonnegative(),
  })),
  endedAt: dateSchema.optional(),
  health: healthStateSchema.optional(),
});

const cachedSchema = z.object({
  savedAt: dateSchema,
  observations: z.array(observationSchema),
});

export const stateSchema = z.object({
  version: z.literal(1),
  pages: z.record(z.string(), z.object({
    hash: z.string(),
    observations: z.array(observationSchema),
  })),
  pageChecks: z.record(z.string(), z.object({
    hash: z.string(),
    checkedAt: dateSchema,
    changedAt: dateSchema,
  })).default({}),
  seenNews: z.record(z.string(), cachedSchema),
  llmCache: z.record(z.string(), cachedSchema),
  tracks: z.record(z.string(), trackSchema),
  radarMissingSince: z.record(z.string(), dateSchema).default({}),
  freeListProviders: z.array(freeListProviderSchema).default([]),
  freeListCheckedAt: dateSchema.optional(),
  benchmarksAttemptedAt: dateSchema.optional(),
});

export type HealthState = z.infer<typeof healthStateSchema>;
export type Track = z.infer<typeof trackSchema>;
export type State = z.infer<typeof stateSchema>;

export function newState(): State {
  return {
    version: 1, pages: {}, pageChecks: {}, seenNews: {}, llmCache: {}, tracks: {},
    radarMissingSince: {}, freeListProviders: [],
  };
}

const day = 24 * 60 * 60 * 1000;

export function pruneState(state: State, now: string): void {
  const cutoff = Date.parse(now) - 30 * day;
  state.seenNews = Object.fromEntries(Object.entries(state.seenNews)
    .filter(([, entry]) => Date.parse(entry.savedAt) >= cutoff));
  state.llmCache = Object.fromEntries(Object.entries(state.llmCache)
    .filter(([, entry]) => Date.parse(entry.savedAt) >= cutoff));
}
