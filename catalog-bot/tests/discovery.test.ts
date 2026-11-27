import { once } from "node:events";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { approve } from "../src/approve.js";
import { readConfig } from "../src/config.js";
import { updateDiscovered } from "../src/discovered.js";
import { modelSlug, matchModel } from "../src/match.js";
import { mergeCatalog } from "../src/merge.js";
import { probeCandidate, publicAddress } from "../src/probe.js";
import { legacyCatalog } from "../src/publish.js";
import { registryBatches } from "../src/registry/offers.js";
import { catalogSchema, legacyProviderIds, radarSchema } from "../src/schema.js";
import type { DiscoveredInput, Radar } from "../src/schema.js";
import { parseFreeInference } from "../src/sources/freeInference.js";
import { LlmClient } from "../src/llm/client.js";
import { discoveriesFromPost, extractEnd, fetchTelegram, parseTelegram } from "../src/sources/telegram.js";
import { newState, stateSchema } from "../src/state.js";

const now = "2026-11-27T16:00:00Z";
const end = "2026-11-30T23:59:59.000Z";
const template: DiscoveredInput = {
  id: "fixture", name: "Fixture", baseUrl: "https://api.example.org/api/v1",
  signupUrl: "https://example.org/signup", models: ["sample/model:free"], endsAt: end,
  sources: ["https://t.me/fixture/105"],
};
const fixture = (name: string) => readFile(new URL("fixtures/" + name, import.meta.url), "utf8");
const renderPost = (id: number) =>
  '<div class="tgme_widget_message" data-post="fixture/' + id + '"><time datetime="' + now +
  '"></time><div class="tgme_widget_message_text">Unrelated</div></div>';

it("parses Telegram posts, dates and API evidence", async () => {
  const [latest, prior] = parseTelegram(await fixture("telegram.html"), "fixture");
  expect([latest.id, prior.id]).toEqual([105, 104]);
  expect(await discoveriesFromPost(latest)).toEqual([{
    ...template, id: "example", name: "example", models: ["sample/model:free", "sample/second-free", "free/third"],
  }]);
  expect((await discoveriesFromPost(prior))[0]).toMatchObject({ endsAt: end });
  expect(extractEnd("until Jan 1", now)).toBe("2027-01-01T23:59:59.000Z");
  expect(extractEnd("бесплатно до 31 ноября", now)).toBeNull();
});

it("uses the LLM for supplemental fields without letting it introduce an endpoint or a model", async () => {
  const [post] = parseTelegram(await fixture("telegram.html"), "fixture");
  const payload = { providers: [
    { name: "API", baseUrl: template.baseUrl, signupUrl: "https://evil.example.org/signup",
      models: ["invented-model"], endsAt: null },
    { name: "External", baseUrl: "https://evil.example.org/v1", signupUrl: null, models: [], endsAt: null },
  ] };
  const llm = new LlmClient({ baseUrl: "https://models.example.org", key: "fake", model: "fixture", maxTokens: 10000 },
    vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] })));
  const [found] = await discoveriesFromPost(post, llm);
  expect(found.signupUrl).toBe(template.signupUrl);
  expect(found.models).not.toContain("invented-model");
  expect(await discoveriesFromPost(post, llm)).toHaveLength(1);
});

it("paginates up to 100 initially and only processes new IDs after saving state", async () => {
  const fetchPage = vi.fn(async (raw: string) => {
    const before = Number(new URL(raw).searchParams.get("before") ?? 106);
    return Array.from({ length: 25 }, (_, i) => renderPost(before - i - 1)).join("");
  });
  const state = newState();
  const first = await fetchTelegram("fixture", state, undefined, fetchPage);
  expect(first.count).toBe(100);
  expect(state.telegramLastPost.fixture).toBe(105);
  expect(fetchPage.mock.calls.map(([url]) => new URL(url).searchParams.get("before"))).toEqual([null, "81", "56", "31"]);
  const persisted = stateSchema.parse(JSON.parse(JSON.stringify(state)));
  const newer = vi.fn(async () => [renderPost(107), renderPost(106), renderPost(105)].join(""));
  expect((await fetchTelegram("fixture", persisted, undefined, newer)).count).toBe(2);
  expect(newer).toHaveBeenCalledTimes(1);
  expect(persisted.telegramLastPost.fixture).toBe(107);
});

it("retains the last processed message if a Telegram page fails", async () => {
  const state = newState();
  state.telegramLastPost.fixture = 103;
  const fetchPage = vi.fn()
    .mockResolvedValueOnce(renderPost(105) + renderPost(104))
    .mockRejectedValueOnce(new Error("network"));
  await expect(fetchTelegram("fixture", state, undefined, fetchPage)).rejects.toThrow("network");
  expect(state.telegramLastPost.fixture).toBe(103);
});

it("reads FreeInference models and quota metadata", async () => {
  const entries = parseFreeInference(JSON.parse(await fixture("freeinference.json")));
  expect(entries).toEqual([{
    ...template, id: "example", endsAt: null, limits: { rpm: 5, rpd: 50, tpm: 20000 },
    sources: ["https://freeinference.dev/data/providers.json"],
  }]);
});

