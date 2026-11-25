import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { VoiceModels, voiceFiles } from "../src/main/voice-models";
import { readVoiceWav, VoiceRuntime, type WorkerReply } from "../src/main/voice-runtime";
import { voiceChunk, voiceModels, voiceRate } from "../src/shared/voice";

const { values } = parseArgs({ options: { models: { type: "string", default: ".vsemkod-dev/voice-models" },
  download: { type: "boolean" }, model: { type: "string" }, gpu: { type: "boolean" } } });
const models = new VoiceModels(resolve(values.models));
console.log(process.platform, process.arch, cpus()[0]?.model.trim(), availableParallelism() + " logical CPUs");
for (const key of ["vad", ...voiceModels] as const) {
  const file = voiceFiles[key];
  if (values.download) await models.download(file, true, AbortSignal.timeout(45 * 60_000), () => {});
  assert(await models.verifiedPath(file), "Missing or invalid model: " + models.path(key));
}

const fixtures = [
  ["voice-en", /project|settings/i], ["voice-ru", /папк|проект|настройк/i],
  ["voice-es", /carpeta|proyecto|configuraci/i], ["voice-long", /project|settings/i]
] as const;
const binaries = resolve("resources", "voice", process.platform + "-" + process.arch);

for (const model of voiceModels) {
  if (values.model && model !== values.model) continue;
  const events: WorkerReply[] = [];
  const run = await VoiceRuntime.open({ binaries, vad: models.path("vad"), model: models.path(model), gpu: !!values.gpu,
    language: "auto", silence: 0 }, event => events.push(event));
  const sample = readVoiceWav(await readFile(join("tests", "fixtures", "voice-en.wav")));
  console.log(model + " · 10-second in-app benchmark RTF " + (await run.benchmark(sample)).toFixed(3));
  await run.close();

  for (const [fixture, expected] of fixtures) {
    const pcm = readVoiceWav(await readFile(join("tests", "fixtures", fixture + ".wav")));
    const ms = performance.now();
    const messages: WorkerReply[] = [];
    const runtime = await VoiceRuntime.open({ binaries, vad: models.path("vad"), model: models.path(model), gpu: !!values.gpu,
      // The lightweight model can confuse the synthetic Russian voice with Polish.
      language: model === "fast" && fixture === "voice-ru" ? "ru" : "auto", silence: 0 }, event => messages.push(event));
    const ready = performance.now();
    try {
      for (let pos = 0; pos < pcm.length; pos += voiceChunk) await runtime.audio(pcm.slice(pos, pos + voiceChunk));
      await runtime.stop();
    } finally { await runtime.close(); }
    const seconds = pcm.length / voiceRate;
    const mode = model === "fast" && fixture === "voice-ru" ? "ru" : "auto";
    const result = messages.filter(item => item.type === "final").map(item => (item as { text: string }).text).join(" ");
    assert(messages.every(item => item.type !== "error"), JSON.stringify(messages.filter(item => item.type === "error")));
    assert(expected.test(result), fixture + ": " + result);
    if (fixture === "voice-long") {
      assert(messages.filter(item => item.type === "final").length >= 14, "Expected multiple final phrases");
      assert(/write down|duration of each|name of the model/i.test(result), "The last phrase was not recognized");
    }
    console.log(model + " · " + fixture + " · " + seconds.toFixed(2) + " s · " + mode + " · RTF " + ((performance.now() - ready) / 1000 / seconds).toFixed(3) +
      " · init " + ((ready - ms) / 1000).toFixed(2) + " s · " + result.slice(0, 180));
  }
}
