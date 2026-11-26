import { cachePercent, estimateTokens, replySpeed, tokenCharacters } from "../../shared/usage";

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

export function readReplyUsage(isStream: boolean, started = 0, now = () => performance.now()) {
  const decoder = new TextDecoder();
  const sizeLimit = 1024 * 1024;
  let pending = "";
  let cache: number | undefined;
  let skipped = false;
  let cyrillic = 0;
  let other = 0;
  let first: number | undefined;
  let exact: number | undefined;
  let previousTokens = 0;
  function speed(live = false) {
    const tokens = live ? undefined : exact;
    const value = replySpeed(tokens === undefined ? estimateTokens(cyrillic, other) : tokens + previousTokens, 0, started, first, now());
    return value && { ...value, estimated: tokens === undefined || previousTokens > 0 };
  }
  const parse = (payload: string) => {
    try {
      const event = JSON.parse(payload);
      if (event?.usage && typeof event.usage === "object") {
        cache = providerCachePercent(event.usage) ?? cache;
        const output = event.usage.completion_tokens ?? event.usage.output_tokens ?? event.usage.output;
        if (typeof output === "number" && output > 0 && Number.isFinite(output)) exact = output;
      }
      for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
        const message = choice?.delta ?? choice?.message;
        const text = [message?.content ?? choice?.text, message?.reasoning_content ?? message?.reasoning ?? message?.reasoning_text]
          .filter((value): value is string => typeof value === "string").join("");
        if (text || message?.tool_calls?.length) first ??= now();
        if (!text) continue;
        const count = tokenCharacters(text);
        cyrillic += count.cyrillic;
        other += count.other;
      }
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
    speed,
    nextStream() {
      previousTokens = estimateTokens(cyrillic, other);
      exact = undefined;
      cache = undefined;
    },
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
