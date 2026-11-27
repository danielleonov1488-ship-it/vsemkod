
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

/**
 * Скачивание без общего лимита времени: движок весит около 100 МБ, а связь с GitHub бывает медленной.
 * Обрываем только если данных нет 60 секунд. В терминал пишем прогресс.
 */
export async function downloadFile(url: string, path: string, label = "Скачиваю движок") {
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), 60_000);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 60_000); };
  try {
    const response = await fetch(url, { signal: controller.signal }).catch(() => {
      throw new Error("Не удалось скачать файл. Проверьте доступ к GitHub.");
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Не удалось скачать файл с GitHub (HTTP " + response.status + ").");
    }
    const total = Number(response.headers.get("content-length")) || 0;
    const tty = process.stderr.isTTY;
    let received = 0;
    let shown = -1;
    const progress = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) {
        touch();
        received += chunk.byteLength;
        const percent = total ? Math.floor(received / total * 100) : -1;
        if (tty && percent !== shown && (percent % 5 === 0 || percent === 100)) {
          shown = percent;
          const size = (received / 1048576).toFixed(0) + (total ? " из " + (total / 1048576).toFixed(0) : "") + " МБ";
          process.stderr.write("\r" + label + ": " + size + (percent >= 0 ? " · " + percent + "%" : "") + "   ");
        }
        output.enqueue(chunk);
      }
    });
    await pipeline(response.body.pipeThrough(progress) as unknown as ReadableStream, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal: controller.signal })
      .catch(error => {
        if (controller.signal.aborted) throw new Error("Загрузка остановилась: больше минуты не приходили данные. Проверьте соединение и повторите.");
        throw error;
      });
    if (tty) process.stderr.write("\n");
  } finally {
    clearTimeout(idle);
  }
}