it("probes a fake server anonymously and with a key using one minimal tool call", async () => {
  let needKey = true;
  let badTools = false;
  const requests: { path?: string; authorization?: string; body?: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined;
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    if (needKey && req.headers.authorization !== "Bearer fixture-secret") { res.writeHead(401).end(); return; }
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "sample/model:free" }] }));
    } else {
      const tool_calls = badTools ? [] : [{ function: { name: "probe" } }];
      res.end(JSON.stringify({ choices: [{ message: { tool_calls } }] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture not listening");
  const candidate = { ...template, baseUrl: "http://127.0.0.1:" + address.port + "/v1" };
  const transport: Parameters<typeof probeCandidate>[3] = async (url, { key, body }) => {
    const res = await fetch(url, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
      headers: key ? { authorization: "Bearer " + key } : {}, redirect: "error" });
    return { status: res.status, data: res.ok ? await res.json() : undefined };
  };
  try {
    expect((await probeCandidate(candidate, now)).probe.status).toBe("unreachable");
    expect((await probeCandidate(candidate, now, undefined, transport)).probe).toMatchObject({ status: "key-required", tools: null });
    expect((await probeCandidate(candidate, now, "fixture-secret", transport)).probe).toMatchObject({
      status: "available", tools: true, authenticated: true,
    });
    const posts = requests.filter(r => r.path === "/v1/chat/completions");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ authorization: "Bearer fixture-secret", body: { model: "sample/model:free", max_tokens: 16 } });
    needKey = false;
    badTools = true;
    expect((await probeCandidate(candidate, now, undefined, transport)).probe.tools).toBe(false);
    expect(publicAddress("169.254.169.254", 4)).toBe(false);
    expect(publicAddress("::ffff:127.0.0.1", 6)).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("deduplicates evidence, binds keys to a URL, retries daily and marks a provider dead", async () => {
  const state = newState();
  const config = { ...readConfig(), healthKeys: { example: "fixture-secret" },
    discoveryKeyBases: { example: "https://different.example.org/v1" } };
  const probe = vi.fn<typeof probeCandidate>(async (_, at) => ({ probe: { at, status: "unreachable", tools: null } }));
  let { radar, added } = await updateDiscovered(undefined, [template, { ...template, sources: ["https://example.org/source"] }], state, config, now, probe);
  expect(added).toHaveLength(1);
  expect(added[0].sources).toHaveLength(2);
  expect(probe).toHaveBeenLastCalledWith(expect.anything(), now, undefined);
  expect(radar.discovered.find(item => item.id === "tinygrad")?.probe.status).toBe("watching");
  expect((await updateDiscovered(radar, [], state, config, "2026-11-27T23:00:00Z", probe)).added).toEqual([]);
  expect(probe).toHaveBeenCalledTimes(1);
  config.discoveryKeyBases.example = template.baseUrl!;
  for (const date of ["2026-11-28T16:00:00Z", "2026-11-29T16:00:00Z"]) {
    ({ radar } = await updateDiscovered(radar, [], state, config, date, probe));
  }
  expect(probe).toHaveBeenLastCalledWith(expect.anything(), "2026-11-29T16:00:00Z", "fixture-secret");
  expect(radarSchema.parse(radar).discovered?.find(item => item.id === "example")?.probe.status).toBe("dead");
});

it("writes approval drafts to a temporary registry and rejects duplicate approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vsemkod-approve-test-"));
  const radar: Radar = { schemaVersion: 1, generatedAt: now, models: [], discovered: [{
    ...template, probe: { at: now, status: "key-required", tools: null },
  }] };
  try {
    await cp(new URL("../src/registry/", import.meta.url), dir, { recursive: true });
    await expect(approve("fixture", radar, dir)).resolves.toContain("Черновики fixture");
    expect(await readFile(join(dir, "providers.ts"), "utf8")).toContain('"trust": "community"');
    expect(await readFile(join(dir, "offers.ts"), "utf8")).toContain('"providerModelId": "sample/model:free"');
    await expect(approve("fixture", radar, dir)).rejects.toThrow("Черновик уже создан");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("matches the free suffix for curated models while preserving published automatic model IDs", () => {
  expect(matchModel("deepseek/deepseek-v4.1-flash-free")?.id).toBe("deepseek-v4.1-flash");
  expect(modelSlug("reflection/beam-free")).toBe("beam-free");
});

it("splits legacy and complete catalog formats and preserves Cent AI's date", () => {
  const { catalog } = mergeCatalog(undefined, newState(), registryBatches(), {
    now, missingRuns: 6, retentionDays: 7, healthFailureThreshold: 2,
  });
  expect(catalogSchema.parse(catalog).providers.length).toBeGreaterThan(legacyProviderIds.length);
  expect(catalog.candidates).toEqual([]);
  expect(catalog.offers.find(offer => offer.providerId === "cent-ai")).toMatchObject({
    providerModelId: "hy4-flash:free", expiresAt: "2026-11-30T23:59:59Z", promo: true, status: "active",
  });
  const legacy = legacyCatalog(catalog);
  expect(legacy.providers.map(provider => provider.id).sort()).toEqual([...legacyProviderIds].sort());
  expect(legacy.offers).toHaveLength(13);
  expect(legacy.providers.every(provider => !provider.trust && !provider.freeLimits.allModelsFree)).toBe(true);
  expect(catalogSchema.parse(legacy)).toEqual(legacy);
});
