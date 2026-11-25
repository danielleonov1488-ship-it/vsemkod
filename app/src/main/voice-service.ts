import { app, systemPreferences, utilityProcess } from "electron";
import { rm } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { voiceDefaults, voiceModels, type VoiceEvent, type VoiceModel, type VoiceProgress, type VoiceStatus } from "../shared/voice";
import type { Preferences } from "../shared/api";
import { readJson, writeJson } from "./storage";
import { voiceFileSize, voiceFiles, VoiceModels } from "./voice-models";
import type { VoiceConfig, WorkerCommand, WorkerReply } from "./voice-runtime";

const benchmarkSchema = z.object({ rtf: z.number().positive(), version: z.string() });

class VoiceProcess {
  readonly ready: Promise<void>;
  private child: ReturnType<typeof utilityProcess.fork>;

  constructor(worker: string, config: VoiceConfig, receive: (event: WorkerReply) => void) {
    this.child = utilityProcess.fork(worker, [], { serviceName: "vsemkod Voice", stdio: "ignore" });
    this.ready = new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => fail("Голосовой движок слишком долго запускается."), 45_000);
      const fail = (message: string) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(message));
        else receive({ type: "error", message });
      };
      this.child.once("exit", () => fail("Голосовой движок остановился."));
      this.child.on("message", (reply: WorkerReply) => {
        if (reply.type === "ready") {
          ready = true;
          clearTimeout(timeout);
          resolve();
        } else if (reply.type === "error" && !ready) fail(reply.message);
        else receive(reply);
      });
    });
    this.child.once("spawn", () => this.post({ type: "init", config }));
  }

  post(command: WorkerCommand) { this.child.postMessage(command); }
  kill() { this.child.kill(); }
  cancel() {
    this.post({ type: "cancel" });
    // Give the utility process time to stop a CPU CLI child or a Groq request.
    const timer = setTimeout(() => this.kill(), 600);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
  }
}

export class VoiceService {
  private readonly models: VoiceModels;
  private readonly benchmarks: string;
  private gpu?: Promise<boolean>;
  private gpuFailed = false;
  private active?: { id: string; controller: AbortController; process?: VoiceProcess };
  private downloadJob?: { controller: AbortController; progress: VoiceProgress; done: Promise<VoiceStatus> };
  private removing = false;

  constructor(data: string, private readonly binaries: string, private readonly worker: string, private readonly sample: string,
    private readonly groqKey: () => string | undefined, private readonly emit: (event: VoiceEvent) => void) {
    this.models = new VoiceModels(join(data, "voice"));
    this.benchmarks = join(data, "voice", "benchmark.json");
  }

  private async acceleration() {
    if (this.gpuFailed) return false;
    if (process.platform === "darwin") return process.arch === "arm64";
    if (!["win32", "linux"].includes(process.platform)) return false;
    return this.gpu ??= app.getGPUInfo("basic").then(info => {
      const gpus = (info as { gpuDevice?: { vendorId?: number; deviceId?: number }[] }).gpuDevice;
      return !!gpus?.some(device => !!device.vendorId && !!device.deviceId && device.vendorId !== 0x1414 &&
        device.vendorId !== 0x1ae0 && device.vendorId !== 0xffff);
    }).catch(() => false);
  }

  private async benchmarkResult() {
    const saved = await readJson(this.benchmarks, benchmarkSchema);
    if (saved?.version === voiceFiles.accurate.sha256) return saved.rtf;
  }

  async status(): Promise<VoiceStatus> {
    const sizes = await Promise.all(voiceModels.map(async model => [model, {
      installed: await voiceFileSize(this.models.path(model)), partial: await voiceFileSize(this.models.path(model) + ".part")
    }] as const));
    const memoryLow = totalmem() < 8_000_000_000;
    const weakCpu = availableParallelism() < 8 && !await this.acceleration();
    return {
      models: { accurate: sizes[0][1], fast: sizes[1][1] },
      vadInstalled: await voiceFileSize(this.models.path("vad")) === voiceFiles.vad.bytes,
      recommendFast: memoryLow ? "memory" : weakCpu ? "cpu" : null,
      groq: !!this.groqKey(), rtf: await this.benchmarkResult(), download: this.downloadJob?.progress
    };
  }

