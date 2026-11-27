
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args";
import { verifySha256 } from "../src/cli/download";
import { cliHome, engineManifest, enginePath, engineVersion, ensureEngine } from "../src/cli/engine";
import { FileKeys } from "../src/cli/file-keys";
import { sessionAccess } from "../src/main/engine/access";
import { engineConfig } from "../src/main/engine/config";
import { EngineService } from "../src/main/engine/service";
import type { Router } from "../src/main/router";
import type { Catalog } from "../src/shared/catalog-schema";
import type { PersonalModel } from "../src/shared/providers";

describe("аргументы CLI", () => {
  it("различает TUI, запуск, сервер и список подключений", () => {
    expect(parseCliArgs([])).toEqual({ name: "tui" });
    expect(parseCliArgs(["run", "--json", "--dir", "мой проект", "--model=auto", "--", "-проверка"])).toEqual({
      name: "run", json: true, dir: "мой проект", model: "auto", prompt: "-проверка"
    });
    expect(parseCliArgs(["serve"])).toMatchObject({ port: 4096, hostname: "127.0.0.1" });
    expect(parseCliArgs(["web", "--port", "0", "--hostname", "0.0.0.0", "--password", "test"])).toEqual({
      name: "web", port: 0, hostname: "0.0.0.0", password: "test"
    });
    expect(parseCliArgs(["connect", "--list"])).toEqual({ name: "connections" });
    expect(parseCliArgs(["connect", "custom-api", "--url", "http://localhost:8000/v1"])).toMatchObject({
      name: "connect", provider: "custom-api", url: "http://localhost:8000/v1"
    });
    expect(parseCliArgs(["models", "--all"])).toEqual({ name: "models", all: true });
  });

  it.each([["run"], ["run", "--json", ""], ["serve", "--port", "65536"], ["web", "--password="], ["connect", "--list", "groq"], ["models", "--json"]])(
    "отклоняет неверные аргументы %j",
    (...args) => expect(() => parseCliArgs(args)).toThrow("Неверные аргументы")
  );
});

