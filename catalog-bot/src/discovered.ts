import { probeCandidate } from "./probe.js";
import { compare } from "./merge.js";
import { providers } from "./registry/providers.js";
import type { Discovered, DiscoveredInput, Radar } from "./schema.js";
import { discoveryId, providerBase } from "./sources/discovery.js";
import { discoveryIntervalMs } from "./sources/freeInference.js";
import type { State } from "./state.js";
import type { Config } from "./config.js";

const tinyGrad: Discovered = {
  id: "tinygrad", name: "TinyGrad", baseUrl: null, signupUrl: "https://llm.tinygrad.win/",
  models: ["Qwen 3.8 Flash", "GLM 5.3 Flash"], endsAt: null, sources: ["https://llm.tinygrad.win/"],
  probe: { at: null, status: "watching", tools: null },
};

export async function updateDiscovered(
  radar: Radar | undefined, discoveries: DiscoveredInput[], state: State, config: Config, now: string,
  probe = probeCandidate,
) {
  const previous = radar?.discovered ?? [];
  const registered = new Set(Object.values(providers).map(provider => provider.baseUrl.replace(/\/+$/, "")));
  const entries = new Map(previous.map(item => [item.baseUrl ?? item.id, item]));
  if (!entries.has(tinyGrad.id)) entries.set(tinyGrad.id, tinyGrad);
  const used = new Set([...Object.keys(providers), ...[...entries.values()].map(item => item.id)]);
  const added = new Set<string>();
  for (const item of discoveries) {
    if (!item.baseUrl || registered.has(item.baseUrl)) continue;
    const existing = entries.get(item.baseUrl);
    const id = existing?.id ?? availableId(item.baseUrl, used);
    used.add(id);
    if (!existing) added.add(id);
    entries.set(item.baseUrl, {
      ...item, id, name: item.name === item.id ? existing?.name ?? item.name : item.name,
      signupUrl: item.signupUrl ?? existing?.signupUrl ?? null,
      endsAt: item.endsAt ?? existing?.endsAt ?? null,
      models: [...new Set([...item.models, ...existing?.models ?? []])].sort(compare),
      sources: [...new Set([...existing?.sources ?? [], ...item.sources])].slice(-30),
      limits: { ...existing?.limits, ...item.limits },
      probe: existing?.probe ?? { at: null, status: "pending", tools: null },
      probedModel: existing?.probedModel,
    });
  }

  const known = [...entries.values()].filter(item => !item.baseUrl || !registered.has(item.baseUrl));
  const due = known.filter(item => item.baseUrl &&
    (!item.probe.at || Date.parse(now) - Date.parse(item.probe.at) >= discoveryIntervalMs));
  for (let i = 0; i < due.length; i += 8) {
    await Promise.all(due.slice(i, i + 8).map(async item => {
      const keyBase = config.discoveryKeyBases && Object.hasOwn(config.discoveryKeyBases, item.id)
        ? config.discoveryKeyBases[item.id] : undefined;
      const key = keyBase && providerBase(keyBase) === item.baseUrl && item.baseUrl?.startsWith("https:")
        ? config.healthKeys[item.id] : undefined;
      const next = await probe(item, now, key);
      const priorFailures = Object.hasOwn(state.discoveryFailures, item.id) ? state.discoveryFailures[item.id] : 0;
      const failures = next.probe.status === "unreachable" ? priorFailures + 1 : 0;
      if (failures) state.discoveryFailures[item.id] = failures;
      else delete state.discoveryFailures[item.id];
      item.probe = failures >= 3 ? { ...next.probe, status: "dead" } : next.probe;
      item.probedModel = next.probedModel;
    }));
  }
  const discovered = known.sort((a, b) => compare(a.id, b.id));
  return {
    radar: { ...radar, schemaVersion: 1, generatedAt: now, models: radar?.models ?? [], discovered } satisfies Radar,
    added: discovered.filter(item => added.has(item.id)),
  };
}

function availableId(base: string, used: Set<string>) {
  const original = discoveryId(base);
  let id = original;
  for (let i = 2; used.has(id); i++) {
    const suffix = "-" + i;
    id = original.slice(0, 41 - suffix.length) + suffix;
  }
  return id;
}
