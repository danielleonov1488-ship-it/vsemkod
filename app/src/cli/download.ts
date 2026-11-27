
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

export async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifySha256(path: string, expected: string) {
  if (await sha256(path) !== expected.toLowerCase()) {
    throw new Error("Контрольная сумма SHA-256 не совпала.");
  }
}

export async function downloadFile(url: string, path: string) {
  const signal = AbortSignal.timeout(120_000);
  const response = await fetch(url, { signal }).catch(() => {
    throw new Error("Не удалось скачать файл. Проверьте доступ к GitHub.");
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Не удалось скачать файл с GitHub (HTTP " + response.status + ").");
  }
  await pipeline(response.body as unknown as ReadableStream, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
}
