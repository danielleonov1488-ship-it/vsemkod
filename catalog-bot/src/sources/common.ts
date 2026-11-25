import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { confidenceSchema, dateSchema, limitsSchema, providerIdSchema, tierSchema } from "../schema.js";

export const observationSchema = z.object({
  providerId: providerIdSchema,
  providerModelId: z.string().trim().min(1).max(250),
  confidence: confidenceSchema,
  source: z.string().min(1),
  promo: z.boolean().optional(),
  expiresAt: dateSchema.nullable().optional(),
  supportsTools: z.boolean().optional(),
  contextWindow: z.int().positive().optional(),
  limits: limitsSchema.optional(),
  suggestedTier: tierSchema.optional(),
  suggestedDescription: z.string().trim().min(1).max(240).optional(),
  verifiedAt: dateSchema.optional(),
  reviewBy: dateSchema.optional(),
});

export type Observation = z.infer<typeof observationSchema>;
export type SourceResult = { id: string; observations: Observation[]; complete?: boolean };

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "Неизвестная ошибка";
  if (error.name === "TimeoutError") return "Истёк таймаут HTTP";
  if (error instanceof z.ZodError) {
    return "Некорректный формат: " + error.issues.slice(0, 3).map((issue) => issue.path.join(".") || "ответ").join(", ");
  }
  const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
  return error.message + (code ? " (" + code + ")" : "");
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super("HTTP " + status);
  }
}

export async function request<T>(
  url: string | URL,
  decode: (response: Response) => Promise<T>,
  init: RequestInit = {},
  retries = 2,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(response.status);
      }
      return await decode(response);
    } catch (error) {
      const permanent = error instanceof HttpError && error.status < 500 && error.status !== 429 && error.status !== 408;
      if (permanent || attempt >= retries) throw error;
      await setTimeout(250 * 2 ** attempt);
    }
  }
}

export function requestJson(url: string | URL, init?: RequestInit): Promise<unknown> {
  return request(url, (response) => response.json(), init);
}

export function requestText(url: string | URL, headers?: HeadersInit): Promise<string> {
  return request(url, (response) => response.text(), { headers });
}
