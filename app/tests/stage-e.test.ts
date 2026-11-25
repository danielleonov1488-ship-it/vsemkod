import { createHash } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migratePreferences } from "../src/main/preferences";
import { matchesSha256, VoiceModels, type ModelFile } from "../src/main/voice-models";
import { VoicePhrases } from "../src/main/voice-phrases";
import { insertVoiceDraft, updateVoiceDraft, voiceDefaults, voiceHop, type VoiceDraft } from "../src/shared/voice";

const audio = new Int16Array(voiceHop).fill(12);
const data = Buffer.from("abc123xyz");
const file: ModelFile = { filename: "model.bin", url: "https://model.example/test", bytes: data.length,
  sha256: createHash("sha256").update(data).digest("hex") };
const temporary: string[] = [];
const directory = async () => {
  const path = await mkdtemp(join(process.cwd(), ".voice-test-"));
  temporary.push(path);
  return path;
};
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    await Promise.all([file.filename, file.filename + ".part"].map(name => unlink(join(path, name)).catch(() => {})));
    await rmdir(path);
  }
});
const signal = () => new AbortController().signal;

it("keeps accurate, auto language, local recognition and 30 seconds of silence for old preferences", () => {
  expect(migratePreferences({ auto: false }, "test")).toMatchObject(voiceDefaults);
});

it("keeps the newest partial and commits each final phrase once at the original selection", () => {
  let draft: VoiceDraft = { text: "До старое после", start: 3, end: 9, spoken: "", lastFinal: 0 };
  draft = updateVoiceDraft(draft, "partial", 1, "Голос");
  expect(draft.partial?.text).toBe("Голос");
  expect(insertVoiceDraft(draft).text).toBe("До старое после");
  draft = updateVoiceDraft(draft, "partial", 1, "Голосовой");
  draft = updateVoiceDraft(draft, "final", 1, "Голосовой ввод");
  draft = updateVoiceDraft(draft, "partial", 1, "устарело");
  draft = updateVoiceDraft(draft, "final", 1, "дубликат");
  draft = updateVoiceDraft(draft, "final", 2, ", проба.");
  expect(draft.partial).toBeUndefined();
  expect(insertVoiceDraft(draft)).toEqual({ text: "До Голосовой ввод, проба. после", cursor: 25 });
  expect(insertVoiceDraft({ ...draft, text: "你好！", start: 2, end: 2, spoken: "世界" }).text).toBe("你好世界！");
});

it.each([10, 30] as const)("emits phrases on pauses and auto-stops after %i seconds from the last speech", seconds => {
  const phrases: Int16Array[] = [];
  const vad = new VoicePhrases(seconds, pcm => phrases.push(pcm));
  for (let i = 0; i < 14; i++) expect(vad.push(audio, 0.9)).toBe(false);
  for (let i = 1; i <= Math.ceil(seconds * 16000 / voiceHop); i++) {
    expect(vad.push(audio, 0.05)).toBe(i === Math.ceil(seconds * 16000 / voiceHop));
  }
  expect(phrases).toHaveLength(1);
  expect(phrases[0].length).toBe(22 * voiceHop);
});

it("leaves silence detection off and splits continuous speech into manageable phrases", () => {
  const final = vi.fn();
  const vad = new VoicePhrases(0, final);
  for (let i = 0; i < 1200; i++) expect(vad.push(audio, 0.01)).toBe(false);
  for (let i = 0; i < 1200; i++) vad.push(audio, 0.95);
  vad.finish();
  expect(final).toHaveBeenCalledTimes(3);
});

it("rejects download without consent before any file or network operation", async () => {
  const basedir = await directory();
  const request = vi.fn();
  const models = new VoiceModels(join(basedir, "absent"), request);
  await expect(models.download(file, false, signal(), vi.fn())).rejects.toThrow("Подтвердите");
  expect(request).not.toHaveBeenCalled();
  await expect(stat(models.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("resumes from validated HTTP ranges and installs after SHA-256 verification", async () => {
  const basedir = await directory();
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(data.subarray(3, 6), { status: 206, headers: { "Content-Range": "bytes 3-5/9" } }))
    .mockResolvedValueOnce(new Response(data.subarray(6), { status: 206, headers: { "Content-Range": "bytes 6-8/9" } }));
  const models = new VoiceModels(basedir, request);
  const path = join(basedir, file.filename);
  await writeFile(path + ".part", data.subarray(0, 3));
  await models.download(file, true, signal(), vi.fn());
  expect(request.mock.calls.map(([, options]) => options?.headers)).toEqual([{ Range: "bytes=3-" }, { Range: "bytes=6-" }]);
  expect(await readFile(path)).toEqual(data);
  expect(await matchesSha256(path, file.sha256)).toBe(true);
});

it("restarts a download when a server ignores Range, and rejects a bad checksum", async () => {
  const basedir = await directory();
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(Buffer.alloc(data.length)))
    .mockResolvedValueOnce(new Response(data));
  const models = new VoiceModels(basedir, request);
  const path = join(basedir, file.filename);
  await writeFile(path + ".part", Buffer.from("abc"));
  await expect(models.download(file, true, signal(), vi.fn())).rejects.toThrow("Контрольная сумма");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await models.download(file, true, signal(), vi.fn());
  expect(request.mock.calls[1][1]?.headers).toBeUndefined();
  expect(await readFile(path)).toEqual(data);
});

it("does not append a range with the wrong offset", async () => {
  const basedir = await directory();
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(data.subarray(2), {
    status: 206, headers: { "Content-Range": "bytes 2-8/9" }
  }));
  const models = new VoiceModels(basedir, request);
  const path = join(basedir, file.filename) + ".part";
  await writeFile(path, data.subarray(0, 3));
  await expect(models.download(file, true, signal(), vi.fn())).rejects.toThrow("неверный диапазон");
  expect(await readFile(path)).toEqual(data.subarray(0, 3));
});
