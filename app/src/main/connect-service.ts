import { z } from "zod";
import { providerIdSchema } from "../shared/catalog-schema";
import { readJson, writeJson } from "./storage";
import { createHash, randomBytes } from "node:crypto";
import { catalogModelId, effectiveCatalog, type DiscoveredModels } from "../shared/model-merge";
import type { CustomProvider } from "../shared/api";
import type { Catalog, Provider } from "../shared/catalog-schema";
import { customIdSchema, personalProviders, remoteModelsSchema, type KeyId, type PersonalId, type PersonalKind, type PersonalProvider, type RemoteModel } from "../shared/providers";
import type { KeyStore } from "./key-store";
import { openRouterKey } from "./openrouter-oauth";

export function modelReference(providerId: string, modelId: string) {
  return providerId + ":" + createHash("sha256").update(modelId).digest("hex").slice(0, 32);
}

function endpoint(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Введите базовый URL, например https://example.com/v1."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash) {
    throw new Error("Укажите HTTPS-адрес без логина, параметров и фрагмента. Для localhost доступен HTTP.");
  }
  return url.href.replace(/\/+$/, "");
}

function chatModel(providerId: KeyId, id: string, capabilities: unknown) {
  if (capabilities && typeof capabilities === "object" && "completion_chat" in capabilities && capabilities.completion_chat === false) return false;
  if (providerId === "openai-api") return /^(?:gpt-|o[134](?:-|$)|chatgpt-)/i.test(id) &&
    !/audio|realtime|transcribe|tts|image|instruct|codex|search|moderation|chat-latest/i.test(id);
  if (providerId === "google-api") return /(?:^|\/)gemini-/i.test(id) && !/embedding|tts|audio|live|image|computer-use/i.test(id);
  return !/embedding|whisper|moderation|guard|transcribe|(?:^|[-_/])rerank|(?:^|[-_/])tts/i.test(id);
}

const freePlans = new Set<KeyId>(["numes", "groq", "modelscope", "kilo"]);
const providerModelsSchema = z.partialRecord(providerIdSchema, z.object({
  baseUrl: z.url(), updatedAt: z.number(), models: remoteModelsSchema
}));
type ProviderModelCache = z.infer<typeof providerModelsSchema>;

function isFreeModel(id: KeyId, item: {
  id: string; pricing?: { prompt?: unknown; completion?: unknown }; free?: unknown; tier?: unknown;
  capabilities?: { tools?: boolean; function_calling?: boolean }; supports_tools?: boolean; supported_parameters?: string[];
}) {
  const zero = (price: unknown) => price === "0" || price === 0;
  const prices = [item.pricing?.prompt, item.pricing?.completion];
  const explicitlyFree = prices.every(zero) || item.id.endsWith(":free") && prices.every(price => price === undefined || zero(price));
  const tools = item.capabilities?.tools ?? item.capabilities?.function_calling ?? item.supports_tools ??
    (Array.isArray(item.supported_parameters) ? item.supported_parameters.includes("tools") : undefined);
  if (tools === false || item.free === false) return false;
  if (id === "openrouter" || explicitlyFree) return explicitlyFree;
  if (prices.some(price => price !== undefined)) return false;
  if (item.free === true || item.tier === "free") return true;
  return freePlans.has(id);
}

class ModelsError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const customProviderName = "Свой OpenAI-совместимый";
export const customProviderIdSchema = z.union([z.literal("custom-api"), customIdSchema]);
export const customSelectionSchema = remoteModelsSchema.min(1).max(50).refine(models => models.every(({ id }) =>
  id.length <= 200 && id.trim() === id), "Проверьте идентификаторы моделей (1–200 символов, без пробелов по краям).");
type CustomSave = Omit<CustomProvider, "id"> & { id?: string; key?: string };

