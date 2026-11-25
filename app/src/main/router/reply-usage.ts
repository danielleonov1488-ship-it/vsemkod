import { cachePercent } from "../../shared/usage";

type CacheUsage = {
  input?: number; cache?: { read?: number }; prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number;
};

export function providerCachePercent(usage: CacheUsage): number | undefined {
  if (typeof usage.input === "number" && typeof usage.cache?.read === "number") {
    return cachePercent(usage.input, usage.cache.read);
  }
  const read = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  if (typeof read !== "number") return;
  const input = usage.prompt_cache_miss_tokens ?? (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens - read : undefined);
  if (typeof input === "number") return cachePercent(input, read);
}

export function readReplyUsage(isStream: boolean) {
  const decoder = new TextDecoder();
  const sizeLimit = 1024 * 1024;
  let pending = "";
  let cache: number | undefined;
  let skipped = false;
  const parse = (payload: string) => {
    try {
      const event = JSON.parse(payload);
      if (event?.usage && typeof event.usage === "object") cache = providerCachePercent(event.usage);
    } catch { /* Other SSE messages carry no usage. */ }
  };
  function consume() {
    let separator = /\r?\n\r?\n/.exec(pending);
    while (separator) {
      if (!skipped && separator.index < sizeLimit) {
        const payload = pending.slice(0, separator.index).split(/\r?\n/)
          .filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (payload && payload !== "[DONE]") parse(payload);
      }
      pending = pending.slice(separator.index + separator[0].length);
      skipped = false;
      separator = /\r?\n\r?\n/.exec(pending);
    }
    if (pending.length > sizeLimit) { pending = pending.slice(-3); skipped = true; }
  }
  return {
    push(chunk: Uint8Array) {
      if (!isStream && skipped) return;
      pending += decoder.decode(chunk, { stream: true });
      if (isStream) consume();
      else if (pending.length > sizeLimit) { pending = ""; skipped = true; }
    },
    finish() {
      pending += decoder.decode();
      if (isStream) { pending += "\n\n"; consume(); }
      else if (!skipped) parse(pending);
      return cache;
    }
  };
}