  download(model: VoiceModel, consent: boolean, vadOnly: boolean) {
    if (!consent) throw new Error("Подтвердите загрузку голосовой модели.");
    if (this.active || this.downloadJob || this.removing) throw new Error("Другая голосовая операция уже выполняется.");
    const controller = new AbortController();
    const { signal } = controller;
    const total = voiceFiles.vad.bytes + (vadOnly ? 0 : voiceFiles[model].bytes);
    const progress = (received: number, phase: VoiceProgress["phase"]) => {
      if (this.downloadJob?.controller !== controller) return;
      this.downloadJob.progress = { model, received, total, phase };
      this.emit({ type: "progress", progress: this.downloadJob.progress });
    };
    const done = Promise.resolve().then(async () => {
      const vad = await this.models.download(voiceFiles.vad, consent, signal, progress);
      if (vadOnly) return;
      const path = await this.models.download(voiceFiles[model], consent, signal,
        (received, phase) => progress(voiceFiles.vad.bytes + received, phase));
      if (model !== "accurate" || await this.benchmarkResult() !== undefined) return;
      progress(total, "benchmark");
      try {
        const rtf = await this.benchmark({ model: path, vad, binaries: this.binaries, language: "auto",
          silence: 0, gpu: await this.acceleration() }, signal);
        await writeJson(this.benchmarks, { rtf, version: voiceFiles.accurate.sha256 });
      } catch (error) {
        // The model is already verified and can still be used. A later explicit download can retry the measurement.
        if (signal.aborted) throw error;
      }
    }).catch(error => {
      if (!signal.aborted) throw error;
    }).finally(() => { this.downloadJob = undefined; }).then(() => this.status());
    this.downloadJob = { controller, progress: { model, received: 0, total, phase: "download" }, done };
    void done.finally(() => this.status().then(status => this.emit({ type: "status", status }))).catch(() => {});
    return done;
  }

  pause() { this.downloadJob?.controller.abort(); }

  async remove(model: VoiceModel) {
    if (this.active || this.downloadJob || this.removing) throw new Error("Сначала завершите голосовую операцию.");
    this.removing = true;
    try {
      await this.models.remove(model);
      if (model === "accurate") await rm(this.benchmarks, { force: true });
      const other = model === "fast" ? "accurate" : "fast";
      if (!await voiceFileSize(this.models.path(other))) await this.models.remove("vad");
      const status = await this.status();
      this.emit({ type: "status", status });
      return status;
    } finally { this.removing = false; }
  }

  private async launch(config: VoiceConfig, signal: AbortSignal, receive: (event: WorkerReply) => void,
    register: (process: VoiceProcess) => void) {
    for (const gpu of config.gpu ? [true, false] : [false]) {
      signal.throwIfAborted();
      const child = new VoiceProcess(this.worker, { ...config, gpu }, receive);
      register(child);
      try {
        await child.ready;
        signal.throwIfAborted();
        return child;
      } catch (error) {
        child.kill();
        if (signal.aborted || !gpu) throw error;
        this.gpuFailed = true;
      }
    }
    throw new Error("Голосовой движок недоступен.");
  }

  private async benchmark(config: VoiceConfig, signal: AbortSignal) {
    let child: VoiceProcess | undefined;
    let rejectResult: ((error: Error) => void) | undefined;
    const abort = () => {
      child?.cancel();
      rejectResult?.(new Error("Замер остановлен."));
    };
    signal.addEventListener("abort", abort, { once: true });
    let resolveResult!: (value: number) => void;
    const result = new Promise<number>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    void result.catch(() => {});
    try {
      child = await this.launch(config, signal, event => {
        if (event.type === "benchmark") resolveResult(event.rtf);
        if (event.type === "error") rejectResult?.(new Error(event.message));
      }, process => { child = process; });
      const timer = setTimeout(() => rejectResult?.(new Error("Не удалось замерить скорость модели.")), 90_000);
      try {
        child.post({ type: "benchmark", sample: this.sample });
        return await result;
      } finally { clearTimeout(timer); }
    } finally {
      child?.cancel();
      signal.removeEventListener("abort", abort);
    }
  }

  async start(id: string, settings: Preferences) {
    if (this.active || this.downloadJob || this.removing) throw new Error("Другая голосовая операция уже выполняется.");
    const controller = new AbortController();
    const { signal } = controller;
    const job: NonNullable<VoiceService["active"]> = { id, controller };
    this.active = job;
    try {
      const key = settings.voiceGroq ? this.groqKey() : undefined;
      const vad = await this.models.verifiedPath(voiceFiles.vad, signal);
      const model = key ? undefined : await this.models.verifiedPath(voiceFiles[settings.voiceModel ?? voiceDefaults.voiceModel], signal);
      if (!vad || !key && !model) throw new Error("Загрузите голосовую модель. Если она уже загружена, удалите её в настройках и скачайте снова.");
      if (process.platform === "darwin" && !await systemPreferences.askForMediaAccess("microphone")) {
        throw new Error("Разрешите доступ к микрофону в системных настройках.");
      }
      await this.launch({ binaries: this.binaries, vad, model, groqKey: key, gpu: !key && await this.acceleration(),
        language: settings.voiceLanguage ?? voiceDefaults.voiceLanguage, silence: settings.voiceSilence ?? voiceDefaults.voiceSilence },
      signal, event => {
        if (this.active !== job || event.type === "ready" || event.type === "benchmark") return;
        this.emit({ ...event, id });
        if (event.type === "done" || event.type === "error") this.cancel(id);
      }, process => { job.process = process; });
    } catch (error) {
      this.cancel(id);
      throw error;
    }
  }

  audio(id: string, pcm: ArrayBuffer) {
    if (this.active?.id === id) this.active.process?.post({ type: "audio", pcm });
  }

  stop(id: string) {
    if (this.active?.id === id) this.active.process?.post({ type: "stop" });
  }

  cancel(id?: string) {
    const job = this.active;
    if (!job || id && job.id !== id) return;
    this.active = undefined;
    job.controller.abort();
    job.process?.cancel();
  }
}
