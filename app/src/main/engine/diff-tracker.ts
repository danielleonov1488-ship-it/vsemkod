import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch, diffLines } from "diff";
import type { FileChange } from "../../shared/api";

const maxBytes = 256 * 1024;
export const fileTools = new Set(["write", "edit", "patch", "apply_patch", "multiedit"]);

export function inside(root: string, path: string): boolean {
  const local = relative(root, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(".." + sep);
}

type TrackedFile = { path: string; value?: string | null; stamp?: string };

export class DiffTracker {
  private before = new Map<string, TrackedFile[]>();
  private changes = new Map<string, FileChange>();
  private otherChanges = new Map<string, FileChange>();

  constructor(private readonly directory: string) {}

  async capture(id: string, targets: string[]) {
    if (!targets.length) return;
    const files = await Promise.all(targets.map(target => this.read(target)));
    const captured = this.before.get(id) ?? [];
    const entries = new Map(files.flatMap(file => file ? [[resolve(this.directory, file.path), file] as const] : []));
    for (const file of captured) entries.set(resolve(this.directory, file.path), file);
    this.before.set(id, [...entries.values()]);
  }

  async finish(id: string, target: string, output?: string): Promise<FileChange[]> {
    const files = this.before.get(id) ?? [];
    if (!files.length && target && output?.startsWith("Created file successfully:")) files.push({ path: target, value: null });
    const completed: FileChange[] = [];
    for (const file of files) {
      const next = await this.read(file.path);
      if (!next) continue;
      const path = relative(this.directory, resolve(this.directory, file.path)).split(sep).join("/");
      const status = file.value === null ? "added" : next.value === null ? "deleted" : "modified";
      if (file.value === undefined || next.value === undefined) {
        if (file.stamp !== next.stamp) this.otherChanges.set(path, { file: path, status, patch: "", additions: 0, deletions: 0 });
        continue;
      }
      if (file.value === next.value) continue;
      const before = file.value ?? "";
      const after = next.value ?? "";
      const lines = diffLines(before, after);
      const change: FileChange = {
        file: path,
        patch: createTwoFilesPatch(file.value === null ? "/dev/null" : path, next.value === null ? "/dev/null" : path, before, after, "", ""),
        additions: lines.reduce((count, line) => count + (line.added ? line.count : 0), 0),
        deletions: lines.reduce((count, line) => count + (line.removed ? line.count : 0), 0),
        status
      };
      this.changes.set(path, change);
      completed.push(change);
    }
    this.before.delete(id);
    return completed;
  }

  results() { return [...this.changes.values()]; }
  artifacts() { return [...this.otherChanges.values()]; }

  private async read(target: string): Promise<TrackedFile | undefined> {
    if (!target || target.includes("\0")) return;
    const path = resolve(this.directory, target);
    if (!inside(this.directory, path)) return;
    try {
      const resolved = await realpath(path);
      if (!inside(this.directory, resolved)) return;
      const handle = await open(resolved, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile()) return;
        const stamp = info.size + "/" + info.mtimeMs + "/" + info.ino;
        if (info.size > maxBytes) return { path: target, stamp };
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const data = buffer.subarray(0, bytesRead);
        if (bytesRead > info.size || data.includes(0)) return { path: target, stamp };
        try { return { path: target, stamp, value: new TextDecoder("utf-8", { fatal: true }).decode(data) }; }
        catch { return { path: target, stamp }; }
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: target, value: null };
    }
  }
}
