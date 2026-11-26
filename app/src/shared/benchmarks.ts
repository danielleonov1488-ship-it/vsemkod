import { z } from "zod";

export const benchmarksSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  source: z.object({ name: z.string(), url: z.url(), indexVersion: z.string() }),
  models: z.record(z.string(), z.object({
    index: z.number().nonnegative().optional(),
    speed: z.number().positive().optional(),
    ttft: z.number().nonnegative().optional()
  }))
});

export type Benchmarks = z.infer<typeof benchmarksSchema>;

export function compareByBenchmark(a: { id: string; rank: number }, b: { id: string; rank: number }, benchmarks?: Benchmarks) {
  const ai = benchmarks?.models[a.id]?.index ?? -1;
  const bi = benchmarks?.models[b.id]?.index ?? -1;
  return bi - ai || a.rank - b.rank;
}
