import { compare, stableJson } from "./merge.js";
import type { Radar, RadarObservation } from "./schema.js";

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
    radar: { schemaVersion: 1, generatedAt: now, models: models.sort((a, b) => compare(a.id, b.id)) },
    added: added.sort((a, b) => compare(a.id, b.id)),
    missingSince: Object.fromEntries(missingSince),
  };
}

export function radarChanged(previous: Radar | undefined, next: Radar): boolean {
  const details = ({ models }: Radar) =>
    stableJson(models.map(({ lastSeen: _lastSeen, ...model }) => model));
  return !previous || details(previous) !== details(next);
}
