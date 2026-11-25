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

type TextFile = { path: string; value: string | null };

export class DiffTracker {
  private before = new Map<string, TextFile[]>();
  private changes = new Map<string, FileChange>();

  constructor(private readonly directory: string) {}

  async capture(id: string, targets: string[]) {
    if (!targets.length) return;
    const files = await Promise.all(targets.map(target => this.read(target)));
    this.before.set(id, files.filter((file): file is TextFile => file !== undefined));
  }

  async finish(id: string, target: string, output?: string): Promise<FileChange | undefined> {
    const files = this.before.get(id) ?? [];
    if (!files.length && target && output?.startsWith("Created file successfully:")) files.push({ path: target, value: null });
    let first;
    for (const file of files) {
      const next = await this.read(file.path);
      if (!next || file.value === next.value) continue;
      const path = relative(this.directory, resolve(this.directory, file.path)).split(sep).join("/");
      const before = file.value ?? "";
      const after = next.value ?? "";
      const lines = diffLines(before, after);
      const change: FileChange = {
        file: path,
        patch: createTwoFilesPatch(file.value === null ? "/dev/null" : path, next.value === null ? "/dev/null" : path, before, after, "", ""),
        additions: lines.reduce((count, line) => count + (line.added ? line.count : 0), 0),
        deletions: lines.reduce((count, line) => count + (line.removed ? line.count : 0), 0),
        status: file.value === null ? "added" : next.value === null ? "deleted" : "modified"
      };
      this.changes.set(path, change);
      first ??= change;
    }
    this.before.delete(id);
    return first;
  }

  results() { return [...this.changes.values()]; }

  private async read(target: string): Promise<TextFile | undefined> {
    if (!target || target.includes("\0")) return;
    const path = resolve(this.directory, target);
    if (!inside(this.directory, path)) return;
    try {
      const resolved = await realpath(path);
      if (!inside(this.directory, resolved)) return;
      const handle = await open(resolved, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxBytes) return;
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > info.size || buffer.subarray(0, bytesRead).includes(0)) return;
        return { path: target, value: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)) };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: target, value: null };
    }
  }
}
