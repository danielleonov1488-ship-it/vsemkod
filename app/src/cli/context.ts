
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import bundled from "../../resources/catalog.json";
import { CatalogService } from "../main/catalog-service";
import { ConnectService } from "../main/connect-service";
import type { KeyStore } from "../main/key-store";
import { Router } from "../main/router";
import { ProviderHealth } from "../main/router/health";
import { writeJson } from "../main/storage";
import { activeOffers, rankedModels } from "../shared/catalog";
import type { Catalog } from "../shared/catalog-schema";
import { personalProviders, type PersonalProvider } from "../shared/providers";
import { FileKeys } from "./file-keys";

type Profile = NonNullable<ReturnType<FileKeys["profile"]>>;

async function personalProfile(provider: PersonalProvider, key: string): Promise<Profile | undefined> {
  // Capture ConnectService's validated profile in memory for environment keys.
  let profile: Profile | undefined;
  const temporary = { profile: () => undefined, set: async (_id: string, _key: string, value: Profile) => { profile = value; } };
  const service = new ConnectService(temporary as unknown as KeyStore);
  await service.manual(provider, key, undefined, new AbortController().signal);
  return profile;
}

export async function openContext(data: string, refresh = true) {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const bundledPath = join(data, "bundled", "catalog.json");
  if (await readFile(bundledPath, "utf8").catch(() => undefined) !== JSON.stringify(bundled)) await writeJson(bundledPath, bundled);
  const catalog = new CatalogService(data, bundledPath);
  const keys = new FileKeys(join(data, "keys.json"));
  await Promise.all([keys.load(), catalog.loadInitial()]);
  if (refresh) await catalog.refresh();

  const envProfiles = new Map<string, Profile>();
  const keyAccess: Pick<KeyStore, "get" | "ids" | "profile" | "set" | "remove"> = {
    get: id => keys.get(id),
    ids: () => keys.ids(),
    profile: id => envProfiles.get(id) ?? keys.profile(id),
    set: (id, key, profile) => keys.set(id, key, profile),
    remove: id => keys.remove(id)
  };
  // ConnectService's constructor names the desktop class, whose private fields make it nominal.
  // At runtime the service uses only the public key operations above.
  const connections = new ConnectService(keyAccess as KeyStore, join(data, "provider-models.json"));
  await connections.loadCatalogModels();

  return { catalog, keys, connections, async refreshModels() {
    const personal = personalProviders.map(async provider => {
      const key = keys.environment(provider.id);
      if (!key || !provider.baseUrl || keys.profile(provider.id)) return;
      const profile = await personalProfile(provider, key).catch(() => undefined);
      if (profile) envProfiles.set(provider.id, profile);
    });
    await Promise.all([connections.refreshCatalogModels(catalog.current), ...personal]);
  } };
}

export type CliContext = Awaited<ReturnType<typeof openContext>>;

export async function startRouter(data: string, context: CliContext, catalog: Catalog) {
  const health = new ProviderHealth(join(data, "usage.json"));
  await health.load();
  const { connections } = context;
  const router = new Router({
    catalog: () => catalog,
    key: id => connections.key(id),
    personal: () => connections.personalRoutes(),
    customIds: () => connections.customProviders().map(provider => provider.id),
    legacyModel: id => connections.legacyCatalogModel(context.catalog.current, id),
    health
  });
  await router.start();
  return router;
}

export function modelList(catalog: Catalog, context: CliContext, all: boolean) {
  const free = rankedModels(catalog).flatMap(model => {
    const offers = activeOffers(catalog, model.id).filter(({ offer }) => offer.free);
    const connected = offers.filter(({ provider }) => provider.auth.type === "none" || context.keys.get(provider.id));
    if (!connected.length && !all) return [];
    const providers = [...new Set((connected.length ? connected : offers).map(({ provider }) => provider.name))];
    return [{ id: model.id, name: model.name, detail: providers.join(", ") + (connected.length ? "" : providers.length ? " · нужен ключ" : "нет активных раздач") }];
  });
  const own = context.connections.personalRoutes().map(({ model }) => ({ id: model.id, name: model.name, detail: model.providerName + " · своё подключение" }));
  return [...free, ...own];
}
