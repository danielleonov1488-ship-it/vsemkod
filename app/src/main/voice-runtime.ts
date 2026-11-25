import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import { voiceHop, voiceRate, type VoiceEvent, type VoiceSilence } from "../shared/voice";
import { VoicePhrases } from "./voice-phrases";

interface WhisperContext {
  transcribeData(pcm: ArrayBuffer, options: { language: string; maxThreads: number; beamSize: number; bestOf: number;
    temperature: number; temperatureInc: number; maxContext: number }):
    { promise: Promise<{ result: string; isAborted: boolean }> };
  release(): Promise<void>;
}
interface VadStream {
  push(pcm: Int16Array): Promise<number[]>;
  flush(): Promise<number[]>;
  release(): Promise<void>;
}
interface VadContext {
  createStream(): Promise<VadStream>;
  release(): Promise<void>;
}
interface Addon {
  WhisperContext: new (options: { filePath: string; useGpu: boolean; useFlashAttn: boolean }) => WhisperContext;
  WhisperVadContext: new (options: { filePath: string; nThreads: number }) => VadContext;
}
const requireNative = createRequire(import.meta.url);
const threads = Math.max(1, Math.min(8, availableParallelism() - 1));

export type VoiceConfig = {
  binaries: string; vad: string; language: string; silence: VoiceSilence; gpu: boolean;
  model?: string; groqKey?: string;
};
export type WorkerCommand = { type: "init"; config: VoiceConfig } |
  { type: "audio"; pcm: ArrayBuffer } | { type: "stop" | "cancel" } | { type: "benchmark"; sample: string };
type Transcript = Extract<VoiceEvent, { text: string }>;
export type WorkerReply = { type: "ready" } | { type: "silence" | "done" } | { type: "error"; message: string } |
  { type: "benchmark"; rtf: number } | Omit<Transcript, "id">;

export function readVoiceWav(bytes: Buffer): Int16Array<ArrayBuffer> {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Некорректный WAV.");
  let validFormat = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + size > bytes.length) break;
    if (tag === "fmt " && size >= 16) {
      validFormat = bytes.readUInt16LE(offset) === 1 && bytes.readUInt16LE(offset + 2) === 1 &&
        bytes.readUInt32LE(offset + 4) === voiceRate && bytes.readUInt16LE(offset + 14) === 16;
    }
    if (tag === "data" && validFormat && size % 2 === 0) {
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(offset + i * 2);
      return pcm;
    }
    offset += size + (size % 2);
  }
  throw new Error("Требуется WAV PCM16 моно, 16 кГц.");
}

function wave(pcm: Int16Array<ArrayBuffer>) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(voiceRate, 24);
  header.writeUInt32LE(voiceRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

async function groq(pcm: Int16Array<ArrayBuffer>, language: string, key: string, signal: AbortSignal) {
  const body = new FormData();
  body.append("model", "whisper-large-v3-turbo");
  body.append("file", new Blob([new Uint8Array(wave(pcm))], { type: "audio/wav" }), "dictation.wav");
  if (language !== "auto") body.append("language", language);
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: "Bearer " + key }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  });
  if (!response.ok) throw new Error("Groq отклонил распознавание (HTTP " + response.status + ").");
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== "string") throw new Error("Groq вернул неверный результат распознавания.");
  return result.text;
}

// Both native constructors open files synchronously. A relative ASCII name also
// works with the Windows toolchains whose narrow paths reject Unicode profiles.
function withModelPath<T>(path: string, open: (path: string) => T): T {
  if (process.platform !== "win32") return open(path);
  const cwd = process.cwd();
  process.chdir(dirname(path));
  try { return open(basename(path)); }
  finally { process.chdir(cwd); }
}

function transcribeCli(binary: string, model: string, pcm: Int16Array<ArrayBuffer>, language: string, signal: AbortSignal) {
  const context = Math.min(1500, Math.max(256, Math.ceil(pcm.length / 320) + 100));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ["-m", basename(model), "-f", "-", "-otxt", "-of", "-", "-nt", "-ng",
      "-l", language, "-t", String(threads), "-ac", String(context), "-bs", "1", "-bo", "1", "-nf"], {
      cwd: dirname(model), windowsHide: true, stdio: ["pipe", "pipe", "ignore"], signal,
      env: process.platform === "linux" ? { ...process.env, LD_LIBRARY_PATH: dirname(binary) +
        (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "") } : undefined
    });
    let text = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; });
    child.stdin.on("error", () => {}); // An early exit (for example, a missing library) also closes stdin.
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve(text);
      else reject(new Error("whisper-cli завершился с кодом " + code + "."));
    });
    child.stdin.end(wave(pcm));
  });
}

export class VoiceRuntime {
  private readonly abort = new AbortController();
  private cli?: string;
  private context?: WhisperContext;
  private readonly phrases: VoicePhrases;
  private pending = new Int16Array(0);
  private queue: { phrase: number; pcm: Int16Array<ArrayBuffer> }[] = [];
  private next = 1;
  private previewSize = 0;
  private decoding?: Promise<void>;
  private stopped = false;
  private silenceSent = false;
  private failed = false;

