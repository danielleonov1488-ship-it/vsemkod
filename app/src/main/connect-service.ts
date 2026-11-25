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

async function modelsFor(provider: Provider | PersonalProvider, baseUrl: string, key: string, signal: AbortSignal) {
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
    if (typeof item?.id !== "string" || !chatModel(provider.id, item.id, item.capabilities)) continue;
    const result = remoteModelsSchema.element.safeParse({
      id: item.id, name: item.display_name || item.name || item.id,
      context: [item.context_window, item.context_length, item.max_context_window].find(value => Number.isSafeInteger(value) && value > 0),
      vision: typeof item.capabilities?.vision === "boolean" ? item.capabilities.vision : undefined
    });
    if (result.success) models.set(item.id, result.data);
    if (models.size >= 1000) break;
  }
  return [...models.values()];
}

export class ConnectService {
  constructor(private readonly keys: KeyStore) {}

  connected(catalog: Catalog) {
    return catalog.providers
      .filter(provider => provider.auth.type === "none" || this.keys.get(provider.id))
      .map(provider => provider.id);
  }

  key(id: KeyId): string | undefined {
    return this.keys.get(id);
  }

  personalRoutes() {
    return personalProviders.flatMap(provider => {
      const profile = this.keys.profile(provider.id);
      if (!profile || !this.keys.get(provider.id)) return [];
      return profile.models.map(model => ({
        model: { ...model, id: modelReference(provider.id, model.id), providerId: provider.id, providerName: provider.name },
        provider: { id: provider.id, name: provider.name, baseUrl: profile.baseUrl },
        upstreamId: model.id
      }));
    });
  }

  connectedPersonal(): PersonalId[] {
    return personalProviders.filter(provider => this.keys.profile(provider.id) && this.keys.get(provider.id)).map(provider => provider.id);
  }

  async manual(provider: Provider | PersonalProvider, key: string, customUrl: string | undefined, signal: AbortSignal) {
    if (!/^[!-~]+$/.test(key)) throw new Error("Ключ не подошёл. Вставьте ключ целиком.");
    const baseUrl = endpoint(provider.baseUrl ?? customUrl ?? "");
    const models = await modelsFor(provider, baseUrl, key, signal);
    if (signal.aborted) throw new Error("Подключение отменено.");
    if (!("auth" in provider) && !models.length) throw new Error("У этого ключа нет доступных моделей для чата.");
    await this.keys.set(provider.id, key, "auth" in provider ? undefined : { baseUrl, models });
  }

  async oauth(provider: Provider, open: (url: string) => Promise<void>, signal: AbortSignal) {
    if (provider.auth.type !== "oauth_pkce") throw new Error("Этот провайдер не поддерживает вход в браузере.");
    if (provider.id !== "openrouter" || provider.auth.authorizeUrl !== "https://openrouter.ai/auth" ||
      provider.auth.exchangeUrl !== "https://openrouter.ai/api/v1/auth/keys") throw new Error("В каталоге указан неизвестный адрес входа OpenRouter.");
    const key = await openRouterKey(provider.auth, open, signal);
    if (!signal.aborted) await this.keys.set(provider.id, key);
  }

  disconnect(id: KeyId): Promise<void> {
    return this.keys.remove(id);
  }
}
