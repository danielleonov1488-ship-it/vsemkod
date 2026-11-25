import { z } from "zod";
import { watchedPages } from "../config.js";
import type { ProviderId } from "../schema.js";
import { registryModelId } from "../registry/offers.js";
import { providers } from "../registry/providers.js";
import { matchModel } from "../match.js";
import type { State } from "../state.js";
import { extractOffers } from "../llm/extract.js";
import type { LlmClient } from "../llm/client.js";
import { requestJson, requestText, sha256 } from "./common.js";
import type { SourceResult } from "./common.js";

export type WatchedPage = (typeof watchedPages)[number];

const entities: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
};
export const freeKeywords = /\bfree\b|бесплат|\bpromo\b|\bstealth\b|\bgiveaway\b|免费/i;

export function htmlText(html: string): string {
  const body = html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1] ?? html;
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|noscript|svg|nav|footer|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|pre)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<(?:\/?code|\/span)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, key: string) => {
      if (!key.startsWith("#")) return Object.hasOwn(entities, key.toLowerCase()) ? entities[key.toLowerCase()] : original;
      const code = key[1].toLowerCase() === "x" ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : original;
    });
}

export function normalizeText(text: string): string {
  return text.normalize("NFC").split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function forPrompt(text: string, providerId: ProviderId): string {
  const intro = providerId === "zai" ? "Официальный API ID GLM-4.7-Flash — glm-4.7-flash.\n" : "";
  const max = 12000 - intro.length;
  if (text.length <= max) return intro + text;
  const lines = text.split("\n");
  const kept = new Set<number>();
  lines.forEach((line, i) => {
    if (freeKeywords.test(line) || /gpt-oss|qwen3\.8|glm-4\.7|modelscope|magicubes/i.test(line)) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) kept.add(j);
    }
  });
  const relevant = lines.filter((_, i) => kept.has(i)).join("\n");
  return intro + (relevant.length > 300 ? relevant : text).slice(0, max);
}

const modelScopeList = z.object({ data: z.array(z.object({ id: z.string() })) });
const modelScopeQuotaUrl = "https://www.modelscope.cn/docs/magicube/intro.md";

export async function fetchPageText(page: WatchedPage): Promise<string> {
  const raw = await requestText(page.url);
  let text = normalizeText(/^\s*<(?:!doctype|html)\b/i.test(raw) ? htmlText(raw) : raw);
  if (text.length < 80) throw new Error("Страница тарифов пуста");

  if (page.providerId === "modelscope") {
    const [response, quota] = await Promise.all([
      requestJson(providers.modelscope.baseUrl + "/models"),
      requestText(modelScopeQuotaUrl),
    ]);
    const ids = modelScopeList.parse(response).data.map(({ id }) => id).filter(matchModel).sort();
    const rules = normalizeText(quota);
    if (!rules.includes("API-Inference") || /^\s*</.test(rules)) throw new Error("Недоступны правила начисления Magicubes");
    text += "\nПубличный список известных ID в API-Inference ModelScope\n" + ids.join("\n") + "\n" + rules;
  }
  return text;
}

export async function processPage(
  page: WatchedPage, text: string, client: LlmClient | undefined, state: State, now: string,
): Promise<SourceResult> {
  const id = "page:" + page.providerId;
  const hash = sha256(text);
  const check = state.pageChecks[id];
  if (check?.hash !== hash) {
    state.pageChecks[id] = { hash, checkedAt: now, changedAt: now };
  } else if (check.checkedAt.slice(0, 10) !== now.slice(0, 10)) {
    check.checkedAt = now;
  }
  const previous = state.pages[id];
  if (previous?.hash === hash) return { id, observations: previous.observations };
  if (!client) return { id, observations: [], complete: false };
  const observations = await extractOffers({
    text: forPrompt(text, page.providerId), confidence: "page", source: page.url, providerId: page.providerId,
  }, client, state, now);
  if (!observations) return { id, observations: [], complete: false };
  const normalized = observations.map((offer) => ({
    ...offer, providerModelId: registryModelId(offer.providerId, offer.providerModelId),
  }));
  state.pages[id] = { hash, observations: normalized };
  return { id, observations: normalized };
}
