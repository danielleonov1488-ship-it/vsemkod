import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import bundled from "../resources/catalog.json";
import { CatalogService } from "../src/main/catalog-service";
import { catalogSchema, communityWarning, providerIdSchema } from "../src/shared/catalog-schema";
import { keyIdSchema } from "../src/shared/providers";

const example = bundled.providers[0];
const offer = bundled.offers[0];

it("accepts new provider IDs and skips incompatible providers with their offers and candidates", () => {
  const data = {
    ...bundled,
    providers: [
      ...bundled.providers,
      { ...example, id: "new-provider", trust: "community", freeLimits: { allModelsFree: true, note: "50 в день" } },
      { ...example, id: "other-api", api: "future-api" },
      { ...example, id: "future-auth", auth: { type: "future", extra: true } },
      { ...example, id: "custom-abcd1234" },
      { ...example, id: "openai-api" },
    ],
    offers: [...bundled.offers, ...["new-provider", "other-api", "future-auth", "custom-abcd1234", "openai-api"].map(providerId =>
      ({ ...offer, sources: ["test"], providerId }))],
    candidates: [{ ...offer, providerId: "future-auth", providerModelId: "old", sources: ["test"] }],
  };
  const result = catalogSchema.parse(data);
  expect(providerIdSchema.safeParse("new-provider").success).toBe(true);
  expect(providerIdSchema.safeParse("INVALID").success).toBe(false);
  expect(keyIdSchema.safeParse("new-provider").success).toBe(true);
  expect(keyIdSchema.safeParse("custom-abcd1234").success).toBe(true);
  expect(result.providers.map(({ id }) => id)).toEqual([...bundled.providers.map(({ id }) => id), "new-provider"]);
  expect(result.offers.slice(bundled.offers.length)).toMatchObject([{ providerId: "new-provider" }]);
  expect(result.candidates).toEqual([]);
  expect(result.providers.at(-1)?.freeLimits.note).toBe("50 в день · " + communityWarning);
  expect(catalogSchema.parse(result)).toEqual(result);
});

it("tries the v2 site and mirror and falls back to the bundled catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vsemkod-v2-"));
  const path = join(dir, "bundled.json");
  const service = new CatalogService(dir, path);
  const urls: string[] = [];
  const next = { ...bundled, providers: [...bundled.providers, { ...example, id: "new-provider" }] };
  let mirrorAvailable = false;
  const mock = vi.fn(async (url: string) => {
    if (url.endsWith("/catalog-v2.json")) urls.push(url);
    return mirrorAvailable && url.includes("raw.githubusercontent") && url.endsWith("/catalog-v2.json")
      ? Response.json(next) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  try {
    await writeFile(path, JSON.stringify(bundled));
    await service.loadInitial();
    await service.refresh();
    expect(service.current.providers).toHaveLength(bundled.providers.length);
    mirrorAvailable = true;
    await service.refresh();
    expect(service.current.providers.at(-1)?.id).toBe("new-provider");
    expect(urls).toEqual(Array.from({ length: 2 }, () => [
      "https://vsemkod.ru/catalog-v2.json",
      "https://raw.githubusercontent.com/danielleonov1488-ship-it/vsemkod/main/catalog-bot/data/catalog-v2.json",
    ]).flat());
  } finally {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
