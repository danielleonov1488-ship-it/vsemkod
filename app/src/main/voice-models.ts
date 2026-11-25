import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { vadBytes, voiceModelBytes, type VoiceModel } from "../shared/voice";

export type ModelFile = { filename: string; url: string; bytes: number; sha256: string };
const whisper = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/";
const silero = "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/";
const modelFile = (base: string, filename: string, bytes: number, sha256: string): ModelFile =>
  ({ filename, url: base + filename + "?download=true", bytes, sha256 });
export const voiceFiles = {
  fast: modelFile(whisper, "ggml-base.bin", voiceModelBytes.fast,
    "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"),
  accurate: modelFile(whisper, "ggml-large-v3-turbo-q5_0.bin", voiceModelBytes.accurate,
    "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
  vad: modelFile(silero, "ggml-silero-v6.2.0.bin", vadBytes,
    "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987")
};

async function fileInfo(path: string) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function voiceFileSize(path: string) {
  return (await fileInfo(path))?.size ?? 0;
}

export async function matchesSha256(path: string, expected: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex") === expected;
}

export class VoiceModels {
  private verified = new Map<string, number>();

  constructor(readonly directory: string, private readonly request: typeof fetch = fetch) {}

  path(model: VoiceModel | "vad") { return join(this.directory, voiceFiles[model].filename); }

  async verifiedPath(file: ModelFile, signal?: AbortSignal): Promise<string | undefined> {
    const path = join(this.directory, file.filename);
    const info = await fileInfo(path);
    if (info?.size !== file.bytes) return;
    if (this.verified.get(path) !== info.mtimeMs) {
      if (!await matchesSha256(path, file.sha256, signal)) return;
      this.verified.set(path, info.mtimeMs);
    }
    return path;
  }

  async download(file: ModelFile, consent: boolean, signal: AbortSignal,
    progress: (received: number, phase: "download" | "verify") => void) {
    if (!consent) throw new Error("Подтвердите загрузку голосовой модели.");
    signal.throwIfAborted();
    const path = join(this.directory, file.filename);
    const partial = path + ".part";
    await mkdir(this.directory, { recursive: true });
    const install = async () => {
      progress(file.bytes, "verify");
      if (!await matchesSha256(partial, file.sha256, signal)) {
        await rm(partial, { force: true });
        throw new Error("Контрольная сумма модели не совпала. Повторите загрузку.");
      }
      signal.throwIfAborted();
      await rename(partial, path);
      this.verified.set(path, (await stat(path)).mtimeMs);
      return path;
    };

    if (await this.verifiedPath(file, signal)) return path;
    let received = await voiceFileSize(partial);
    if (received === file.bytes) return install();
    if (received > file.bytes) received = 0;
    progress(received, "download");

    // A CDN may return a bounded range, or ignore Range and send a full response.
    while (received < file.bytes) {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
      const response = await this.request(file.url, { signal: requestSignal,
        headers: received ? { Range: "bytes=" + received + "-" } : undefined });
      const invalid = async () => {
        await response.body?.cancel();
        throw new Error("Сервер модели вернул неверный диапазон данных.");
      };
      if (!response.ok || !response.body) throw new Error("Ошибка загрузки модели (HTTP " + response.status + ").");
      let limit = file.bytes;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        if (!range || +range[1] !== received || +range[3] !== file.bytes || +range[2] < received || +range[2] >= file.bytes) {
          await invalid();
        }
        limit = +range![2] + 1;
      } else if (response.status === 200) {
        received = 0;
      } else await invalid();

      const output = await open(partial, received ? "a" : "w");
      const reader = response.body.getReader();
      let lastProgress = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (received + value.byteLength > limit) throw new Error("Размер данных модели превышает ожидаемый.");
          let written = 0;
          while (written < value.byteLength) written += (await output.write(value, written)).bytesWritten;
          received += value.byteLength;
          if (Date.now() - lastProgress >= 150) {
            progress(received, "download");
            lastProgress = Date.now();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        await output.close();
      }
      if (received !== limit) throw new Error("Загрузка прервалась. Её можно продолжить.");
    }
    return install();
  }

  async remove(model: VoiceModel | "vad") {
    const path = this.path(model);
    this.verified.delete(path);
    await Promise.all([rm(path, { force: true }), rm(path + ".part", { force: true })]);
  }
}
