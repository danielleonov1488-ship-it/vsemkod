
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { catalogSchema } from "../shared/catalog-schema";
import { defaultModel } from "../shared/catalog";
import { personalProviders, type KeyId } from "../shared/providers";
import { type CliContext, startRouter } from "./context";
import { engineVersion, ensureEngine } from "./engine";
import { keyVariable } from "./file-keys";
import { engineEnvironment } from "./process";

const execute = promisify(execFile);

async function catalogSource() {
  const sources = [
    ["vsemkod.ru", "https://vsemkod.ru/catalog.json"],
    ["зеркало GitHub", "https://raw.githubusercontent.com/danielleonov1488-ship-it/vsemkod/main/catalog-bot/data/catalog.json"]
  ];
  for (const [name, url] of sources) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok && catalogSchema.safeParse(await response.json()).success) return name;
      await response.body?.cancel().catch(() => {});
    } catch { /* Try the mirror. */ }
  }
}

async function probeKey(id: KeyId, key: string, baseUrl?: string) {
  if (!/^[!-~]+$/.test(key)) return "invalid";
  if (!baseUrl) return "unknown";
  const headers: HeadersInit = id === "anthropic-api" ?
    { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: "Bearer " + key };
  try {
    const response = await fetch(baseUrl.replace(/\/+$/, "") + "/models", { headers, redirect: "error", signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return "invalid";
    if (response.ok) return "ok";
  } catch { /* The provider may be temporarily unavailable. */ }
  return "unknown";
}

export async function doctor(data: string, context: CliContext) {
  const { catalog, keys } = context;
  const probe = async () => {
    const executable = await ensureEngine(data);
    const { env } = await engineEnvironment(data);
    const { stdout } = await execute(executable, ["--version"], { env, cwd: data, timeout: 10_000 });
    if (stdout.trim().split(/\s+/).at(-1)?.replace(/^v/, "") !== engineVersion) {
      throw new Error("Ожидается OpenCode " + engineVersion + ". Проверьте VSEMKOD_ENGINE.");
    }
  };

  const routerProbe = async () => {
    const router = await startRouter(data, context, catalog.current);
    try {
      const response = await fetch(router.baseUrl + "/models", {
        headers: { authorization: "Bearer " + router.token }, signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok || !Array.isArray((await response.json()).data)) throw new Error("Нет списка моделей.");
    } finally { await router.close(); }
  };

  const [engine, source, router] = await Promise.allSettled([probe(), catalogSource(), routerProbe()]);
  if (engine.status === "fulfilled") console.log("Движок · OpenCode " + engineVersion);
  else console.log("Движок · ошибка. Проверьте загрузку из GitHub и путь VSEMKOD_ENGINE.");
  if (source.status === "fulfilled" && source.value) console.log("Каталог · " + source.value);
  else console.log("Каталог · локальная копия. Проверьте доступ к vsemkod.ru и GitHub.");
  if (router.status === "fulfilled") console.log("Роутер · работает на 127.0.0.1");
  else console.log("Роутер · ошибка. Проверьте доступ к 127.0.0.1.");
  const endpoints = new Map<KeyId, string | undefined>([...catalog.current.providers, ...personalProviders].map(provider => [provider.id, provider.baseUrl]));
  for (const id of keys.ids()) {
    const profile = keys.profile(id);
    if (profile) endpoints.set(id, profile.baseUrl);
  }
  const connected = (await Promise.all([...endpoints].map(async ([id, url]) => {
    const key = keys.get(id);
    if (!key) return;
    return { id, result: await probeKey(id, key, url) };
  }))).filter(item => item !== undefined);
  for (const { id, result } of connected) {
    const source = keys.environment(id) ? keyVariable(id) : "keys.json";
    const status = result === "ok" ? "проверен" : result === "invalid" ? "проверьте ключ и права доступа" : "провайдер не подтвердил ключ";
    console.log("Ключ " + id + " · " + source + " · " + status);
  }
  if (!connected.length) console.log("Ключи · " + (defaultModel(catalog.current) ? "доступен запуск без ключа" : "подключите провайдера через vsemkod connect"));
  return Number(engine.status === "rejected" || router.status === "rejected" || connected.some(({ result }) => result === "invalid"));
}
