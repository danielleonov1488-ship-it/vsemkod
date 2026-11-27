
import { modelDisplayName } from "../shared/usage";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { version } from "../../package.json";
import { engineConfig } from "../main/engine/config";
import { personalProviders } from "../shared/providers";
import { parseCliArgs } from "./args";
import { modelList, openContext, startRouter } from "./context";
import { doctor } from "./doctor";
import { cliHome, ensureEngine } from "./engine";
import { keyVariable } from "./file-keys";
import { engineEnvironment, runEngine, serveEngine, withEngineConfig } from "./process";
import { promptKey } from "./secret";
import { clearPreviousUpdate, update } from "./update";

const help = [
  "vsemkod                                        Открыть OpenCode в терминале",
  "vsemkod run \"<задача>\" [--model <id>] [--json] [--dir <папка>]",
  "vsemkod serve|web [--port 4096] [--hostname 127.0.0.1] [--password <пароль>]",
  "vsemkod models [--all]                         Показать модели",
  "vsemkod connect <провайдер> [--url <адрес>]     Подключить ключ",
  "vsemkod connect cloudflare --account-id <id>   Подключить Cloudflare Workers AI",
  "vsemkod connect --list                         Показать провайдеров",
  "vsemkod disconnect <провайдер>                 Удалить ключ из файла",
  "vsemkod doctor                                 Проверить установку",
  "vsemkod update                                 Обновить бинарник CLI",
  "vsemkod --version                              Показать версию",
  "vsemkod help                                   Показать справку"
].join("\n");

let jsonOutput = false;

