import { z } from "zod";
import type { Config } from "./config.js";
import { matchModel } from "./match.js";
import { providers } from "./registry/providers.js";
import { offerKey } from "./schema.js";
import type { Catalog, Offer, ProviderId } from "./schema.js";
import type { HealthState, State } from "./state.js";
import { describeError, request } from "./sources/common.js";
import { hasQualifier } from "./sources/openrouter.js";

const tool = {
  type: "function",
  function: {
    name: "ping",
    description: "Return a health check signal",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const completion = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(z.object({ function: z.object({ name: z.string() }) })).nullish(),
    }),
  })).min(1),
});

async function probe(offer: Offer, key: string, withTools: boolean): Promise<boolean> {
  const url = providers[offer.providerId].baseUrl + "/chat/completions";
  const response = await request(url, (result) => result.json(), {
    method: "POST",
    redirect: "error",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: offer.providerModelId,
      messages: [{ role: "user", content: withTools ? "Call ping." : "Reply OK." }],
      max_tokens: 8,
      ...(withTools ? { tools: [tool], tool_choice: { type: "function", function: { name: "ping" } } } : {}),
    }),
  }, 0);
  const message = completion.parse(response).choices[0].message;
  return message.tool_calls?.some((call) => call.function.name === "ping") ?? false;
}

export async function checkOffers(
  catalog: Catalog, tracks: State["tracks"], config: Config, now: string,
): Promise<{ updates: Record<string, HealthState>; errors: string[] }> {
  const updates: Record<string, HealthState> = {};
  const errors: string[] = [];
  const candidates = catalog.candidates.filter((offer) =>
    offer.confidence === "news" && matchModel(offer.providerModelId) &&
    (offer.providerId === "kilo" || offer.providerId === "openrouter" || offer.providerId === "numes") &&
    hasQualifier(offer.providerModelId, "free") && !/:org-/i.test(offer.providerModelId),
  );
  const entries = [...catalog.offers, ...candidates];
  const cutoff = Date.parse(now) - config.healthIntervalHours * 3600 * 1000;

  // Последовательно внутри провайдера, независимо между провайдерами.
  await Promise.all(Object.entries(config.healthKeys).map(async ([providerId, key]) => {
    for (const offer of entries) {
      if (offer.providerId !== (providerId as ProviderId) || offer.status === "ended" || !key) continue;
      const identity = offerKey(offer);
      const track = tracks[identity];
      const prior = track?.health;
      if (prior && Date.parse(prior.checkedAt) > cutoff) continue;
      let status: HealthState;
      try {
        await probe(offer, key, false);
        status = { checkedAt: now, verifiedAt: now, consecutiveFailures: 0, supportsTools: prior?.supportsTools };
      } catch (error) {
        updates[identity] = {
          checkedAt: now, verifiedAt: prior?.verifiedAt ?? null,
          consecutiveFailures: (prior?.consecutiveFailures ?? 0) + 1,
          supportsTools: prior?.supportsTools,
        };
        errors.push(identity + " — " + describeError(error));
        continue;
      }
      const declaredTools = Object.values(track?.evidence ?? {}).some(({ observation }) => observation.supportsTools === true);
      if (declaredTools || offer.supportsTools) {
        try {
          status.supportsTools = await probe(offer, key, true);
        } catch (error) {
          errors.push(identity + " (tools) — " + describeError(error));
        }
      }
      updates[identity] = status;
    }
  }));
  return { updates, errors: errors.sort() };
}
