import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZodType } from "zod";

export async function readJson<T>(path: string, schema: ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(staging, JSON.stringify(value), { mode: 0o600 });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}