describe("профиль и движок CLI", () => {
  let data: string;
  beforeEach(async () => { data = await mkdtemp(join(tmpdir(), "vsemkod-cli-test-")); });
  afterEach(async () => { await rm(data, { force: true, recursive: true }); });

  it("сохраняет профиль, использует окружение первым и защищает файл", async () => {
    const path = join(data, "keys.json");
    const store = new FileKeys(path, {});
    await store.load();
    await Promise.all([store.set("numes", "stored"), store.set("kimi-code", "kimi", {
      baseUrl: "https://example.com/v1", models: [{ id: "kimi", name: "Kimi" }]
    })]);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const reopened = new FileKeys(path, {
      VSEMKOD_NUMES_KEY: "env-numes", VSEMKOD_KIMI_CODE_KEY: "env-kimi", OPENROUTER_API_KEY: "env-or", GROQ_API_KEY: "env-groq"
    });
    await reopened.load();
    expect(reopened.get("numes")).toBe("env-numes");
    expect(reopened.get("kimi-code")).toBe("env-kimi");
    expect(reopened.get("openrouter")).toBe("env-or");
    expect(reopened.get("groq")).toBe("env-groq");
    expect(reopened.profile("kimi-code")?.models[0].id).toBe("kimi");
    await reopened.remove("numes");
    expect(reopened.get("numes")).toBe("env-numes");
    expect(reopened.ids()).toEqual(["kimi-code"]);
    expect(await readFile(path, "utf8")).not.toContain("env-");
  });

  it("выбирает профиль, версию, платформу и переопределение пути", async () => {
    expect(cliHome({ VSEMKOD_HOME: "test" }, "win32", data)).toBe(resolve("test"));
    expect(cliHome({ LOCALAPPDATA: data }, "win32", "unused")).toBe(join(data, "vsemkod-cli"));
    expect(cliHome({}, "linux", data)).toBe(join(data, ".vsemkod"));
    expect(enginePath(data, {}, "win32", "x64")).toBe(join(data, "engine", engineVersion, "win32-x64", "opencode.exe"));
    expect(enginePath(data, {}, "linux", "arm64")).toBe(join(data, "engine", engineVersion, "linux-arm64", "opencode"));
    expect(await ensureEngine(data, { VSEMKOD_ENGINE: process.execPath })).toBe(process.execPath);
    await expect(ensureEngine(data, { VSEMKOD_ENGINE: join(data, "missing") })).rejects.toThrow("VSEMKOD_ENGINE");
  });

  it("сверяет SHA-256 и отклоняет подменённый файл", async () => {
    const binary = join(data, "engine");
    const bytes = "fake engine file";
    await writeFile(binary, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    await expect(verifySha256(binary, expected)).resolves.toBeUndefined();
    await writeFile(binary, bytes + " modified");
    await expect(verifySha256(binary, expected)).rejects.toThrow("SHA-256");
  });

  it("совпадает с версией и SHA-256 ресурсов desktop", async () => {
    const source = await readFile(new URL("../scripts/fetch-engine.mjs", import.meta.url), "utf8");
    expect(source).toContain('const version = "' + engineVersion + '";');
    for (const [target, asset] of Object.entries(engineManifest)) {
      expect(source).toContain(JSON.stringify(target) + ": [" + asset.map(value => JSON.stringify(value)).join(", ") + "]");
    }
  });
});

it("общий конфиг сохраняет настройки EngineService", () => {
  const catalog: Catalog = {
    schemaVersion: 1, generatedAt: "2026-10-01T10:00:00.000Z", providers: [], offers: [], candidates: [],
    models: [{ id: "vision", vendor: "Example", name: "Vision", tier: "top", description: "Example", rank: 1,
      contextWindow: 24_000, capabilities: ["tools", "vision"] }]
  };
  const personal: PersonalModel[] = [{ id: "groq-api:demo", providerId: "groq-api", providerName: "Groq", name: "Demo" }];
  const router = { baseUrl: "http://127.0.0.1:5555/v1", token: "test-token" };
  const data = resolve("cli-test");
  const settings = () => ({ agentSteps: 16, webSearch: true, mcp: { sample: { enabled: false } } });
  const service = new EngineService("unused", data, () => catalog, router as Router, () => {}, () => personal, settings);
  const desktop = service as unknown as { config(catalog: Catalog, personal: PersonalModel[]): ReturnType<typeof engineConfig> };
  const config = desktop.config(catalog, personal);
  expect(config).toEqual(engineConfig(catalog, personal, router, service.configDirectory, settings, process.env.ENABLE_OPENCODE_ZEN_FREE === "true"));
  expect(config).toEqual({
    model: "vsemkod/auto", update: "disable", share: "disabled", formatter: false, lsp: false, snapshots: true,
    instructions: ["AGENTS.md"], skills: [join(data, "config", "opencode", "skills"), ".opencode/skills"],
    todo: true, websearch: { provider: "tinyfish" }, compaction: { auto: true }, policies: [], mcp: settings().mcp,
    permissions: sessionAccess("ask").permissions,
    agents: { build: { steps: 16 }, plan: { steps: 16, permissions: sessionAccess("read").permissions }, general: { steps: 16 }, title: { disabled: true } },
    plugins: [
      "-opencode.provider.kilo", "-opencode.provider.claude-agent", "-opencode.config.compatibility", "-opencode.skill", "-opencode.browser",
      ...(process.env.ENABLE_OPENCODE_ZEN_FREE === "true" ? [] : ["-opencode.provider.opencode"])
    ],
    providers: { vsemkod: {
      name: "vsemkod", package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: router.baseUrl, apiKey: router.token },
      models: {
        auto: { name: "Автовыбор", limit: { context: 24_000, output: 8192 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
        relay: { name: "vsemkod", limit: { context: 32_768, output: 8192 }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] } },
        vision: { name: "Vision", limit: { context: 24_000, output: 6000 }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] } },
        "groq-api:demo": { name: "Demo", limit: { context: 32_768, output: 8192 }, capabilities: { tools: true, input: ["text"], output: ["text"] } }
      }
    } }
  });
});
