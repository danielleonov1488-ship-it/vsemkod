import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRadar } from "./publish.js";
import { providers } from "./registry/providers.js";
import { providerIdSchema, providerSchema } from "./schema.js";
import type { Radar } from "./schema.js";
import { sha256 } from "./sources/common.js";
import { allowedDiscovery, isModelId, providerBase, publicUrl } from "./sources/discovery.js";

type DraftOffer = {
  providerModelId: string;
  expiresAt: string | null;
  supportsTools?: boolean;
  sources: string[];
};
export const draftEnd = "  // Конец черновиков approve";

function withDraft(source: string, id: string, value: unknown, comment: string): string {
  if (source.split(draftEnd).length !== 2) throw new Error("Метка черновиков реестра отсутствует или повторяется");
  const entry = (JSON.stringify(id) + ": " + JSON.stringify(value, null, 2) + ",")
    .split("\n").map(line => "  " + line).join("\n");
  if (source.includes("\n  " + JSON.stringify(id) + ":")) throw new Error("Черновик уже создан: " + id);
  return source.replace(draftEnd, () => "  // " + comment + "\n" + entry + "\n" + draftEnd);
}

export async function approve(id: string, radar?: Radar, registry = "src/registry"): Promise<string> {
  providerIdSchema.parse(id);
  const stamp = await (radar ?? readRadar());
  const item = stamp?.discovered?.find(candidate => candidate.id === id);
  const baseUrl = item?.baseUrl && providerBase(item.baseUrl);
  if (!item || !baseUrl || !allowedDiscovery(item)) throw new Error("В радаре нет подходящего API для " + id);
  if (Object.hasOwn(providers, id) || Object.values(providers).some(provider => provider.baseUrl === baseUrl)) {
    throw new Error("Провайдер уже в реестре: " + id);
  }
  const signupUrl = item.signupUrl && publicUrl(item.signupUrl)?.href;
  const anonymous = item.probe.status === "available" && item.probe.tools === true && item.probe.authenticated !== true;
  // HTTP 200 /models alone does not demonstrate anonymous chat.
  const provider = providerSchema.parse({
    id, name: item.name, api: "openai", auth: { type: anonymous ? "none" : "manual_key" },
    baseUrl, signupUrl: signupUrl || new URL(baseUrl).origin, keyPageUrl: null, keyPattern: null,
    loginMethods: [], clicksToConnect: anonymous ? 0 : 3, trust: "community", freeLimits: item.limits ?? {},
    dataPolicy: "TODO: проверить обработку данных", termsUrl: new URL(baseUrl).origin,
    notes: "TODO: сверить страницу ключей, условия, бесплатную квоту и способы входа.",
  });
  const models = [...new Set([...item.models, ...(item.probedModel ? [item.probedModel] : [])])].filter(isModelId);
  const offers: DraftOffer[] = models.map(providerModelId => ({
    providerModelId, expiresAt: item.endsAt, sources: item.sources,
    supportsTools: providerModelId === item.probedModel ? item.probe.tools ?? undefined : undefined,
  }));

  const path = resolve(registry);
  const files = [join(path, "providers.ts"), join(path, "offers.ts")];
  const lockPath = join(tmpdir(), "vsemkod-approve-" + sha256(path) + ".lock");
  const lock = await open(lockPath, "wx");
  try {
    const [originalProviders, originalOffers] = await Promise.all(files.map(file => readFile(file, "utf8")));
    const nextProviders = withDraft(originalProviders, id, provider, "TODO: заполнить ссылки на условия и политику данных.");
    const nextOffers = withDraft(originalOffers, id, offers, "TODO: подтвердить бесплатность, API ID, tools и срок.");
    try {
      await writeFile(files[0], nextProviders);
      await writeFile(files[1], nextOffers);
    } catch (error) {
      await Promise.all([writeFile(files[0], originalProviders), writeFile(files[1], originalOffers)]);
      throw error;
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
  return "Черновики " + id + " добавлены в providers.ts и offers.ts.\n" +
    "Проверьте страницу ключей, условия, политику данных, бесплатный лимит, ID и tools у моделей. " +
    "Затем перенесите подтверждённые записи в рабочие реестры.";
}