async function main() {
  const command = parseCliArgs(process.argv.slice(2));
  jsonOutput = command.name === "run" && command.json;
  await clearPreviousUpdate();
  if (command.name === "help") { console.log(help); return 0; }
  if (command.name === "version") { console.log("vsemkod " + version); return 0; }
  if (command.name === "update") { await update(version); return 0; }

  const isRun = command.name === "run";
  const directory = resolve(isRun ? command.dir ?? "." : ".");
  if (isRun && !await stat(directory).then(info => info.isDirectory(), () => false)) {
    throw new Error("Рабочая папка не найдена. Проверьте --dir.");
  }

  const data = cliHome();
  const context = await openContext(data, command.name !== "doctor" && command.name !== "disconnect");
  const { catalog, connections, keys } = context;
  if (command.name === "doctor") return doctor(data, context);

  const providers = [...catalog.current.providers, ...personalProviders, ...connections.customProviders()];
  if (command.name === "connections") {
    for (const provider of providers) {
      const anonymous = "auth" in provider && provider.auth.type === "none";
      const state = anonymous ? "без ключа" : keys.environment(provider.id) ? "ключ из окружения" :
        keys.get(provider.id) ? "подключён" : "доступно подключение";
      console.log([provider.id, provider.name, state].join(" · "));
    }
    return 0;
  }
  if (command.name === "connect" || command.name === "disconnect") {
    const id = command.provider.toLowerCase();
    const provider = providers.find(item => item.id === id);
    if (!provider) throw new Error("Провайдер не найден. См. vsemkod connect --list.");
    if (command.name === "disconnect") {
      await connections.disconnect(provider.id);
      console.log(provider.name + " · ключ удалён из файла.");
      if (keys.environment(provider.id)) console.log("Ключ из окружения активен. Уберите " + keyVariable(provider.id) + " или её стандартный аналог.");
      return 0;
    }
    if ("auth" in provider && provider.auth.type === "none") {
      console.log(provider.name + " · работает без ключа.");
      return 0;
    }
    const personal = personalProviders.find(item => item.id === provider.id);
    if (command.url && provider.id !== "custom-api") throw new Error("--url доступен для custom-api.");
    if (provider.id === "custom-api" && !command.url && !keys.profile(provider.id)) {
      throw new Error("Укажите базовый URL через --url, например https://example.com/v1.");
    }
    const endpoint = command.url ?? keys.profile(provider.id)?.baseUrl;
    const cloudflare = "auth" in provider && provider.auth.type === "cloudflare";
    if (command.accountId !== undefined && !cloudflare) throw new Error("--account-id доступен для Cloudflare Workers AI.");
    const accountId = command.accountId ?? keys.profile(provider.id)?.accountId;
    if (cloudflare && !accountId) throw new Error("Укажите Account ID через --account-id. Он указан в Workers AI → Use REST API.");
    const key = keys.environment(provider.id) ?? await promptKey();
    if (provider.id.startsWith("custom-") && provider.id !== "custom-api") {
      const profile = keys.profile(provider.id)!;
      await connections.saveCustomProvider({ id, key, ...profile, name: profile.name ?? provider.name });
    } else {
      await connections.manual(personal ?? catalog.current.providers.find(item => item.id === id)!, key,
        endpoint, AbortSignal.timeout(45_000), undefined, accountId);
      if ("auth" in provider) await connections.refreshCatalogModels(catalog.current, undefined, provider.id);
    }
    console.log(provider.name + " · ключ сохранён.");
    return 0;
  }

  await context.refreshModels();
  const effective = connections.effectiveCatalog(catalog.current);
  if (command.name === "models") {
    console.log("auto · Автовыбор (по умолчанию)");
    for (const model of modelList(effective, context, command.all)) console.log([model.id, modelDisplayName(model.name), model.detail].join(" · "));
    return 0;
  }
  const requested = isRun ? (command.model ?? "auto").replace(/^vsemkod\//, "") : "auto";
  const modelId = connections.legacyCatalogModel(catalog.current, requested) ?? requested;
  if (modelId !== "auto" && !modelList(effective, context, false).some(model => model.id === modelId)) {
    throw new Error("Модель недоступна. Проверьте id и подключения через vsemkod models.");
  }
  const executable = await ensureEngine(data);
  const { env, temporary, configDirectory } = await engineEnvironment(data);
  const router = await startRouter(data, context, effective);
  try {
    const personal = connections.personalRoutes().map(route => route.model);
    const config = engineConfig(effective, personal, router, configDirectory, () => ({ agentSteps: 0, webSearch: false, mcp: {} }));
    // Expose only connected catalog models in the engine's model picker.
    const visible = new Set(["auto", ...modelList(effective, context, false).map(model => model.id)]);
    config.providers.vsemkod.models = Object.fromEntries(Object.entries(config.providers.vsemkod.models).filter(([id]) => visible.has(id)));
    return await withEngineConfig(env, temporary, config, async () => {
      if (command.name === "serve" || command.name === "web") {
        const password = command.password ?? (process.env.OPENCODE_SERVER_PASSWORD || undefined);
        env.OPENCODE_SERVER_PASSWORD = password ?? randomBytes(24).toString("base64url");
        if (!["127.0.0.1", "localhost", "::1"].includes(command.hostname)) {
          console.error("Сервер доступен из сети. Используйте пароль и подключайтесь через SSH-туннель или HTTPS.");
        }
        if (!password) console.error("OPENCODE_SERVER_PASSWORD=" + env.OPENCODE_SERVER_PASSWORD);
        return serveEngine(executable, directory, env, command.hostname, command.port, command.name === "web");
      }
      if (command.name === "run") {
        const args = ["run", "--standalone", "--model", "vsemkod/" + modelId];
        if (command.json) args.push("--format", "json");
        return runEngine(executable, [...args, "--", command.prompt], directory, env, false);
      }
      return runEngine(executable, ["--standalone"], directory, env, true);
    });
  } finally { await router.close(); }
}

void main().then(code => { process.exitCode = code; }, (error: unknown) => {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка.";
  if (jsonOutput) console.log(JSON.stringify({ type: "error", error: { message } }));
  else console.error("vsemkod · " + message);
  process.exitCode = 1;
});
