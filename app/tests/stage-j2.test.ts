import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connectors, connectorCatalogSchema } from "../src/main/connectors";
import { KeyStore } from "../src/main/key-store";
import { SkillsCatalog } from "../src/main/skills-catalog";

vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "test",
  encryptString: (value: string) => Buffer.from(value.split("").reverse().join("")),
  decryptString: (value: Buffer) => value.toString().split("").reverse().join("")
} }));

const resources = resolve("resources");
const catalogPath = join(resources, "connectors.json");
const skillPath = join(resources, "skills-catalog");
const catalog = connectorCatalogSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "vsemkod-j2-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("каталог коннекторов", () => {
  it("проверяет HTTPS, уникальность имён и закреплённые версии", () => {
    const remotes = catalog.filter(entry => entry.transport === "remote");
    const locals = catalog.filter(entry => entry.transport === "local");
    expect(remotes.length).toBeGreaterThan(0);
    expect(locals.length).toBeGreaterThan(0);
    expect(remotes.every(entry => new URL(entry.url).protocol === "https:")).toBe(true);
    expect(locals.every(entry => /@\d+\.\d+\.\d+/.test(entry.command) && !entry.command.includes("@latest"))).toBe(true);
    expect(connectorCatalogSchema.safeParse([catalog[0], catalog[0]]).success).toBe(false);
    expect(connectorCatalogSchema.safeParse([{ ...remotes[0], url: "http://example.com" }]).success).toBe(false);
    expect(connectorCatalogSchema.safeParse([{ ...locals[0], command: "npx -y some-package@latest" }]).success).toBe(false);
  });

  it("пишет remote, local и key через то же хранилище MCP", async () => {
    const keysFile = join(directory, "keys.json");
    const mcpFile = join(directory, "mcp.json");
    const keys = new KeyStore(keysFile);
    const connectors = new Connectors(catalog, mcpFile, keys, {}, async () => true, "linux");
    await expect(connectors.install("github")).rejects.toThrow("Вставьте ключ");
    await connectors.install("context7");
    await connectors.install("memory");
    await connectors.install("github", "fake-github-test-key");
    const disk = await readFile(mcpFile, "utf8");
    expect(disk).not.toContain("fake-github-test-key");
    expect(JSON.parse(disk)).toEqual({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
      memory: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-memory@2.2.2"] },
      github: { type: "remote", url: "https://api.githubcopilot.com/mcp/" }
    });
    expect(JSON.parse(await readFile(keysFile, "utf8"))["mcp:github"]).toBeTruthy();
    expect(await readFile(keysFile, "utf8")).not.toContain("fake-github-test-key");
    const restoredKeys = new KeyStore(keysFile);
    await restoredKeys.load();
    expect(restoredKeys.ids()).toEqual([]);
    const restored = await Connectors.load(catalogPath, mcpFile, restoredKeys);
    expect(restored.engineConfig("github")).toMatchObject({ headers: { Authorization: "Bearer fake-github-test-key" } });
    await restored.change("github", "put", { type: "remote", url: "https://other.example/mcp" });
    expect(restored.engineConfig("github")).not.toHaveProperty("headers");
    await restored.change("github", "delete");
    await restored.clearKey("github");
    expect(restoredKeys.get("mcp:github")).toBeUndefined();
  });

  it("показывает требования и состояния и проверяет их при установке", async () => {
    const keys = new KeyStore(join(directory, "keys.json"));
    const connectors = new Connectors(catalog, join(directory, "mcp.json"), keys, {}, async () => false, "win32");
    await expect(connectors.install("playwright")).rejects.toThrow("Нужен Node.js");
    const available = new Connectors(catalog, join(directory, "mcp.json"), keys, {}, async dependency => dependency === "node", "win32");
    await expect(available.install("chrome-devtools")).rejects.toThrow("Нужен Google Chrome");
    await available.install("playwright");
    expect(available.get("playwright")).toMatchObject({ command: ["cmd.exe", "/d", "/c", "npx", "-y", expect.stringMatching(/^@playwright\/mcp@\d/)] });
    const entries = await available.list([{ name: "playwright", managed: true, status: "failed", error: "test error" }]);
    expect(entries.find(entry => entry.id === "playwright")).toMatchObject({ installed: true, status: "failed", error: "test error" });
    expect(entries.find(entry => entry.id === "chrome-devtools")).toMatchObject({ installed: false, missing: ["chrome"] });
  });

  it("восстанавливает ключ после ошибки записи MCP", async () => {
    const keys = new KeyStore(join(directory, "keys.json"));
    const brokenPath = join(directory, "not-a-directory");
    await writeFile(brokenPath, "test");
    const connectors = new Connectors(catalog, join(brokenPath, "mcp.json"), keys, {});
    await keys.set("mcp:github", "old-key");
    await expect(connectors.install("github", "new-key")).rejects.toThrow();
    expect(keys.get("mcp:github")).toBe("old-key");
    expect(connectors.get("github")).toBeUndefined();
  });
});

describe("каталог навыков", () => {
  const id = "frontend-design";
  it("сохраняет каждый лицензированный навык с отдельной лицензией", async () => {
    const skills = new SkillsCatalog(skillPath, directory);
    const entries = await skills.list();
    expect(entries.map(entry => entry.id)).toContain(id);
    for (const entry of entries) {
      expect(await readFile(join(skillPath, entry.id, "SKILL.md"), "utf8")).toContain("name:");
      expect(await readFile(join(skillPath, entry.id, "LICENSE"), "utf8")).toContain(entry.license === "MIT" ? "MIT License" : "Apache License");
    }
  });

  it("копирует всю папку, поддерживает повторную установку и удаляет свою копию", async () => {
    const skills = new SkillsCatalog(skillPath, directory);
    const destination = join(directory, "skills", id);
    await Promise.all([skills.install(id), skills.install(id)]);
    expect(await readFile(join(destination, "SKILL.md"))).toEqual(await readFile(join(skillPath, id, "SKILL.md")));
    expect(await readFile(join(destination, "LICENSE"))).toEqual(await readFile(join(skillPath, id, "LICENSE")));
    expect((await skills.list()).find(entry => entry.id === id)?.installed).toBe(true);
    expect((await skills.remove(id)).find(entry => entry.id === id)?.installed).toBe(false);
    await expect(readFile(join(destination, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("сохраняет пользовательскую папку и защищает изменённую копию", async () => {
    const skills = new SkillsCatalog(skillPath, directory);
    const destination = join(directory, "skills", id, "SKILL.md");
    await skills.install(id);
    await writeFile(destination, "Пользовательские инструкции");
    await expect(skills.install(id)).rejects.toThrow("изменённый навык");
    await expect(skills.remove(id)).rejects.toThrow("изменённый навык");
    expect(await readFile(destination, "utf8")).toBe("Пользовательские инструкции");

    const manualId = "verification-before-completion";
    const manual = join(directory, "skills", manualId);
    await mkdir(manual);
    await copyFile(join(skillPath, manualId, "SKILL.md"), join(manual, "SKILL.md"));
    expect((await skills.list()).find(entry => entry.id === manualId)?.installed).toBe(true);
    await expect(skills.remove(manualId)).rejects.toThrow("пользовательский");
    await expect(skills.install("../unsafe")).rejects.toThrow("не найден");
  });
});
