import { z } from "zod";
import { feedIds } from "../config.js";
import { extractOffers } from "../llm/extract.js";
import type { LlmClient } from "../llm/client.js";
import type { State } from "../state.js";
import { describeError, requestJson, requestText, sha256 } from "./common.js";
import type { Observation, SourceResult } from "./common.js";
import { freeKeywords, htmlText, normalizeText } from "./watchPages.js";

type FeedId = (typeof feedIds)[number];
interface FeedItem { id: string; source: string; text: string }
const agent = "vsemkod-catalog-bot/1.0 (public free-model catalog)";
const hnSchema = z.object({ hits: z.array(z.object({
  objectID: z.string(),
  created_at_i: z.number().optional(),
  title: z.string().nullish(),
  story_text: z.string().nullish(),
  url: z.string().nullish(),
})) });
const redditSchema = z.object({ data: z.object({ children: z.array(z.object({ data: z.object({
  id: z.string(), title: z.string(), selftext: z.string(), permalink: z.string(),
}) })) }) });

async function hn(): Promise<FeedItem[]> {
  const endpoint = new URL("https://hn.algolia.com/api/v1/search_by_date");
  endpoint.search = new URLSearchParams({ query: "free API", tags: "story", hitsPerPage: "40" }).toString();
  const response = hnSchema.parse(await requestJson(endpoint));
  const cutoff = Date.now() / 1000 - 30 * 86400;
  return response.hits.filter((hit) => hit.created_at_i === undefined || hit.created_at_i >= cutoff).map((hit) => ({
    id: hit.objectID,
    source: "https://news.ycombinator.com/item?id=" + encodeURIComponent(hit.objectID),
    text: htmlText([hit.title, hit.story_text, hit.url].filter(Boolean).join("\n")),
  }));
}

async function reddit(): Promise<FeedItem[]> {
  const url = "https://www.reddit.com/r/LocalLLaMA/new.json?limit=50";
  const response = redditSchema.parse(await requestJson(url, { headers: { "User-Agent": agent } }));
  return response.data.children.map(({ data: post }) => ({
    id: post.id,
    source: "https://www.reddit.com" + post.permalink,
    text: post.title + "\n" + post.selftext,
  }));
}

async function github(): Promise<FeedItem[]> {
  const repo = "mnfst/awesome-free-llm-apis";
  const url = "https://api.github.com/repos/" + repo + "/readme";
  const readme = normalizeText(await requestText(url, { Accept: "application/vnd.github.raw+json", "User-Agent": agent }));
  if (readme.length < 80) throw new Error("README списка GitHub пуст");
  const lines = readme.split("\n");
  const relevant = new Set<number>();
  lines.forEach((line, i) => {
    if (freeKeywords.test(line)) for (let j = Math.max(0, i - 1); j <= i + 1; j++) relevant.add(j);
  });
  const text = lines.filter((_, i) => relevant.has(i)).join("\n");
  return [{ id: sha256(readme), source: "https://github.com/" + repo, text }];
}

export const fetchFeed: Record<FeedId, () => Promise<FeedItem[]>> = { hn, reddit, github };

export async function processFeed(
  id: FeedId, items: FeedItem[], client: LlmClient, state: State, now: string,
): Promise<SourceResult & { errors: string[] }> {
  const observations: Observation[] = [];
  const errors: string[] = [];
  let complete = true;
  let canExtract = true;
  for (const item of items) {
    const key = id + ":" + item.id;
    const previous = state.seenNews[key];
    if (previous) {
      if (previous.savedAt.slice(0, 10) !== now.slice(0, 10)) previous.savedAt = now;
      observations.push(...previous.observations);
      continue;
    }
    const text = normalizeText(item.text);
    if (!freeKeywords.test(text)) {
      state.seenNews[key] = { savedAt: now, observations: [] };
      continue;
    }
    if (!canExtract) continue;
    try {
      const result = await extractOffers({ text, confidence: "news", source: item.source }, client, state, now);
      if (!result) {
        complete = false;
        canExtract = false;
        continue;
      }
      observations.push(...result);
      state.seenNews[key] = { savedAt: now, observations: result };
    } catch (error) {
      errors.push(item.source + " — " + describeError(error));
      complete = false;
      canExtract = false;
    }
  }
  return { id, observations, complete, errors };
}
