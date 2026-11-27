import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SkillEntry } from "../shared/api";
import { readJson } from "./storage";

export const skillId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const indexSchema = z.array(z.object({
  id: skillId, name: z.string().min(1), description: z.string().min(1),
  category: z.enum(["design", "code", "docs", "process"]),
  source: z.url({ protocol: /^https$/ }), license: z.enum(["MIT", "Apache-2.0"])
})).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length);

const provenance = ".vsemkod-catalog";
async function fileInfo(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(folder: string, prefix = "") {
    const names = (await readdir(folder)).sort();
    for (const name of names) {
      if (!prefix && name === provenance) continue;
      const path = join(folder, name);
      const relative = prefix + name;
      const info = await lstat(path);
      if (info.isDirectory()) {
        hash.update(JSON.stringify(["directory", relative]) + "\n");
        await visit(path, relative + "/");
      } else if (info.isFile()) {
        const contents = createHash("sha256").update(await readFile(path)).digest("hex");
        hash.update(JSON.stringify(["file", relative, contents]) + "\n");
      } else throw new Error("Папка навыка содержит ссылку или специальный файл.");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export class SkillsCatalog {
  private queue = Promise.resolve<unknown>(undefined);

  constructor(private readonly source: string, private readonly configDirectory: string) {}

  async list(): Promise<SkillEntry[]> {
    const entries = await readJson(join(this.source, "index.json"), indexSchema) ?? [];
    return Promise.all(entries.map(async entry => {
      const directory = join(this.configDirectory, "skills", entry.id);
      const installed = !!(await fileInfo(directory))?.isDirectory() &&
        !!(await fileInfo(join(directory, "SKILL.md")))?.isFile();
      return { ...entry, installed };
    }));
  }

  install(id: string): Promise<SkillEntry[]> {
    return this.change(id, async destination => {
      if (await fileInfo(destination)) {
        if (await this.unchanged(destination)) return;
        throw new Error("В этой папке уже есть пользовательский или изменённый навык.");
      }
      await mkdir(join(this.configDirectory, "skills"), { recursive: true });
      const staging = await mkdtemp(join(this.configDirectory, ".catalog-skill-"));
      const copy = join(staging, id);
      try {
        await cp(join(this.source, id), copy, { recursive: true, errorOnExist: true, force: false });
        if (!(await fileInfo(join(copy, "SKILL.md")))?.isFile()) throw new Error("В каталоге отсутствует файл навыка.");
        await writeFile(join(copy, provenance), await fingerprint(copy), { flag: "wx" });
        if (await fileInfo(destination)) throw new Error("В этой папке уже есть навык.");
        await rename(copy, destination);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  remove(id: string): Promise<SkillEntry[]> {
    return this.change(id, async destination => {
      if (!await fileInfo(destination)) return;
      if (!await this.unchanged(destination)) throw new Error("Папка содержит пользовательский или изменённый навык.");
      await rm(destination, { recursive: true });
    });
  }

  private async unchanged(directory: string): Promise<boolean> {
    if (!(await fileInfo(directory))?.isDirectory()) return false;
    const marker = join(directory, provenance);
    if (!(await fileInfo(marker))?.isFile()) return false;
    const expected = await readFile(marker, "utf8");
    return /^[a-f0-9]{64}$/.test(expected) && expected === await fingerprint(directory);
  }

  private change(id: string, action: (path: string) => Promise<void>) {
    const operation = this.queue.then(async () => {
      if (!(await this.list()).some(entry => entry.id === id)) throw new Error("Навык не найден в каталоге.");
      const skills = join(this.configDirectory, "skills");
      const info = await fileInfo(skills);
      if (info && !info.isDirectory()) throw new Error("Папка навыков недоступна.");
      await action(join(skills, id));
      return this.list();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
