import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worktrees, worktreeSlug } from "../src/main/worktrees";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, windowsHide: true })
  .then(result => result.stdout.trim());

describe("параллельные задачи Git", () => {
  let root: string;
  let project: string;
  let data: string;
  let worktrees: Worktrees;
  const file = "строка с пробелом.txt";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vsemkod-worktrees-"));
    project = join(root, "project");
    data = join(root, "data");
    await mkdir(project);
    worktrees = await Worktrees.load(data);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

  async function init() {
    await git(project, "init", "-b", "main");
    await git(project, "config", "user.name", "vsemkod test");
    await git(project, "config", "user.email", "test@localhost");
    await git(project, "config", "commit.gpgsign", "false");
    await git(project, "config", "core.autocrlf", "false");
    await writeFile(join(project, file), "основа\n");
    await git(project, "add", "-A");
    await git(project, "commit", "-m", "Основа");
  }

  it("создаёт две копии из HEAD и сохраняет их отдельно от правок основной папки", async () => {
    await init();
    await writeFile(join(project, "local.txt"), "локальный файл");
    const [first, second] = await Promise.all([worktrees.create(project, "Привет, мир!"), worktrees.create(project, "Привет, мир!")]);
    expect(first.warning).toContain("остались только в основной папке");
    expect(first.worktree.branch).toMatch(/^vsemkod\/privet-mir-/);
    expect(second.worktree.branch).not.toBe(first.worktree.branch);
    expect(basename(first.directory)).toBe(first.worktree.branch.slice("vsemkod/".length));
    expect(first.worktree.base).toBe(await git(project, "rev-parse", "HEAD"));
    await expect(readFile(join(first.directory, "local.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await (await Worktrees.load(data)).info(first.directory)).toEqual(first.worktree);
  }, 15_000);

  it("считает файлы без дублей, вливает копию и отдельно удаляет её", async () => {
    await init();
    const { directory, worktree } = await worktrees.create(project, "Копия");
    await writeFile(join(directory, file), "новая версия\n");
    await git(directory, "add", "-A");
    await git(directory, "commit", "-m", "Версия в копии");
    await writeFile(join(directory, file), "готовая версия\n");
    await writeFile(join(directory, "hello.txt"), "привет\n");
    expect(await worktrees.info(directory)).toMatchObject({ changed: 2, ahead: 1 });
    await expect(readFile(join(project, "hello.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(worktrees.merge(directory, "Готовая задача")).resolves.toEqual({ merged: true });
    expect(await readFile(join(project, "hello.txt"), "utf8")).toBe("привет\n");
    expect(await git(project, "rev-list", "--parents", "-1", "HEAD")).toMatch(/^[a-f0-9]+ [a-f0-9]+ [a-f0-9]+$/);
    expect(await worktrees.info(directory)).toMatchObject({ changed: 0, ahead: 2 });
    await expect(worktrees.remove(directory, () => true)).rejects.toThrow("Сначала остановите агента");
    await worktrees.remove(directory);
    expect(await git(project, "branch", "--list", worktree.branch)).toBe("");
    expect(await worktrees.info(directory)).toBeNull();
    expect(JSON.parse(await readFile(join(data, "worktrees.json"), "utf8"))).toEqual([]);
    await expect(worktrees.use(directory, async () => "запуск")).rejects.toThrow("только для чтения");
  }, 20_000);

  it("отказывается вливать грязный проект и откатывает конфликт без потери коммита копии", async () => {
    await init();
    const { directory } = await worktrees.create(project, "Конфликт");
    await writeFile(join(directory, file), "из копии\n");
    await writeFile(join(project, file), "из основной папки\n");
    await expect(worktrees.merge(directory, "Задача")).rejects.toThrow("изменения в основной папке");
    expect(await worktrees.info(directory)).toMatchObject({ changed: 1, ahead: 1 });
    await git(project, "add", "-A");
    await git(project, "commit", "-m", "Версия из основной папки");
    const before = await git(project, "rev-parse", "HEAD");
    await expect(worktrees.merge(directory, "Задача")).resolves.toMatchObject({
      merged: false, conflicts: [file], baseBranch: "main"
    });
    expect(await git(project, "status", "--porcelain")).toBe("");
    expect(await git(project, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(project, file), "utf8")).toBe("из основной папки\n");
    expect(await readFile(join(directory, file), "utf8")).toBe("из копии\n");
  }, 20_000);

  it("открывает пропавшую копию только для чтения", async () => {
    await init();
    const { directory } = await worktrees.create(project, "Пропала");
    await rename(directory, join(root, "moved"));
    expect(await worktrees.info(directory)).toBeNull();
    await expect(worktrees.use(directory, async () => "запуск")).rejects.toThrow("только для чтения");
    await worktrees.remove(directory);
    expect(worktrees.known(directory)).toBe(false);
  }, 15_000);

  it("возвращает not-a-repo и инициализирует историю один раз", async () => {
    await expect(worktrees.create(project, "Новая задача")).rejects.toMatchObject({ code: "not-a-repo" });
    await writeFile(join(project, "readme.txt"), "Проект");
    await worktrees.initGit(project);
    expect(await git(project, "log", "-1", "--format=%s")).toBe("Начало");
    await worktrees.initGit(project);
    expect(await git(project, "rev-list", "--count", "HEAD")).toBe("1");
  }, 15_000);

  it("транслитерирует кириллицу и ограничивает длину slug", () => {
    expect(worktreeSlug("Ёж, съешь ещё щей!")).toBe("yozh-sesh-eshchyo-shchey");
    expect(worktreeSlug("🟢")).toBe("task");
    expect(worktreeSlug("Б".repeat(70))).toBe("b".repeat(40));
  });
});
