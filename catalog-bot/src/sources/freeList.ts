import { z } from "zod";
import type { FreeListProvider } from "../schema.js";
import { request } from "./common.js";

// mnfst/awesome-free-llm-apis (CC0): список провайдеров с постоянным бесплатным тарифом в машиночитаемом виде.
const dataUrl = "https://raw.githubusercontent.com/mnfst/awesome-free-llm-apis/main/data.json";
const dayMs = 24 * 60 * 60 * 1000;

const dataSchema = z.object({
  providers: z.array(z.object({
    name: z.string().min(1),
    category: z.string().optional(),
    url: z.string().optional(),
  }).passthrough()),
}).passthrough();

export function shouldCheckFreeList(now: string, checkedAt?: string): boolean {
  return !checkedAt || Date.parse(now) - Date.parse(checkedAt) >= dayMs;
}

export function parseFreeList(data: unknown): FreeListProvider[] {
  const providers = new Map<string, FreeListProvider>();
  for (const provider of dataSchema.parse(data).providers) {
    const name = provider.name.trim();
    const url = provider.url && /^https:\/\//.test(provider.url) ? provider.url : "https://github.com/mnfst/awesome-free-llm-apis";
    const section = provider.category === "provider_api" ? "provider_api" : "inference_provider";
    if (name) providers.set(name.toLowerCase(), { name, section, url });
  }
  return [...providers.values()];
}

export async function fetchFreeListProviders(): Promise<FreeListProvider[]> {
  const providers = parseFreeList(await request(dataUrl, (response) => response.json(), {}, 0));
  if (!providers.length) throw new Error("В data.json не найдено провайдеров");
  return providers;
}
