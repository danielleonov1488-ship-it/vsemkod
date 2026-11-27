import { compare, stableJson } from "./merge.js";
import type { FreeListProvider, Radar, RadarFreeLlmProvider, RadarObservation, RadarProvider } from "./schema.js";
import type { FreeLlmProvider } from "./sources/freeLlm.js";

const retentionMs = 30 * 24 * 60 * 60 * 1000;

export function mergeRadar(
  previous: Radar | undefined, observations: RadarObservation[], now: string,
  previousMissingSince: Record<string, string>,
): { radar: Radar; added: RadarObservation[]; missingSince: Record<string, string> } {
  const prior = new Map(previous?.models.map((model) => [model.id, model]));
  const priorMissing = new Map(Object.entries(previousMissingSince));
  const seen = new Map(observations.map((model) => [model.id, model]));
  const added: RadarObservation[] = [];
  const models: Radar["models"] = [];
  const missingSince = new Map<string, string>();
  for (const model of seen.values()) {
    const existing = prior.get(model.id);
    if (!existing) added.push(model);
    models.push({ ...model, firstSeen: existing?.firstSeen ?? now, lastSeen: now, active: true });
  }
  const cutoff = Date.parse(now) - retentionMs;
  for (const model of prior.values()) {
    if (seen.has(model.id)) continue;
    // lastSeen в опубликованном файле может отставать от последней проверки.
    const since = model.active ? now : priorMissing.get(model.id) ?? previous?.generatedAt ?? now;
    if (Date.parse(since) <= cutoff) continue;
    missingSince.set(model.id, since);
    models.push({ ...model, active: false });
  }
  return {
    radar: { ...previous, schemaVersion: 1, generatedAt: now, models: models.sort((a, b) => compare(a.id, b.id)) },
    added: added.sort((a, b) => compare(a.id, b.id)),
    missingSince: Object.fromEntries(missingSince),
  };
}

export function mergeProviderRadar(
  previous: Radar | undefined, known: FreeListProvider[], current: FreeListProvider[], now: string,
): { radar?: Radar; added: RadarProvider[] } {
  if (!known.length) return { radar: previous, added: [] };
  const names = new Set([...known, ...(previous?.providers ?? [])].map(({ name }) => name.toLowerCase()));
  const added: RadarProvider[] = [];
  for (const { name, section } of current) {
    const key = name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    added.push({ name, section, firstSeen: now, source: "awesome-free-llm-apis" });
  }
  if (!added.length) return { radar: previous, added };
  const providers = [...(previous?.providers ?? []), ...added].sort((a, b) => compare(a.name, b.name));
  return { radar: { ...previous, schemaVersion: 1, generatedAt: now, models: previous?.models ?? [], providers }, added };
}

export function mergeFreeLlmRadar(
  previous: Radar | undefined, current: FreeLlmProvider[], now: string, history?: Record<string, string>,
): { radar: Radar; added: RadarFreeLlmProvider[]; firstSeen: Record<string, string> } {
  const known = new Map(Object.entries(history ?? {}));
  for (const { slug, firstSeen } of previous?.freeLlm ?? []) known.set(slug, firstSeen);
  const initialized = history !== undefined || previous?.freeLlm !== undefined;
  const added: RadarFreeLlmProvider[] = [];
  const freeLlm = current.map((provider) => {
    const firstSeen = known.get(provider.slug);
    const entry = { ...provider, firstSeen: firstSeen ?? now };
    if (!firstSeen && initialized) added.push(entry);
    known.set(provider.slug, entry.firstSeen);
    return entry;
  });
  const radar: Radar = { ...previous, schemaVersion: 1, generatedAt: now, models: previous?.models ?? [], freeLlm };
  return { radar, added, firstSeen: Object.fromEntries(known) };
}

export function radarChanged(previous: Radar | undefined, next: Radar): boolean {
  const details = ({ models, providers = [], freeLlm, discovered }: Radar) =>
    stableJson({ models: models.map(({ lastSeen: _lastSeen, ...model }) => model), providers, freeLlm, discovered });
  return !previous || details(previous) !== details(next);
}
