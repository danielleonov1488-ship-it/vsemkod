import type { DiscoveredInput } from "../schema.js";
import { request } from "./common.js";
import { allowedDiscovery, discoveryId, isFreeId, isModelId, providerBase, publicUrl } from "./discovery.js";
import { fetchFreeLlm } from "./freeLlm.js";

const raw = "https://raw.githubusercontent.com/";
export const trackerUrls = {
  coding: raw + "mvalentsev/awesome-free-ai-coding/main/index.json",
  history: raw + "mvalentsev/awesome-free-ai-coding/main/history.jsonl",
  claw: raw + "ClawLabsAI/free-ai-models/main/data/models.json",
  radar: raw + "original0211/freemodel-radar/main/data.json",
  freeLlm: raw + "nejib1/Free-LLM/main/router/catalog.snapshot.json",
  markdown: raw + "peter123023/awesome-free-llm-api/main/README.en.md",
};

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const openRouter = "https://openrouter.ai/api/v1";
const pollinations = "https://text.pollinations.ai/openai";

function expiry(value: unknown): string | null {
  const date = string(value);
  return /^\d{4}-\d\d-\d\d(?:T|$)/.test(date) && Number.isFinite(Date.parse(date))
    ? new Date(date.length === 10 ? date + "T23:59:59Z" : date).toISOString() : null;
}

function discovery(source: string, base: unknown, name: unknown, models: string[], signup?: unknown,
  endsAt: string | null = null): DiscoveredInput[] {
  const baseUrl = providerBase(string(base));
  if (!baseUrl) return [];
  const id = discoveryId(baseUrl);
  const item = {
    id, name: string(name).trim() || id, baseUrl, signupUrl: publicUrl(string(signup))?.href ?? null,
    models: [...new Set(models.filter(isModelId))].slice(0, 100), endsAt, sources: [source],
  };
  return allowedDiscovery(item) ? [item] : [];
}

function historyByProvider(input: string) {
  const changes = new Map<string, Row>();
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = object(JSON.parse(line));
    const id = string(entry.id);
    if (id) changes.set(id, { ...changes.get(id), ...entry });
  }
  return changes;
}

export function parseCodingTracker(input: unknown, history: string): DiscoveredInput[] {
  const changes = historyByProvider(history);
  return rows(object(input).entries).flatMap(row => {
    if (row.archived || row.card_required === true || !row.free_part) return [];
    const api = object(row.api);
    if (api.openai_compatible !== true) return [];
    const change = changes.get(string(row.id));
    const end = expiry(row.expires_at ?? row.ends_at ?? row.expires ?? change?.expires_at ?? change?.ends_at ?? change?.expires) ??
      expiry([row.limits, change?.detail].map(string).join(" ").match(/(?:expires?|ends?|until|through)\s+(?:on\s+)?(\d{4}-\d\d-\d\d)/i)?.[1]);
    const entries = discovery(trackerUrls.coding, api.base_url, row.name, strings(api.model_ids), api.key_url ?? row.url, end);
    if (end && change) for (const entry of entries) entry.sources.push(trackerUrls.history);
    return entries;
  });
}

export function parseClawTracker(input: unknown): DiscoveredInput[] {
  return rows(object(input).models).flatMap(row => {
    if (row.kind !== "chat" || row.excluded || !row.id) return [];
    const source = publicUrl(string(row.source));
    if (source?.hostname === "openrouter.ai" && isFreeId(string(row.id))) {
      return discovery(trackerUrls.claw, openRouter, "OpenRouter", [string(row.id)], source.origin, expiry(row.expires));
    }
    if (source?.hostname === "pollinations.ai" && row.id === "pollinations/openai-fast") {
      return discovery(trackerUrls.claw, pollinations, "Pollinations", ["openai-fast"], source.origin, expiry(row.expires));
    }
    return discovery(trackerUrls.claw, row.base_url ?? row.api_base, row.provider, [string(row.id)], source?.origin, expiry(row.expires));
  });
}

export function parseOpenRouterRadar(input: unknown): DiscoveredInput[] {
  const snapshot = object(input);
  const ids = strings(snapshot.free_ids).filter(isFreeId);
  return ids.length ? discovery(trackerUrls.radar, openRouter, "OpenRouter", ids, "https://openrouter.ai/") : [];
}

export function parseMarkdownTracker(text: string): DiscoveredInput[] {
  return text.split(/(?=^#{2,5}\s)/m).flatMap(block => {
    if (!/\bfree\b|免费/i.test(block) || /(?:not free|paid.only|requires? (?:a )?credit card)/i.test(block)) return [];
    const heading = block.match(/^#{2,5}\s+(?:\d+\.\s+)?([^\n]+)/)?.[1] ?? "";
    const name = heading.replaceAll("**", "").replace(/^\[([^\]]+)\]\(.+$/, "$1").trim();
    const lines = block.split("\n").filter(line => /\b(?:endpoint|base\s*url)\b|接口地址/i.test(line));
    const links = lines.flatMap(line => line.match(/https:\/\/[^\s<>\x60"'|]+/g) ?? []);
    const bases = [...new Set(links.map(link => link.replace(/[),.;\]}]+$/, "").replace(/\/(?:chat\/completions|models)\/?$/, "")))];
    const freeIds = [...block.matchAll(/\x60([^\x60]+)\x60/g)].map(match => match[1]).filter(id => isModelId(id) && isFreeId(id));
    return bases.flatMap(base => discovery(trackerUrls.markdown, base, name, bases.length === 1 ? freeIds : [],
      undefined, expiry(block.match(/(?:expires?|until|through)\s+(?:on\s+)?(\d{4}-\d\d-\d\d)/i)?.[1])));
  });
}

const json = (url: string) => request(url, response => response.json(), { redirect: "error" }, 0);
const text = (url: string) => request(url, response => response.text(), { redirect: "error" }, 0);

export function trackerJobs(freeLlm: () => ReturnType<typeof fetchFreeLlm> = fetchFreeLlm) {
  return {
    coding: async () => parseCodingTracker(...await Promise.all([json(trackerUrls.coding), text(trackerUrls.history)])),
    claw: async () => parseClawTracker(await json(trackerUrls.claw)),
    radar: async () => parseOpenRouterRadar(await json(trackerUrls.radar)),
    freeLlm: async () => (await freeLlm()).flatMap(row =>
      discovery(trackerUrls.freeLlm, row.baseUrl, row.provider, row.models, row.keyHelpUrl)),
    markdown: async () => parseMarkdownTracker(await text(trackerUrls.markdown)),
  };
}

export function isTrackerSource(source: string): boolean {
  return Object.values(trackerUrls).some(url => url === source);
}
