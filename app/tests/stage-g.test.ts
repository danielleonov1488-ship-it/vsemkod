import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiffTracker } from "../src/main/engine/diff-tracker";
import { TurnQueue } from "../src/main/engine/turn-queue";
import { previewFile } from "../src/main/file-preview";
import { ProviderHealth } from "../src/main/router/health";
import { readReplyUsage } from "../src/main/router/reply-usage";
import { benchmarksSchema, compareByBenchmark } from "../src/shared/benchmarks";
import { canOpenFile, fileReference, textFileReferences } from "../src/shared/file-links";
import { estimateTokens, tokenCharacters } from "../src/shared/usage";

describe("Stage G", () => {
  it("runs three sessions concurrently, rejects duplicates, and cancels only the target", async () => {
    const queue = new TurnQueue();
    const queued = vi.fn();
    expect(await Promise.all(["one", "two", "three"].map(id => queue.acquire(id, queued)))).toEqual([true, true, true]);
    const fourth = queue.acquire("four", queued);
    const fifth = queue.acquire("five", queued);
    expect(queued).toHaveBeenCalledTimes(2);
    await expect(queue.acquire("two", queued)).rejects.toThrow();
    await expect(queue.acquire("four", queued)).rejects.toThrow();
    expect(queue.cancel("four")).toBe(true);
    await expect(fourth).resolves.toBe(false);
    expect(queue.has("two")).toBe(true);
    expect(queue.has("three")).toBe(true);
    queue.release("one");
    await expect(fifth).resolves.toBe(true);
    expect(queue.has("one")).toBe(false);
    expect(queue.has("five")).toBe(true);
  });

  it("finds paths and lines without treating URLs or versions as files", () => {
    const windows = "G:\\work\\project\\src\\app.tsx";
    expect(fileReference(windows + ":42")).toEqual({ path: windows, line: 42 });
    expect(fileReference("G:\\my project\\src\\app.tsx")).toMatchObject({ path: "G:\\my project\\src\\app.tsx" });
    expect(fileReference("/home/work/logo.svg")).toMatchObject({ path: "/home/work/logo.svg" });
    expect(textFileReferences("See src/app.tsx, /tmp/icon.svg and index.html:12 (v1.2.3) https://example.org/script.js.")
      .map(({ path, line }) => [path, line])).toEqual([["src/app.tsx", undefined], ["/tmp/icon.svg", undefined], ["index.html", 12]]);
    expect(textFileReferences("См. G:\\my project\\app.tsx:2 и /tmp/My Project/app.tsx.")
      .map(({ path, line }) => [path, line])).toEqual([["G:\\my project\\app.tsx", 2], ["/tmp/My Project/app.tsx", undefined]]);
    expect(fileReference("www.example.com")).toBeUndefined();
    expect(fileReference("https://example.org/index.html:12")).toBeUndefined();
  });

  it("blocks launching executable and script extensions case-insensitively", () => {
    for (const extension of "exe bat cmd ps1 sh com msi scr js vbs jar app lnk desktop AppImage cjs mjs py".split(" ")) {
      expect(canOpenFile("demo." + extension)).toBe(false);
    }
    expect(canOpenFile("test.exe. ")).toBe(false);
    expect(canOpenFile("logo.svg")).toBe(true);
    expect(canOpenFile("docs.html")).toBe(true);
  });

  it("checks real paths and bounds local file previews", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vsemkod-g-file-"));
    try {
      const project = join(scratch, "project");
      const sibling = join(scratch, "project-other");
      await mkdir(project);
      await mkdir(sibling);
      const outside = join(sibling, "private.txt");
      await writeFile(outside, "private");
      await symlink(sibling, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
      await expect(previewFile(project, outside)).rejects.toThrow();
      await expect(previewFile(project, "../project-other/private.txt")).rejects.toThrow();
      await expect(previewFile(project, "escape/private.txt")).rejects.toThrow();
      await writeFile(join(project, "result.txt"), "a".repeat(512 * 1024 + 10));
      const text = await previewFile(project, "result.txt");
      expect(text.text).toHaveLength(512 * 1024);
      expect(text.truncated).toBe(true);
      await writeFile(join(project, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      expect((await previewFile(project, "logo.svg")).image).toMatch(/^data:image\/svg\+xml;base64,/);
      await writeFile(join(project, "large.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
      await expect(previewFile(project, "large.png")).rejects.toThrow("8 МБ");
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  it("keeps binary artifacts available for cards without creating a text patch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vsemkod-g-binary-"));
    try {
      const tracker = new DiffTracker(scratch);
      await tracker.capture("write", ["image.png"]);
      await writeFile(join(scratch, "image.png"), Buffer.from([0, 7, 2]));
      expect(await tracker.finish("write", "image.png")).toEqual([]);
      expect(tracker.artifacts()).toEqual([{ file: "image.png", status: "added", patch: "", additions: 0, deletions: 0 }]);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  it("orders known indices before unknown ones, breaking ties by rank", () => {
    const benchmarks = benchmarksSchema.parse({ schemaVersion: 1, generatedAt: "2026-11-26T00:00:00Z", aggregate: "ignored",
      source: { name: "Artificial Analysis", url: "https://artificialanalysis.ai/", indexVersion: "5.0" },
      models: { a: { index: 60, extraMetric: 1 }, b: { index: 62 }, c: { index: 62 }, d: { speed: 180 } } });
    const models = [{ id: "a", rank: 1 }, { id: "b", rank: 20 }, { id: "c", rank: 10 }, { id: "d", rank: 2 }, { id: "e", rank: 1 }];
    expect(models.sort((a, b) => compareByBenchmark(a, b, benchmarks)).map(model => model.id)).toEqual(["c", "b", "a", "e", "d"]);
  });

  it("estimates Cyrillic and Latin tokens and switches to exact measurement when usage arrives", () => {
    expect(estimateTokens(22, 0)).toBe(10);
    expect(estimateTokens(0, 35)).toBe(10);
    expect(tokenCharacters("код code")).toEqual({ cyrillic: 3, other: 5 });
    expect(estimateTokens(22, 35)).toBe(20);
    let now = 100;
    const usage = readReplyUsage(true, 0, () => now);
    const chunk = (value: object) => usage.push(Buffer.from("data: " + JSON.stringify(value) + "\n\n"));
    chunk({ choices: [{ delta: { content: "a".repeat(35), reasoning_content: "ы".repeat(22) } }] });
    now = 1100;
    expect(usage.speed(true)).toEqual({ tokensPerSecond: 20, firstTokenMs: 100, estimated: true });
    expect(usage.speed()).toMatchObject({ estimated: true });
    chunk({ usage: { completion_tokens: 27 } });
    usage.finish();
    expect(usage.speed()).toEqual({ tokensPerSecond: 27, firstTokenMs: 100, estimated: false });
  });

  it("persists only five recent speed samples per model and provider", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vsemkod-g-speed-"));
    try {
      const path = join(scratch, "usage.json");
      const health = new ProviderHealth(path);
      for (const value of [100, 10, 20, 30, 40, 50]) health.recordSpeed("model", "numes", value);
      health.recordSpeed("model", "groq", 100);
      await health.flush();
      const reloaded = new ProviderHealth(path);
      await reloaded.load();
      expect(reloaded.speeds()).toEqual([
        { modelId: "model", providerId: "numes", tokensPerSecond: 30 }, { modelId: "model", providerId: "groq", tokensPerSecond: 100 }
      ]);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
