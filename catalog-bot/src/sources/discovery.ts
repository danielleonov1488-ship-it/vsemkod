import { isIP } from "node:net";
import { providerIdSchema } from "../schema.js";
import type { DiscoveredInput } from "../schema.js";

const blockedNames = /\b(?:qronos|1tim|apisfreellm|agentrouter)\b/i;

export function publicUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port ||
        !url.hostname.includes(".") || isIP(url.hostname) || url.hostname.endsWith(".") ||
        /\.(?:localhost|local|internal|home|lan|test|invalid)$/i.test(url.hostname)) return;
    return url;
  } catch { return undefined; }
}

export function providerBase(raw: string): string | undefined {
  const url = publicUrl(raw);
  if (url?.href === "https://text.pollinations.ai/openai") return url.href;
  if (!url || url.search || url.hash || !/\/v\d+(?:beta\d*)?(?:\/openai)?\/?$/i.test(url.pathname) || /[%{}]/.test(url.pathname)) return;
  return url.href.replace(/\/+$/, "");
}

export function discoveryId(baseUrl: string): string {
  const host = new URL(baseUrl).hostname.replace(/^www\./, "").split(".");
  const core = host.find(part => !/^(?:api|router|gateway|inference|inference-api|integrate|llm)$/.test(part)) ?? host[0];
  const id = core.replace(/[^a-z0-9-]/g, "-").slice(0, 41);
  return providerIdSchema.safeParse(id).success ? id : "provider-" + id;
}

export function allowedDiscovery(item: DiscoveredInput) {
  return !blockedNames.test([item.id, item.name, item.baseUrl, item.signupUrl].join(" "));
}

export const isFreeId = (id: string) => /(?:-free|:free)$/i.test(id) || /^free\/.+/i.test(id);
export const isModelId = (id: string) => /^[a-z0-9][a-z0-9._:@/-]{0,180}$/i.test(id);
