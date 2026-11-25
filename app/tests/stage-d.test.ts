import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTwoFilesPatch } from "diff";
import { Attachments } from "../src/main/attachments";
import { chatMarkdown } from "../src/main/chat-export";
import { sessionAccess } from "../src/main/engine/access";
import { applyFileChanges } from "../src/main/engine/revert-files";
import { migratePreferences, preferencesSchema } from "../src/main/preferences";
import { readJson, writeJson } from "../src/main/storage";
import { dequeue, enqueue, pathMentions, slashCommand, suggestionAt } from "../src/shared/workspace";
import type { FileChange } from "../src/shared/api";

const root = join(process.cwd(), ".vsemkod-dev");
const scratch = async () => { await mkdir(root, { recursive: true }); return mkdtemp(join(root, "preferences-")); };

describe("этап D", () => {
  it("сохраняет прежние настройки и добавляет значения этапа D", async () => {
    const directory = await scratch();
    const path = join(directory, "preferences.json");
    await writeJson(path, { directory: "C:/example", auto: false, clipboard: true, catalogUpdates: false });
    const migrated = migratePreferences(await readJson(path, preferencesSchema.partial()) ?? {}, directory);
    expect(migrated).toMatchObject({ directory: "C:/example", auto: false, clipboard: true, theme: "system", fontSize: "normal", defaultAccess: "ask" });
    const updated = { ...migrated, theme: "light", panelWidth: 410, keepAwake: true, busyEnter: "interrupt" };
    await writeJson(path, updated);
    expect(await readJson(path, preferencesSchema)).toEqual(updated);
  });

  it.each([
    ["read", "plan", "deny", "deny", "deny"],
    ["ask", "build", "ask", "ask", "deny"],
    ["edit", "build", "allow", "ask", "deny"],
    ["full", "build", "allow", "allow", "allow"]
  ] as const)("преобразует режим %s в правила OpenCode", (mode, agent, edit, shell, external) => {
    const access = sessionAccess(mode);
    expect(access.agent).toBe(agent);
    const effect = (action: string) => access.permissions.findLast(rule => (rule.action === "*" || rule.action === action) && rule.resource === "*")?.effect;
    expect([effect("edit"), effect("shell"), effect("external_directory")]).toEqual([edit, shell, external]);
    expect(effect("websearch")).toBe("deny");
    expect(effect("read")).toBe("allow");
    if (mode === "edit") expect(access.permissions).toContainEqual({ action: "edit", resource: "../*", effect: "deny" });
  });

  it("сохраняет порядок очереди и ставит вмешательство первым", () => {
    const original = [{ id: "a" }];
    const pending = enqueue(enqueue(original, { id: "b" }), { id: "urgent" }, true);
    expect(pending.map(item => item.id)).toEqual(["urgent", "a", "b"]);
    expect(dequeue(pending)).toEqual([{ id: "urgent" }, [{ id: "a" }, { id: "b" }]]);
    expect(dequeue([])).toEqual([undefined, []]);
    expect(original).toEqual([{ id: "a" }]);
  });

  it("разбирает slash-команды и упоминания с позициями и пробелами", () => {
    expect(slashCommand(" /review src/a.ts\nещё ")).toEqual({ name: "review", args: "src/a.ts\nещё" });
    expect(slashCommand("Проверь /compact")).toBeNull();
    expect(suggestionAt("/co", 3)).toEqual({ kind: "command", query: "co", start: 0, end: 3 });
    expect(suggestionAt('Читай @"work tree/s', 19)).toMatchObject({ kind: "path", query: "work tree/s", start: 6 });
    const text = 'Проверь @"folder name/a.ts" и @src. Mail me@example.com';
    expect(pathMentions(text).map(item => [item.path, text.slice(item.start, item.end)])).toEqual([
      ["folder name/a.ts", '@"folder name/a.ts"'], ["src", "@src"]
    ]);
  });

  it("экспортирует сообщения, вложения, дифф и уведомление в Markdown", () => {
    const change: FileChange = { file: "a.ts", patch: "+ const a = 1;", additions: 1, deletions: 0, status: "modified" };
    expect(chatMarkdown(" План\nработы ", [
      { id: "u", kind: "user", text: "Исправь код", files: ["a.ts"] },
      { id: "t", kind: "tool", tool: "edit", target: "a.ts", status: "completed", diff: change },
      { id: "n", kind: "note", text: "Контекст сжат" },
      { id: "r", kind: "reasoning", text: "Черновые рассуждения" },
      { id: "a", kind: "text", text: "Готово" }
    ])).toBe("# План работы\n\n## Вы\n\nИсправь код\n\nФайлы: a.ts\n\n## Агент\n\n**edit** a.ts\n\n```diff\n+ const a = 1;\n```\n\nКонтекст сжат\n\nГотово\n");
  });

  it("хранит изображение отдельно и проверяет поддержку ввода модели и папку", async () => {
    const directory = await scratch();
    const store = new Attachments(join(directory, "attachments"));
    const image = await store.add(directory, { name: "скриншот.png", mime: "image/png", data: Uint8Array.from([137, 80, 78, 71]) });
    expect(image.preview).toMatch(/^data:image\/png;base64,/);
    await expect(store.resolve(directory, [image.id], false)).rejects.toThrow("не принимает изображения");
    await expect(store.resolve(join(directory, "other"), [image.id], true)).rejects.toThrow("Вложение недоступно");
    const [path] = await store.resolve(directory, [image.id], true);
    expect(await readFile(path)).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it("откатывает создание файла и восстанавливает его", async () => {
    const directory = await scratch();
    const file = join(directory, "hello.txt");
    await writeFile(file, "привет\n");
    const change: FileChange = { file: "hello.txt", patch: createTwoFilesPatch("/dev/null", "hello.txt", "", "привет\n"),
      additions: 1, deletions: 0, status: "added" };
    await applyFileChanges(directory, [{ change, reverse: true }], async () => {});
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    await applyFileChanges(directory, [{ change, reverse: false }], async () => {});
    expect(await readFile(file, "utf8")).toBe("привет\n");
    await writeFile(file, "новая правка\n");
    await expect(applyFileChanges(directory, [{ change, reverse: true }], async () => {})).rejects.toThrow("Файл изменился");
    expect(await readFile(file, "utf8")).toBe("новая правка\n");
  });
});
