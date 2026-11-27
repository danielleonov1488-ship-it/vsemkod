import { load } from "cheerio";
import type { LlmClient } from "../llm/client.js";
import { extractDiscovery } from "../llm/extract.js";
import type { DiscoveredInput } from "../schema.js";
import type { State } from "../state.js";
import { requestText } from "./common.js";
import { allowedDiscovery, discoveryId, isFreeId, isModelId, providerBase, publicUrl } from "./discovery.js";

type Post = { id: number; date: string; text: string; links: string[]; source: string };
const unique = <T>(values: T[]) => [...new Set(values)];

export function parseTelegram(html: string, channel: string): Post[] {
  const $ = load(html);
  if (!$(".tgme_widget_message[data-post], .tgme_channel_info").length) {
    throw new Error("Публичная лента Telegram недоступна");
  }
  return $(".tgme_widget_message[data-post]").toArray().flatMap(element => {
    const message = $(element);
    const [owner, rawId] = (message.attr("data-post") ?? "").split("/");
    const id = Number(rawId);
    const date = message.find("time[datetime]").first().attr("datetime");
    if (owner.toLowerCase() !== channel || !Number.isSafeInteger(id) || id <= 0 || !date || !Number.isFinite(Date.parse(date))) return [];
    const body = message.find(".tgme_widget_message_text");
    const links = body.find("a[href]").toArray().map(a => $(a).attr("href")!);
    body.find("br").replaceWith("\n");
    return [{ id, date, text: body.text(), links, source: "https://t.me/" + channel + "/" + id }];
  });
}

const months = [
  ["января", "jan", "january"], ["февраля", "feb", "february"], ["марта", "mar", "march"],
  ["апреля", "apr", "april"], ["мая", "may"], ["июня", "jun", "june"], ["июля", "jul", "july"],
  ["августа", "aug", "august"], ["сентября", "sep", "sept", "september"],
  ["октября", "oct", "october"], ["ноября", "nov", "november"], ["декабря", "dec", "december"],
];

export function extractEnd(text: string, postedAt: string): string | null {
  const ru = /(?:^|[^\p{L}])до\s+(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/iu.exec(text);
  const en = /\b(?:until|through)\s+([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(text);
  const month = months.findIndex(items => items.includes((ru?.[2] ?? en?.[1] ?? "").toLowerCase()));
  const day = Number(ru?.[1] ?? en?.[2]);
  if (month < 0 || !day || day > 31) return null;
  const explicitYear = ru?.[3] ?? en?.[3];
  let year = explicitYear ? Number(explicitYear) : new Date(postedAt).getUTCFullYear();
  const end = () => new Date(Date.UTC(year, month, day, 23, 59, 59));
  if (!explicitYear && end().getTime() < Date.parse(postedAt)) year++;
  const date = end();
  return date.getUTCMonth() === month ? date.toISOString() : null;
}

export async function discoveriesFromPost(post: Post, llm?: LlmClient): Promise<DiscoveredInput[]> {
  const links = unique([...post.links, ...(post.text.match(/https?:\/\/[^\s<>"']+/gi) ?? [])]
    .map(link => link.replace(/[),.;\]}»]+$/, ""))
    .map(raw => publicUrl(raw)?.href).filter((link): link is string => !!link));
  const bases = unique(links.map(providerBase).filter((url): url is string => !!url));
  const text = post.text.replace(/https?:\/\/[^\s<>"']+/gi, "");
  const models = unique((text.match(/[a-z0-9][a-z0-9._:@/-]*/gi) ?? [])
    .map(id => id.replace(/\.+$/, "")).filter(id => isModelId(id) && isFreeId(id)));
  if (!bases.length || (!models.length && !/(?:бесплат|раздач|без оплаты|\bfree\b|\bgiveaway\b)/i.test(text))) return [];
  if (blockedPost(text)) return [];

  const extracted = llm && await extractDiscovery(post.text, links, bases, llm).catch(() => undefined);
  const endsAt = extractEnd(text, post.date);
  return bases.flatMap(baseUrl => {
    const id = discoveryId(baseUrl);
    const hint = extracted?.providers.find(item => item.baseUrl === baseUrl);
    const host = new URL(baseUrl).hostname;
    const signup = links.find(link => {
      const url = new URL(link);
      const sameDomain = url.hostname === host || host.endsWith("." + url.hostname) ||
        url.hostname.endsWith("." + host) || url.hostname.split(".").slice(1).join(".") === host.split(".").slice(1).join(".") &&
        host.split(".").length > 2 && url.hostname.split(".").length > 2;
      return sameDomain && /\/(?:signup|register|sign-up|login|auth|dashboard|keys|console)(?:\/|$)/i.test(url.pathname);
    });
    const refinedModels = (hint?.models ?? []).filter(model => text.includes(model));
    const item: DiscoveredInput = {
      id, name: hint && text.includes(hint.name) ? hint.name : id, baseUrl,
      signupUrl: hint?.signupUrl && links.includes(hint.signupUrl) && !providerBase(hint.signupUrl) ? hint.signupUrl : signup ?? null,
      models: unique([...(bases.length === 1 ? models : []), ...refinedModels]),
      endsAt: endsAt ?? hint?.endsAt ?? null, sources: [post.source],
    };
    return allowedDiscovery(item) ? [item] : [];
  });
}

function blockedPost(text: string) {
  return /(?:share (?:your|an) account|bring (?:someone else|another user)[^ ]* account|чуж[а-я]+\s+(?:аккаунт|уч[её]тк)|переда(?:ть|чи)\s+аккаунт)/i.test(text);
}

export async function fetchTelegram(channel: string, state: State, llm?: LlmClient, fetchText: (url: string) => Promise<string> = requestText) {
  const last = Object.hasOwn(state.telegramLastPost, channel) ? state.telegramLastPost[channel] : undefined;
  const posts = new Map<number, Post>();
  let before: number | undefined;
  for (;;) {
    const url = "https://t.me/s/" + channel + (before === undefined ? "" : "?before=" + before);
    const page = parseTelegram(await fetchText(url), channel)
      .filter(post => before === undefined || post.id < before)
      .sort((a, b) => b.id - a.id);
    if (!page.length) break;
    for (const post of page) {
      if (last !== undefined && post.id <= last || last === undefined && posts.size >= 100) break;
      posts.set(post.id, post);
    }
    before = page.at(-1)!.id;
    if (last === undefined ? posts.size >= 100 : before <= last) break;
  }
  const discoveries: DiscoveredInput[] = [];
  const ordered = [...posts.values()].sort((a, b) => a.id - b.id);
  for (const post of ordered) {
    discoveries.push(...await discoveriesFromPost(post, llm));
  }
  if (ordered.length) state.telegramLastPost[channel] = ordered.at(-1)!.id;
  return { count: ordered.length, discoveries };
}
