import { z } from "zod";
import { providerIdSchema } from "../shared/catalog-schema";
import { readJson, writeJson } from "./storage";
import { createHash } from "node:crypto";
import type { Catalog, Provider } from "../shared/catalog-schema";
import { personalProviders, remoteModelsSchema, type KeyId, type PersonalId, type PersonalProvider, type RemoteModel } from "../shared/providers";
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
  const explicitlyFree = zero(item.pricing?.prompt) && zero(item.pricing?.completion) || item.id.endsWith(":free");
  if (id === "openrouter") return explicitlyFree;
  const tools = item.capabilities?.tools ?? item.capabilities?.function_calling ?? item.supports_tools ??
    (Array.isArray(item.supported_parameters) ? item.supported_parameters.includes("tools") : undefined);
  if (tools === false) return false;
  if (explicitlyFree || item.free === true || item.tier === "free") return true;
  if (item.pricing?.prompt !== undefined || item.pricing?.completion !== undefined || item.free === false) return false;
  return freePlans.has(id);
}

async function modelsFor(provider: Provider | PersonalProvider, baseUrl: string, key: string, signal: AbortSignal, freeOnly = false) {
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
    if (response.status === 404 || response.status === 405) throw new Error("По этому адресу недоступен список моделей. Проверьте базовый URL.");
    throw new Error("Ключ не подошёл. Проверьте ключ и права доступа.");
  }
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data?.data)) throw new Error("Сервис вернул некорректный список моделей.");
  const models = new Map<string, RemoteModel>();
  for (const item of data.data) {
    if (typeof item?.id !== "string" || !chatModel(provider.id, item.id, item.capabilities) || freeOnly && !isFreeModel(provider.id, item)) continue;
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

export class ConnectService {
  private catalogModels: ProviderModelCache = {};
  private refreshes = new Map<KeyId, Promise<void>>();
  private writes = Promise.resolve();

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

  personalRoutes(catalog?: Catalog) {
    const personal = personalProviders.flatMap(provider => {
      const profile = this.keys.profile(provider.id);
      if (!profile || !this.keys.get(provider.id)) return [];
      return profile.models.map(model => ({
        model: { ...model, id: modelReference(provider.id, model.id), providerId: provider.id, providerName: provider.name, upstreamId: model.id },
        provider: { id: provider.id, name: provider.name, baseUrl: profile.baseUrl },
        upstreamId: model.id
      }));
    });
    const discovered = catalog?.providers.flatMap(provider => {
      const cached = this.catalogModels[provider.id];
      if (!cached || cached.baseUrl !== provider.baseUrl || !this.keys.get(provider.id)) return [];
      const known = new Set([
        ...catalog.models.map(model => model.id),
        ...catalog.offers.filter(offer => offer.providerId === provider.id).map(offer => offer.providerModelId)
      ]);
      return cached.models.filter(model => !known.has(model.id)).map(model => ({
        model: { ...model, id: modelReference(provider.id, model.id), providerId: provider.id, providerName: provider.name, upstreamId: model.id },
        provider: { id: provider.id, name: provider.name, baseUrl: cached.baseUrl },
        upstreamId: model.id
      }));
    }) ?? [];
    return [...personal, ...discovered];
  }

  connectedPersonal(): PersonalId[] {
    return personalProviders.filter(provider => this.keys.profile(provider.id) && this.keys.get(provider.id)).map(provider => provider.id);
  }

  async manual(provider: Provider | PersonalProvider, key: string, customUrl: string | undefined, signal: AbortSignal, selection?: RemoteModel[]) {
    if (!/^[!-~]+$/.test(key)) throw new Error("Ключ не подошёл. Вставьте ключ целиком.");
    const baseUrl = endpoint(provider.baseUrl ?? customUrl ?? "");
    const models = await modelsFor(provider, baseUrl, key, signal);
    if (signal.aborted) throw new Error("Подключение отменено.");
    if (!("auth" in provider) && !models.length) throw new Error("У этого ключа нет доступных моделей для чата.");
    const chosen = provider.id === "custom-api" && selection ? this.validateSelection(selection, models) : models;
    await this.keys.set(provider.id, key, "auth" in provider ? undefined : { baseUrl, models: chosen });
  }

  private validateSelection(selection: RemoteModel[], available: RemoteModel[]) {
    if (!selection.length || new Set(selection.map(model => model.id)).size !== selection.length ||
      selection.some(model => !available.some(entry => entry.id === model.id) || (model.output && model.output > (model.context ?? 32_768)))) {
      throw new Error("Выберите доступные модели и проверьте лимиты токенов.");
    }
    return selection;
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

  async saveCustomModels(selection: RemoteModel[]) {
    const key = this.keys.get("custom-api");
    const profile = this.keys.profile("custom-api");
    if (!key || !profile) throw new Error("Сначала подключите сервер.");
    await this.keys.set("custom-api", key, { ...profile, models: this.validateSelection(selection, await this.customModels()) });
  }

  async oauth(provider: Provider, open: (url: string) => Promise<void>, signal: AbortSignal) {
    if (provider.auth.type !== "oauth_pkce") throw new Error("Этот провайдер не поддерживает вход в браузере.");
    if (provider.id !== "openrouter" || provider.auth.authorizeUrl !== "https://openrouter.ai/auth" ||
      provider.auth.exchangeUrl !== "https://openrouter.ai/api/v1/auth/keys") throw new Error("В каталоге указан неизвестный адрес входа OpenRouter.");
    const key = await openRouterKey(provider.auth, open, signal);
    if (!signal.aborted) await this.keys.set(provider.id, key);
  }

  async disconnect(id: KeyId): Promise<void> {
    await this.keys.remove(id);
    const parsed = providerIdSchema.safeParse(id);
    if (parsed.success) {
      delete this.catalogModels[parsed.data];
      await this.saveCatalogModels();
    }
  }
}
