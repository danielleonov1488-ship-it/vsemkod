import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Conversation, Worktree, WorktreeMerge } from "../shared/api";
import { readJson, writeJson } from "./storage";

const exec = promisify(execFile);
const notARepo = "Папка проекта ещё не является Git-репозиторием.";
const missingCopy = "Папка копии недоступна. Чат открыт только для чтения.";
const localPath = z.string().min(1).max(32_768).refine(isAbsolute);
const record = z.object({
  path: localPath, origin: localPath, branch: z.string().regex(/^vsemkod\/[a-z0-9-]{1,40}$/), base: z.string().regex(/^[a-f0-9]{40,64}$/)
});
type Entry = z.infer<typeof record>;
type CreateResult = { directory: string; worktree: Worktree; warning?: string };
type MergeResult = WorktreeMerge & { baseBranch?: string };

async function git(cwd: string, ...args: string[]) {
  return gitWith(cwd, {}, ...args);
}

/** Коммит без настроенного в git имени падает: подставляем «vsemkod», только если имени и почты нет. */
async function identity(cwd: string): Promise<Record<string, string>> {
  const read = (key: string) => git(cwd, "config", "--get", key).then(value => value.trim()).catch(() => "");
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  if (name && email) return {};
  return { GIT_AUTHOR_NAME: name || "vsemkod", GIT_AUTHOR_EMAIL: email || "vsemkod@localhost",
    GIT_COMMITTER_NAME: name || "vsemkod", GIT_COMMITTER_EMAIL: email || "vsemkod@localhost" };
}

async function gitWith(cwd: string, extra: Record<string, string>, ...args: string[]) {
  try {
    return (await exec("git", args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...extra } })).stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT" && failure.syscall === "spawn git" && statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("Для параллельных задач нужен Git: git-scm.com/downloads");
    }
    throw error;
  }
}

function gitError(error: unknown) {
  const { stderr } = error as { stderr?: string };
  return new Error(stderr?.trim() || (error as Error).message);
}

const cyrillic = [..."абвгдеёжзийклмнопрстуфхцчшщъыьэюя"];
const latin = ["a", "b", "v", "g", "d", "e", "yo", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r",
  "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"];
export function worktreeSlug(title: string) {
  return title.normalize("NFC").toLowerCase().replace(/[а-яё]/g, letter => latin[cyrillic.indexOf(letter)])
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "") || "task";
}

function pathKey(path: string) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