async function modelsFor(provider: { id: KeyId }, baseUrl: string, key: string,
  signal: AbortSignal, freeOnly = false) {
  const anthropic = provider.id === "anthropic-api";
  let response: Response;
  try {
    response = await fetch(baseUrl + "/models", {
      redirect: "error",
      headers: anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: "Bearer " + key },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    });
  } catch { throw new Error(signal.aborted ? "Подключение отменено." : "Не удалось проверить ключ. Проверьте соединение и адрес API."); }
  if (!response.ok) {
    void response.body?.cancel();
    if (response.status === 429) throw new Error("Сервис ограничил запросы. Попробуйте позже.");
    if (response.status >= 500) throw new Error("Сервис временно недоступен. Попробуйте позже.");
    if (response.status === 404 || response.status === 405) {
      throw new ModelsError("По этому адресу недоступен список моделей. Проверьте базовый URL.", response.status);
    }
    throw new Error("Ключ не подошёл. Проверьте ключ и права доступа.");
  }
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data?.data)) throw new Error("Сервис вернул некорректный список моделей.");
  const models = new Map<string, RemoteModel>();
  const custom = customProviderIdSchema.safeParse(provider.id).success;
  for (const item of data.data) {
    if (typeof item?.id !== "string" || !custom && !chatModel(provider.id, item.id, item.capabilities) ||
      freeOnly && !isFreeModel(provider.id, item)) continue;
    const result = remoteModelsSchema.element.safeParse({
      id: item.id, name: item.display_name || item.name || item.id,
      output: [item.max_output_tokens, item.max_completion_tokens].find(value => Number.isSafeInteger(value) && value > 0),
      context: [item.context_window, item.context_length, item.max_context_window].find(value => Number.isSafeInteger(value) && value > 0),
      vision: typeof item.capabilities?.vision === "boolean" ? item.capabilities.vision : undefined
    });
    if (result.success) models.set(item.id, result.data);
    if (models.size >= 1000) break;
  }
  return [...models.values()];
}

async function probeCompletion(baseUrl: string, key: string, model: string, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(baseUrl + "/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false })
    });
  } catch {
    throw new Error(signal.aborted ? "Подключение отменено." : "Не удалось проверить ключ. Проверьте соединение и адрес API.");
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) throw new Error("Ключ не подошёл");
  if (response.status === 404) throw new Error("Модель " + model + " не найдена у поставщика");
  if (response.status === 429 || response.status >= 500) {
    console.warn("[connect] Проверочный запрос временно недоступен (HTTP " + response.status + "). Подключение сохранено.");
    return;
  }
  throw new Error("Не удалось проверить модель (HTTP " + response.status + "). Проверьте адрес API и id модели.");
}

export class ConnectService {
  private catalogModels: ProviderModelCache = {};
  private refreshes = new Map<KeyId, Promise<void>>();
  private writes = Promise.resolve();
  private customChanges = Promise.resolve();
  private merged?: { base: Catalog; catalog: Catalog; aliases: Map<string, string> };

  constructor(private readonly keys: KeyStore, private readonly cachePath?: string) {}

  async loadCatalogModels() {
    if (this.cachePath) this.catalogModels = await readJson(this.cachePath, providerModelsSchema) ?? {};
  }

  async refreshCatalogModels(catalog: Catalog, signal = new AbortController().signal, force?: KeyId) {
    await Promise.all(catalog.providers.map(provider => {
      if (force && provider.id !== force) return;
      const key = this.keys.get(provider.id);
      if (!key || !provider.baseUrl) return;
      const cached = this.catalogModels[provider.id];
      if (!force && cached?.baseUrl === provider.baseUrl && Date.now() - cached.updatedAt < 6 * 60 * 60_000) return;
      const active = this.refreshes.get(provider.id);
      if (active) return force ? active.then(() => this.refreshCatalogModels(catalog, signal, force)) : active;
      const task = modelsFor(provider, endpoint(provider.baseUrl), key, signal, true).then(async models => {
        if (signal.aborted || this.keys.get(provider.id) !== key) return;
        this.catalogModels[provider.id] = { baseUrl: provider.baseUrl!, updatedAt: Date.now(), models };
        this.merged = undefined;
        await this.saveCatalogModels();
      }).catch(() => { /* Keep the last free list on temporary API errors. */ }).finally(() => this.refreshes.delete(provider.id));
      this.refreshes.set(provider.id, task);
      return task;
    }));
  }

  private saveCatalogModels() {
    const path = this.cachePath;
    if (path) this.writes = this.writes.then(() => writeJson(path, this.catalogModels)).catch(() => {});
    return this.writes;
  }

  connected(catalog: Catalog) {
    return catalog.providers
      .filter(provider => provider.auth.type === "none" || this.keys.get(provider.id))
      .map(provider => provider.id);
  }

