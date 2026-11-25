import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { mergeCatalog, stableJson } from "../src/merge.js";
import { notifyTelegram } from "../src/publish.js";
import { mergeRadar, radarChanged } from "../src/radar.js";
import { radarSchema } from "../src/schema.js";
import { parseOpenCodeZen } from "../src/sources/opencodeZen.js";
import { newState } from "../src/state.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/opencode-zen.json", import.meta.url), "utf8"));
const rows = parseOpenCodeZen(fixture);
const date = (days: number) => new Date(Date.UTC(2026, 10, 24 + days)).toISOString();

afterEach(() => vi.unstubAllGlobals());

it("читает Zen, оставляя суффикс -free и полностью нулевую цену", () => {
  expect(rows).toEqual([
    {
      source: "opencode-zen", id: "hungerg-free", name: "Hungerg Free",
      description: "Модель из тестового ответа.", contextWindow: 262144, tools: true, free: true,
    },
    {
      source: "opencode-zen", id: "big-pickle", name: "Big Pickle",
      description: "", contextWindow: 200000, tools: false, free: true,
    },
  ]);
  expect(() => parseOpenCodeZen({ data: [{ name: "Нет ID" }] })).toThrow();
});

it("сортирует радар и считает изменение только временных отметок несущественным", () => {
  const first = mergeRadar(undefined, rows, date(0), {});
  const reversed = mergeRadar(undefined, [...rows].reverse(), date(0), {});
  expect(stableJson(first.radar)).toBe(stableJson(reversed.radar));
  expect(radarSchema.parse(first.radar).models.map(({ id }) => id)).toEqual(["big-pickle", "hungerg-free"]);
  const next = mergeRadar(first.radar, rows, date(1), first.missingSince);
  expect(next.added).toEqual([]);
  expect(radarChanged(first.radar, next.radar)).toBe(false);
  const renamed = mergeRadar(first.radar, [{ ...rows[0], name: "Новое название" }, rows[1]], date(1), {});
  expect(radarChanged(first.radar, renamed.radar)).toBe(true);
});

it("сохраняет пропавшую модель на 30 дней и не уведомляет о возвращении в этот период", () => {
  const first = mergeRadar(undefined, rows, date(0), {});
  const missed = mergeRadar(first.radar, [rows[1]], date(40), {});
  expect(missed.radar.models[1]).toMatchObject({ active: false, lastSeen: date(0) });
  expect(missed.missingSince).toEqual({ "hungerg-free": date(40) });
  const stillMissing = mergeRadar(missed.radar, [rows[1]], date(69), missed.missingSince);
  expect(radarChanged(missed.radar, stillMissing.radar)).toBe(false);
  const removed = mergeRadar(missed.radar, [rows[1]], date(70), missed.missingSince);
  expect(removed.radar.models).toHaveLength(1);
  const back = mergeRadar(missed.radar, rows, date(45), missed.missingSince);
  expect(back.radar.models[1]).toMatchObject({ active: true, firstSeen: date(0), lastSeen: date(45) });
  expect(back.added).toEqual([]);
  expect(back.missingSince).toEqual({});
});

it("добавляет новости Zen к одному сообщению Telegram даже без событий каталога", async () => {
  const radar = mergeRadar(undefined, rows, date(0), {});
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  const { catalog } = mergeCatalog(undefined, newState(), [], {
    now: date(0), missingRuns: 6, retentionDays: 7, healthFailureThreshold: 2,
  });
  const config = { token: "test-token", chatId: "test-chat" };
  expect(await notifyTelegram(config, [], catalog, radar.added)).toBe(true);
  expect(await notifyTelegram(config, [], catalog, [])).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe(
    "Радар: в OpenCode Zen появилась бесплатная модель Big Pickle\n" +
    "Радар: в OpenCode Zen появилась бесплатная модель Hungerg Free",
  );
});