  private constructor(private readonly config: VoiceConfig, private readonly cpu: () => Addon,
    context: WhisperContext | undefined, cli: string | undefined, private readonly vad: VadContext,
    private readonly stream: VadStream, private readonly send: (reply: WorkerReply) => void) {
    this.cli = cli;
    this.context = context;
    this.phrases = new VoicePhrases(config.silence, pcm => {
      this.queue.push({ phrase: this.next++, pcm });
      this.previewSize = 0;
      this.decode();
    });
  }

  static async open(config: VoiceConfig, send: (reply: WorkerReply) => void) {
    const cpu = () => requireNative(join(config.binaries, "whisper.node")) as Addon;
    const gpuFile = process.platform === "darwin" ? "whisper.node" : "whisper-vulkan.node";
    let addon: Addon | undefined;
    let context: WhisperContext | undefined;
    let cli: string | undefined;
    if (config.model && config.gpu) {
      try {
        addon = requireNative(join(config.binaries, gpuFile)) as Addon;
        const gpu = addon;
        context = withModelPath(config.model, filePath => new gpu.WhisperContext({ filePath, useGpu: true, useFlashAttn: true }));
      } catch { addon = undefined; }
    }
    addon ??= cpu();
    if (config.model && !context) {
      const binary = join(config.binaries, "cli", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
      if (existsSync(binary)) cli = binary;
      else {
        const native = addon;
        context = withModelPath(config.model, filePath => new native.WhisperContext({ filePath, useGpu: false, useFlashAttn: false }));
      }
    }
    let vad: VadContext | undefined;
    try {
      const native = addon;
      vad = withModelPath(config.vad, filePath => new native.WhisperVadContext({ filePath, nThreads: 1 }));
      return new VoiceRuntime(config, cpu, context, cli, vad, await vad.createStream(), send);
    } catch (error) {
      await Promise.allSettled([context?.release(), vad?.release()]);
      throw error;
    }
  }

  private async recognize(pcm: Int16Array<ArrayBuffer>, language = this.config.language) {
    const signal = this.abort.signal;
    signal.throwIfAborted();
    if (this.config.groqKey) return groq(pcm, language, this.config.groqKey, signal);
    if (this.cli && this.config.model) {
      try { return await transcribeCli(this.cli, this.config.model, pcm, language, signal); }
      catch {
        signal.throwIfAborted();
        this.cli = undefined;
        const addon = this.cpu();
        this.context = withModelPath(this.config.model,
          filePath => new addon.WhisperContext({ filePath, useGpu: false, useFlashAttn: false }));
      }
    }
    if (!this.context) throw new Error("Голосовая модель не загружена.");
    // Greedy decoding keeps latency low enough for a queue of live phrases.
    const { promise } = this.context.transcribeData(pcm.buffer, {
      language, maxThreads: threads, beamSize: 1, bestOf: 1, temperature: 0, temperatureInc: 0, maxContext: 0
    });
    const result = await promise;
    if (result.isAborted) throw new Error("Распознавание прервано.");
    return result.result;
  }

  async benchmark(pcm: Int16Array<ArrayBuffer>) {
    const measure = async () => {
      const start = performance.now();
      const text = await this.recognize(pcm);
      if (!text.trim()) throw new Error("Голосовая модель не распознала тестовый образец.");
      return (performance.now() - start) / 1000 / (pcm.length / voiceRate);
    };
    const rtf = await measure();
    // The first GPU pass can compile shaders. Measure once more if it crosses the warning threshold.
    return this.config.gpu && this.context && rtf > 0.8 ? measure() : rtf;
  }

  private decode() {
    if (this.decoding || this.failed) return;
    const final = this.queue.shift();
    const preview = !final && !this.config.groqKey && !this.stopped
      ? this.phrases.preview(this.previewSize + 4 * voiceRate) : undefined;
    if (!final && !preview) return;
    const phrase = final?.phrase ?? this.next;
    const pcm = final?.pcm ?? preview!;
    if (preview) this.previewSize = preview.length;
    this.decoding = this.recognize(pcm).then(text => {
      if (final || phrase === this.next && !this.stopped) {
        this.send({ type: final ? "final" : "partial", phrase, text: text.trim() });
      }
    }).catch(error => {
      this.failed = true;
      this.queue = [];
      this.send({ type: "error", message: this.config.groqKey && error instanceof Error ? error.message : "Whisper не смог распознать фразу." });
    }).finally(() => {
      this.decoding = undefined;
      this.decode();
    });
  }

  async audio(pcm: Int16Array<ArrayBuffer>) {
    if (this.stopped || this.failed || this.silenceSent) return;
    const input = new Int16Array(this.pending.length + pcm.length);
    input.set(this.pending);
    input.set(pcm, this.pending.length);
    this.feed(input, await this.stream.push(pcm));
    this.decode();
  }

  private feed(input: Int16Array<ArrayBuffer>, probabilities: number[]) {
    let offset = 0;
    for (const probability of probabilities) {
      if (this.phrases.push(input.slice(offset, offset + voiceHop), probability) && !this.silenceSent) {
        this.silenceSent = true;
        this.send({ type: "silence" });
      }
      offset += voiceHop;
    }
    this.pending = input.slice(offset);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.feed(this.pending, await this.stream.flush());
    this.pending = new Int16Array(0);
    this.phrases.finish();
    while (this.decoding) await this.decoding;
    return !this.failed;
  }

  cancel() { this.abort.abort(); }

  async close() {
    await Promise.allSettled([this.stream.release(), this.context?.release()]);
    await this.vad.release();
  }
}
