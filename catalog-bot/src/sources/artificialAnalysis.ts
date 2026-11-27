import { z } from "zod";
import { catalogModelMatcher, normalizeModelName } from "../match.js";
import { stableJson } from "../merge.js";
import { dateSchema } from "../schema.js";
import type { Model } from "../schema.js";
import { request } from "./common.js";

const source = { name: "Artificial Analysis", url: "https://artificialanalysis.ai/" } as const;
const endpoint = new URL("/api/v2/language/models/free", source.url);
const refreshMs = 20 * 60 * 60 * 1000;
const maxPages = 100;

const modelSchema = z.object({
  id: z.string().nullish(),
  name: z.string().nullish(),
  slug: z.string().nullish(),
  model_creator: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  evaluations: z.object({
    artificial_analysis_intelligence_index: z.number().nullish(),
  }).passthrough().nullish(),
  performance_v3: z.object({
    mean_output_tokens_per_second: z.number().nonnegative().nullish(),
    mean_time_to_first_token_seconds: z.number().nonnegative().nullish(),
  }).passthrough().nullish(),
}).passthrough();

const pageSchema = z.object({
  tier: z.string().nullish(),
  intelligence_index_version: z.union([z.number(), z.string().min(1)]).nullish(),
  pagination: z.object({
    page: z.int().positive().nullish(),
    total_pages: z.int().nonnegative().nullish(),
    has_more: z.boolean().nullish(),
  }).passthrough().nullish(),
  data: z.array(modelSchema),
}).passthrough();

const metricsSchema = z.object({
  index: z.number().optional(),
  speed: z.number().nonnegative().optional(),
  ttft: z.number().nonnegative().optional(),
}).strict();

export const benchmarksSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: dateSchema,
  source: z.object({
    name: z.literal(source.name),
    url: z.literal(source.url),
    indexVersion: z.string().min(1),
  }).strict(),
  models: z.record(z.string().min(1), metricsSchema),
}).strict();

export type Benchmarks = z.infer<typeof benchmarksSchema>;
type Metrics = z.infer<typeof metricsSchema>;
type AnalysisModel = z.infer<typeof modelSchema>;

export function shouldRefreshBenchmarks(now: string, generatedAt?: string, attemptedAt?: string): boolean {
  const timestamp = Date.parse(now);
  return [generatedAt, attemptedAt].every((date) => !date || timestamp - Date.parse(date) > refreshMs);
}

export function benchmarksChanged(previous: Benchmarks | undefined, next: Benchmarks): boolean {
  const details = ({ source, models }: Benchmarks) => stableJson({ source, models });
  return !previous || details(previous) !== details(next);
}

const variantSuffix = /-(?:high|xhigh|medium|low|minimal|max|none|(?:non-)?reasoning|(?:non-)?thinking)(?:-reasoning(?:-effort)?)?$/;

function analysisStem(value: string): string {
  let stem = normalizeModelName(value);
  for (;;) {
    const shorter = stem.replace(variantSuffix, "").replace(/-(?:\d{4}|vl)$/, "");
    if (shorter === stem) return stem;
    stem = shorter;
  }
}

function matchCatalog(models: (Pick<Model, "id"> & Partial<Pick<Model, "name">>)[]) {
  const find = catalogModelMatcher(models);
  const normalized = new Map<string, string | null>();
  for (const model of models) {
    for (const value of [model.id, model.name]) {
      if (!value) continue;
      const stem = analysisStem(value);
      const current = normalized.get(stem);
      normalized.set(stem, current === undefined || current === model.id ? model.id : null);
    }
  }
  return ({ id, slug, name, model_creator }: AnalysisModel): string | undefined => {
    const names = [slug, name, id].filter((value): value is string => !!value);
    const direct = find(names);
    if (direct) return direct;
    const creator = normalizeModelName(model_creator?.name ?? "") + "-";
    const stems = names.flatMap((value) => {
      const withoutVariant = analysisStem(value);
      const candidates = [withoutVariant];
      if (creator !== "-" && withoutVariant.startsWith(creator)) {
        candidates.push(withoutVariant.slice(creator.length));
      }
      return candidates;
    });
    return stems.map(stem => normalized.get(stem)).find(Boolean) ?? find(stems);
  };
}

function prefer(candidate: Metrics, current: Metrics): boolean {
  const quality = ({ index, speed, ttft }: Metrics) =>
    [index ?? -Infinity, speed ?? -Infinity, ttft === undefined ? -Infinity : -ttft];
  const baseline = quality(current);
  for (const [i, value] of quality(candidate).entries()) {
    if (value !== baseline[i]) return value > baseline[i];
  }
  return false;
}

function rounded(value: number | undefined, decimals: number): number | undefined {
  return value === undefined ? undefined : Number(value.toFixed(decimals));
}

function roundedIndex(value: number | undefined): number | undefined {
  const display = rounded(value, 1);
  if (value !== undefined && (display === 12 && value < 12 || display === 25 && value < 25)) return value;
  return display;
}

export async function fetchBenchmarks(
  key: string, catalogModels: (Pick<Model, "id"> & Partial<Pick<Model, "name">>)[], now: string,
): Promise<Benchmarks> {
  const match = matchCatalog(catalogModels);
  const best = new Map<string, Metrics>();
  let indexVersion: string | undefined;
  for (let page = 1; ; page++) {
    const url = new URL(endpoint);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "200");
    const result = pageSchema.parse(await request(url, (response) => response.json(), {
      headers: { "x-api-key": key },
      redirect: "error",
    }, 0));
    const version = result.intelligence_index_version;
    if (version != null) {
      if (indexVersion !== undefined && indexVersion !== String(version)) {
        throw new Error("Версия индекса изменилась между страницами");
      }
      indexVersion = String(version);
    }

    for (const model of result.data) {
      const id = match(model);
      if (!id) continue;
      const metrics = {
        index: model.evaluations?.artificial_analysis_intelligence_index ?? undefined,
        speed: model.performance_v3?.mean_output_tokens_per_second ?? undefined,
        ttft: model.performance_v3?.mean_time_to_first_token_seconds ?? undefined,
      };
      const previous = best.get(id);
      if (!previous || prefer(metrics, previous)) best.set(id, metrics);
    }
    const pagination = result.pagination;
    if (pagination?.page != null && pagination.page !== page) {
      throw new Error("API вернуло неожиданную страницу " + pagination.page);
    }
    if (!(pagination?.has_more ?? page < (pagination?.total_pages ?? page))) break;
    if (page === maxPages) throw new Error("Превышен лимит страниц Artificial Analysis");
  }

  return benchmarksSchema.parse({
    schemaVersion: 1,
    generatedAt: now,
    source: { ...source, indexVersion: indexVersion ?? "unknown" },
    models: Object.fromEntries([...best].map(([id, { index, speed, ttft }]) => [id, {
      index: roundedIndex(index), speed: rounded(speed, 1), ttft: rounded(ttft, 2),
    }])),
  });
}