  key(id: KeyId): string | undefined {
    return this.keys.get(id);
  }

  effectiveCatalog(base: Catalog) {
    if (this.merged?.base === base) return this.merged.catalog;
    const discovered: DiscoveredModels = {};
    for (const provider of base.providers) {
      const cached = this.catalogModels[provider.id];
      if (cached?.baseUrl === provider.baseUrl && this.keys.get(provider.id)) discovered[provider.id] = cached;
    }
    const catalog = effectiveCatalog(base, discovered);
    const aliases = new Map<string, string>();
    for (const provider of base.providers) {
      for (const model of discovered[provider.id]?.models ?? []) {
        const id = catalogModelId(catalog, model.id);
        if (id) aliases.set(modelReference(provider.id, model.id), id);
      }
    }
    this.merged = { base, catalog, aliases };
    return catalog;
  }

  legacyCatalogModel(base: Catalog, id: string) {
    this.effectiveCatalog(base);
    return this.merged?.aliases.get(id);
  }

  customProviders(): CustomProvider[] {
    return this.keys.ids().flatMap(id => {
      if (!customProviderIdSchema.safeParse(id).success) return [];
      const profile = this.keys.profile(id);
      if (!profile) return [];
      return [{ id, baseUrl: profile.baseUrl, models: profile.models, name: profile.name ?? customProviderName }];
    });
  }

  personalRoutes() {
    const routes = (id: KeyId, name: string, kind: PersonalKind, profile = this.keys.profile(id)) => {
      if (!profile || !this.keys.get(id)) return [];
      return profile.models.map(model => ({
        model: { ...model, id: modelReference(id, model.id), providerId: id, providerName: name, upstreamId: model.id, kind },
        provider: { id, name, baseUrl: profile.baseUrl },
        upstreamId: model.id
      }));
    };
    return [
      ...personalProviders.filter(provider => provider.id !== "custom-api").flatMap(provider => routes(provider.id, provider.name, provider.kind)),
      ...this.customProviders().flatMap(provider => routes(provider.id, provider.name, "custom", provider))
    ];
  }

  connectedPersonal(): PersonalId[] {
    return personalProviders.filter(provider => this.keys.profile(provider.id) && this.keys.get(provider.id)).map(provider => provider.id);
  }

  async manual(provider: Provider | PersonalProvider, key: string, customUrl: string | undefined, signal: AbortSignal, selection?: RemoteModel[]) {
    if (!/^[!-~]+$/.test(key)) throw new Error("Ключ не подошёл. Вставьте ключ целиком.");
    const baseUrl = endpoint(provider.baseUrl ?? customUrl ?? "");
    const models = "models" in provider && provider.models ? provider.models : await modelsFor(provider, baseUrl, key, signal);
    if (!("auth" in provider) && provider.kind === "plan" && models.length) {
      await probeCompletion(baseUrl, key, models[0].id, signal);
    }
    if (signal.aborted) throw new Error("Подключение отменено.");
    if (!("auth" in provider) && !models.length) throw new Error("У этого ключа нет доступных моделей для чата.");
    const chosen = provider.id === "custom-api" && selection ? this.validateSelection(selection, models) : models;
    const store = () => this.keys.set(provider.id, key, "auth" in provider ? undefined :
      { baseUrl, models: chosen, name: this.keys.profile(provider.id)?.name });
    if (provider.id === "custom-api") await this.changeCustom(store);
    else await store();
    this.merged = undefined;
  }

  private validateSelection(selection: RemoteModel[], available?: RemoteModel[]) {
    if (!selection.length || new Set(selection.map(model => model.id)).size !== selection.length ||
      selection.some(model => available && !available.some(entry => entry.id === model.id) ||
        (model.output && model.output > (model.context ?? 32_768)))) {
      throw new Error("Выберите доступные модели и проверьте лимиты токенов.");
    }
    return selection;
  }

