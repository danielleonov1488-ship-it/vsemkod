import { readFile } from "node:fs/promises";
import { readVoiceWav, VoiceRuntime, type WorkerCommand, type WorkerReply } from "./voice-runtime";

// Electron utilityProcess provides parentPort. This process owns inference and raw audio.
const port = process.parentPort;
const send = (reply: WorkerReply) => port.postMessage(reply);
let runtime: VoiceRuntime | undefined;
let queue = Promise.resolve();
port.on("message", ({ data }: { data: WorkerCommand }) => {
  if (data.type === "cancel") {
    runtime?.cancel();
    return;
  }
  queue = queue.then(async () => {
    if (data.type === "init") {
      runtime = await VoiceRuntime.open(data.config, send);
      send({ type: "ready" });
      return;
    }
    const current = runtime;
    if (!current) return;
    if (data.type === "audio") await current.audio(new Int16Array(data.pcm));
    if (data.type === "stop") {
      const done = await current.stop();
      await current.close();
      runtime = undefined;
      if (done) send({ type: "done" });
    }
    if (data.type === "benchmark") {
      const rtf = await current.benchmark(readVoiceWav(await readFile(data.sample)));
      await current.close();
      runtime = undefined;
      send({ type: "benchmark", rtf });
    }
  }).catch(error => send({ type: "error", message: error instanceof Error ? error.message : "Голосовой движок недоступен." }));
});
