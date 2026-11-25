import { lstat, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyPatch, parsePatch, reversePatch } from "diff";
import type { FileChange } from "../../shared/api";
import { inside } from "./diff-tracker";

export async function projectPath(directory: string, path: string) {
  const target = await realpath(resolve(directory, path));
  if (!inside(directory, target)) throw new Error("Путь находится за пределами проекта.");
  return target;
}

export async function applyFileChanges(
  directory: string, operations: { change: FileChange; reverse: boolean }[], after: () => Promise<void>
) {
  const edits = new Map<string, { before: string | null; next: string | null }>();
  for (const { change, reverse } of operations) {
    const path = resolve(directory, change.file);
    if (!inside(directory, path) || path === directory) throw new Error("Путь находится за пределами проекта.");
    await projectPath(directory, dirname(path));
    const present = await lstat(path).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (present && (!present.isFile() || present.isSymbolicLink() || present.size > 2 * 1024 * 1024)) {
      throw new Error("Невозможно восстановить изменённый файл: " + change.file);
    }
    const previous = edits.get(path);
    const before = previous ? previous.before : present ? await readFile(path, "utf8") : null;
    const current = previous ? previous.next : before;
    const creates = reverse ? change.status === "deleted" : change.status === "added";
    const removes = reverse ? change.status === "added" : change.status === "deleted";
    const updated = creates !== (current === null) ? false :
      applyPatch(current ?? "", reverse ? reversePatch(parsePatch(change.patch)[0]) : change.patch);
    if (updated === false || (removes && updated !== "")) {
      throw new Error("Файл изменился после ответа агента: " + change.file);
    }
    edits.set(path, { before, next: removes ? null : updated });
  }
  const set = async (path: string, value: string | null) => {
    if (value === null) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    else await writeFile(path, value);
  };
  const applied: [string, string | null][] = [];
  try {
    for (const [path, { before, next }] of edits) {
      const latest = await readFile(path, "utf8").catch(error => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (latest !== before) throw new Error("Файл изменился во время отката.");
      applied.push([path, before]);
      await set(path, next);
    }
    await after();
  } catch (error) {
    for (const [path, before] of applied.reverse()) await set(path, before).catch(() => {});
    throw error;
  }
}