  async customProviderModels(input: { baseUrl: string; key: string } | { id: string }) {
    const id = "id" in input ? customProviderIdSchema.parse(input.id) : "custom-api";
    const profile = "id" in input ? this.keys.profile(id) : undefined;
    const baseUrl = "baseUrl" in input ? endpoint(input.baseUrl) : profile?.baseUrl;
    const key = "key" in input ? input.key : this.keys.get(id);
    if (!baseUrl || !key) throw new Error("Укажите адрес API и ключ.");
    try {
      const models = await modelsFor({ id }, baseUrl, key, AbortSignal.timeout(15_000));
      return models.map(model => ({ ...model, ...profile?.models.find(saved => saved.id === model.id) }));
    } catch (error) {
      if (error instanceof ModelsError) throw new Error("Сервер не отдаёт список моделей. Впишите id модели вручную.");
      throw error;
    }
  }

  saveCustomProvider(input: CustomSave) {
    return this.changeCustom(async () => {
      const name = input.name.trim();
      if (!name || name.length > 60) throw new Error("Введите название поставщика (1–60 символов).");
      const baseUrl = endpoint(input.baseUrl);
      const parsed = customSelectionSchema.safeParse(input.models);
      if (!parsed.success) throw new Error("Укажите от 1 до 50 моделей (id до 200 символов, без пробелов по краям).");
      const selection = this.validateSelection(parsed.data);
      let id = input.id === undefined ? undefined : customProviderIdSchema.parse(input.id);
      if (id && !this.keys.profile(id)) throw new Error("Поставщик не найден.");
      const key = input.key ?? (id ? this.keys.get(id) : undefined);
      if (!key || !/^[!-~]+$/.test(key)) throw new Error("Ключ не подошёл. Вставьте ключ целиком.");
      const signal = new AbortController().signal;
      const available = await modelsFor({ id: id ?? "custom-api" }, baseUrl, key, signal).catch(() => undefined);
      if (available) this.validateSelection(selection, available);
      else await probeCompletion(baseUrl, key, selection[0].id, signal);
      if (!id) {
        const ids = new Set(this.keys.ids());
        do { id = "custom-" + randomBytes(4).toString("hex"); } while (ids.has(id));
      }
      await this.keys.set(id, key, { name, baseUrl, models: selection });
      return id;
    });
  }

  private changeCustom<T>(run: () => Promise<T>) {
    const task = this.customChanges.then(run);
    this.customChanges = task.then(() => {}, () => {});
    return task;
  }

  async customModels(input?: { baseUrl: string; key: string }) {
    const provider = personalProviders.find(item => item.id === "custom-api")!;
    const profile = this.keys.profile("custom-api");
    const baseUrl = input ? endpoint(input.baseUrl) : profile?.baseUrl;
    const key = input?.key ?? this.keys.get("custom-api");
    if (!baseUrl || !key) throw new Error("Укажите адрес API и ключ.");
    const models = await modelsFor(provider, baseUrl, key, AbortSignal.timeout(15_000));
    return models.map(model => ({ ...model, ...profile?.models.find(saved => saved.id === model.id) }));
  }

  saveCustomModels(selection: RemoteModel[]) {
    return this.changeCustom(async () => {
      const key = this.keys.get("custom-api");
      const profile = this.keys.profile("custom-api");
      if (!key || !profile) throw new Error("Сначала подключите сервер.");
      await this.keys.set("custom-api", key, { ...profile, models: this.validateSelection(selection, await this.customModels()) });
    });
  }

  async oauth(provider: Provider, open: (url: string) => Promise<void>, signal: AbortSignal) {
    if (provider.auth.type !== "oauth_pkce") throw new Error("Этот провайдер не поддерживает вход в браузере.");
    if (provider.id !== "openrouter" || provider.auth.authorizeUrl !== "https://openrouter.ai/auth" ||
      provider.auth.exchangeUrl !== "https://openrouter.ai/api/v1/auth/keys") throw new Error("В каталоге указан неизвестный адрес входа OpenRouter.");
    const key = await openRouterKey(provider.auth, open, signal);
    if (!signal.aborted) {
      await this.keys.set(provider.id, key);
      this.merged = undefined;
    }
  }

  async disconnect(id: KeyId): Promise<void> {
    if (customProviderIdSchema.safeParse(id).success) await this.changeCustom(() => this.keys.remove(id));
    else await this.keys.remove(id);
    this.merged = undefined;
    const parsed = providerIdSchema.safeParse(id);
    if (parsed.success) {
      delete this.catalogModels[parsed.data];
      await this.saveCatalogModels();
    }
  }
}