const names = (output: string) => output.split("\0").filter(Boolean);
const status = (path: string) => git(path, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all");
const revision = (path: string) => git(path, "rev-parse", "HEAD").then(out => out.trim());

async function repoRoot(path: string) {
  try { return await realpath((await git(path, "rev-parse", "--show-toplevel")).trimEnd()); }
  catch (error) {
    if ((error as { stderr?: string }).stderr?.includes("not a git repository")) return null;
    throw gitError(error);
  }
}

async function hasBranch(path: string, branch: string) {
  try { await git(path, "show-ref", "--verify", "--quiet", "refs/heads/" + branch); return true; }
  catch (error) {
    if ((error as { code: unknown }).code === 1) return false;
    throw gitError(error);
  }
}

export class Worktrees {
  private readonly root: string;
  private readonly index: string;
  private readonly entries = new Map<string, Entry>();
  private readonly inUse = new Map<string, number>();
  private readonly editing = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(data: string) {
    this.root = join(data, "worktrees");
    this.index = join(data, "worktrees.json");
  }

  static async load(data: string) {
    const worktrees = new Worktrees(data);
    for (const entry of await readJson(worktrees.index, z.array(record)) ?? []) {
      if (worktrees.managed(entry.path)) worktrees.entries.set(pathKey(entry.path), entry);
    }
    return worktrees;
  }

  managed(path: string) {
    const root = pathKey(this.root);
    const key = pathKey(path);
    return key === root || key.startsWith(root + sep);
  }

  known(path: string) {
    return this.entries.has(pathKey(path));
  }

  label(path: string): Conversation["worktree"] {
    const entry = this.entries.get(pathKey(path));
    if (entry) return { origin: entry.origin, branch: entry.branch };
  }

  projectChat(chat: Conversation) {
    const worktree = chat.worktree ?? this.label(chat.directory);
    return worktree ? { ...chat, worktree } : chat;
  }

  private write<T>(run: () => Promise<T>) {
    const pending = this.writes.then(run);
    this.writes = pending.catch(() => {});
    return pending;
  }

  private async projectRoot(path: string) {
    const root = await repoRoot(path);
    if (root && pathKey(root) !== pathKey(path)) throw new Error("Выберите корневую папку Git-репозитория: " + root);
    return root;
  }

  initGit(origin: string) {
    return this.write(async () => {
      try {
        if (!(await this.projectRoot(origin))) await git(origin, "init");
        // Повторный вызов не создаёт коммит поверх существующей истории.
        if (await revision(origin).catch(() => undefined)) return;
        for (const [key, fallback] of [["user.name", "vsemkod"], ["user.email", "vsemkod@localhost"]]) {
          const value = await git(origin, "config", "--get", key).catch(error => {
            if ((error as { code: unknown }).code === 1) return "";
            throw error;
          });
          if (!value.trim()) await git(origin, "config", "--local", key, fallback);
        }
        await git(origin, "add", "-A");
        await git(origin, "commit", "--allow-empty", "-m", "Начало");
      } catch (error) { throw gitError(error); }
    });
  }

  create(origin: string, title: string): Promise<CreateResult> {
    return this.write(async () => {
      if (!(await this.projectRoot(origin))) throw Object.assign(new Error(notARepo), { code: "not-a-repo" });
      try {
        const base = await revision(origin).catch(error => {
          if ((error as { stderr?: string }).stderr?.includes("ambiguous argument 'HEAD'")) {
            throw new Error("Сначала создайте первый коммит в проекте.");
          }
          throw error;
        });
        const warning = await status(origin)
          ? "Копия создана из последнего коммита — несохранённые в git правки остались только в основной папке"
          : undefined;
        const parent = join(this.root, createHash("sha1").update(origin).digest("hex").slice(0, 8));
        await mkdir(parent, { recursive: true });
        const prefix = worktreeSlug(title).slice(0, 31).replace(/-$/, "");
        let entry: Entry;
        do {
          // Суффикс не даёт новому чату занять путь копии, чей чат сохранился в истории.
          const slug = prefix + "-" + randomUUID().slice(0, 8);
          entry = { path: join(parent, slug), origin, branch: "vsemkod/" + slug, base };
        } while (statSync(entry.path, { throwIfNoEntry: false }) || await hasBranch(origin, entry.branch));
        await git(origin, "worktree", "add", "-b", entry.branch, entry.path, base);
        try { await writeJson(this.index, [...this.entries.values(), entry]); }
        catch (error) {
          await git(origin, "worktree", "remove", "--force", entry.path);
          await git(origin, "branch", "-D", entry.branch);
          throw error;
        }
        this.entries.set(pathKey(entry.path), entry);
        return { directory: entry.path, worktree: { ...entry, changed: 0, ahead: 0 }, warning };
      } catch (error) { throw gitError(error); }
    });
  }

  private async attached(entry: Entry) {
    if (!statSync(entry.path, { throwIfNoEntry: false })?.isDirectory()) return false;
    const root = await repoRoot(entry.path);
    if (!root || pathKey(root) !== pathKey(entry.path)) return false;
    return (await git(entry.path, "symbolic-ref", "-q", "HEAD").catch(() => "")).trim() === "refs/heads/" + entry.branch;
  }

  async info(directory: string): Promise<Worktree | null> {
    const entry = this.entries.get(pathKey(directory));
    if (!entry || !(await this.attached(entry))) return null;
    const { path, branch, base, origin } = entry;
    const head = await revision(origin).catch(() => undefined);
    const [uncommitted, ahead, shared] = await Promise.all([
      status(path),
      git(path, "rev-list", "--count", base + ".." + branch),
      head ? git(path, "merge-base", head, branch).then(out => out.trim()).catch(() => base) : base
    ]);
    // Общий коммит после слияния учитывает уже влитые файлы. При смене основной ветки остаётся исходная база.
    const common = shared === base || (await git(path, "merge-base", base, shared)).trim() === base ? shared : base;
    const committed = await git(path, "diff", "--name-only", "-z", common + "..." + branch, "--");
    const files = new Set([...names(uncommitted).map(line => line.slice(3)), ...names(committed)]);
    return { ...entry, changed: files.size, ahead: Number(ahead.trim()) };
  }

  async use<T>(directory: string, run: () => Promise<T>): Promise<T> {
    if (!this.managed(directory)) return run();
    const key = pathKey(directory);
    if (this.editing.has(key)) throw new Error("Подождите, пока завершится операция с копией.");
    const entry = this.entries.get(key);
    if (!entry) throw new Error(missingCopy);
    this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
    try {
      if (!(await this.attached(entry))) throw new Error(missingCopy);
      return await run();
    } finally {
      const count = this.inUse.get(key)!;
      if (count === 1) this.inUse.delete(key);
      else this.inUse.set(key, count - 1);
    }
  }

  private change<T>(directory: string, busy: () => boolean, run: (entry: Entry) => Promise<T>) {
    return this.write(async () => {
      const key = pathKey(directory);
      const entry = this.entries.get(key);
      if (!entry) throw new Error(missingCopy);
      if (this.inUse.has(key) || busy()) throw new Error("Сначала остановите агента в этой копии.");
      this.editing.add(key);
      try { return await run(entry); }
      catch (error) { throw gitError(error); }
      finally { this.editing.delete(key); }
    });
  }

  merge(directory: string, message: string, busy = () => false): Promise<MergeResult> {
    return this.change(directory, busy, async entry => {
      const { path, origin, branch } = entry;
      if (!(await this.attached(entry))) throw new Error(missingCopy);
      if (await status(path)) {
        await git(path, "add", "-A");
        if (await status(path)) await gitWith(path, await identity(path), "commit", "-m", message);
      }
      if (await status(origin)) throw new Error("Сначала сохраните или отмените изменения в основной папке");
      const current = (await git(origin, "branch", "--show-current")).trim();
      const baseBranch = /^[a-z\d_][\w./-]*$/i.test(current) ? current : await revision(origin);
      try { await gitWith(origin, await identity(origin), "merge", "--no-ff", "-m", message, "--", branch); }
      catch (error) {
        const conflicts = names(await git(origin, "diff", "--name-only", "--diff-filter=U", "-z"));
        if (!conflicts.length) throw error;
        await git(origin, "merge", "--abort");
        return { merged: false, conflicts, baseBranch, message: "Не удалось влить копию из-за конфликтов в файлах: " + conflicts.join(", ") };
      }
      return { merged: true };
    });
  }

  remove(directory: string, busy = () => false) {
    return this.change(directory, busy, async entry => {
      const { path, origin, branch } = entry;
      const list = names(await git(origin, "worktree", "list", "--porcelain", "-z"));
      if (list.some(line => line.startsWith("worktree ") && pathKey(line.slice(9)) === pathKey(path))) {
        await git(origin, "worktree", "remove", "--force", path);
      }
      if (await hasBranch(origin, branch)) await git(origin, "branch", "-D", branch);
      await writeJson(this.index, [...this.entries.values()].filter(item => item !== entry));
      this.entries.delete(pathKey(path));
    });
  }
}

type Register = <A extends z.ZodType, R>(name: string, schema: A, run: (args: z.output<A>) => R) => void;

export function registerWorktreeIpc(handle: Register, worktrees: Worktrees, project: (origin: string) => string, busy: (path: string) => boolean) {
  const originProject = (origin: string) => {
    if (worktrees.managed(origin)) throw new Error("Выберите основную папку проекта.");
    return project(origin);
  };
  handle("worktree:create", z.tuple([localPath, z.string().trim().min(1).max(120)]), async ([origin, title]) => {
    try { return await worktrees.create(originProject(origin), title); }
    catch (error) {
      // Electron передаёт сообщение ошибки без дополнительных полей.
      if ((error as { code?: string }).code === "not-a-repo") throw new Error("not-a-repo: " + notARepo);
      throw error;
    }
  });
  handle("worktree:init-git", z.tuple([localPath]), ([origin]) => worktrees.initGit(originProject(origin)));
  handle("worktree:info", z.tuple([localPath]), ([directory]) => worktrees.info(directory));
  handle("worktree:merge", z.tuple([localPath, z.string().trim().min(1).max(512)]),
    ([directory, message]) => worktrees.merge(directory, message, () => busy(directory)));
  handle("worktree:remove", z.tuple([localPath]), ([directory]) => worktrees.remove(directory, () => busy(directory)));
}
