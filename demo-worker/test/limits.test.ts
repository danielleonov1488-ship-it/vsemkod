import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalQuota, IpLimits, LEASE_MS } from "../src/limits";
import { DAY } from "../src/token";
import { MemoryStorage } from "./workers-mock";

const day = Date.UTC(2026, 10, 25);
const noon = day + DAY / 2;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(noon); });
afterEach(() => { vi.useRealTimers(); });

describe("Durable Object на IP", () => {
  it("пропускает только один одновременный стрим и отклоняет чужой release", async () => {
    const storage = new MemoryStorage();
    const limits = new IpLimits({ storage } as never, {});
    const [first, second] = await Promise.all([limits.start(day, "first", []), limits.start(day, "second", [])]);
    expect(first).toEqual({ remaining: 29 });
    expect(second).toEqual({ code: "busy" });
    limits.release("second");
    expect(await limits.start(day, "third", [])).toEqual({ code: "busy" });
    vi.setSystemTime(noon + LEASE_MS);
    expect(await limits.start(day, "third", [])).toEqual({ remaining: 28 });
    limits.release("first");
    expect(await limits.start(day, "fourth", [])).toEqual({ code: "busy" });
  });

  it("ограничивает скользящую минуту, 30 сообщений и 10 сессий за UTC-сутки", async () => {
    const storage = new MemoryStorage();
    const limits = new IpLimits({ storage } as never, {});
    for (let number = 1; number <= 30; number++) {
      const id = String(number);
      expect(await limits.start(day, id, [])).toEqual({ remaining: 30 - number });
      limits.release(id);
      if (number % 6 === 0) {
        expect(await limits.start(day, "over-minute", [])).toEqual({ code: "limit" });
        vi.setSystemTime(Date.now() + 60_000);
      }
    }
    expect(await limits.start(day, "over-day", [])).toEqual({ code: "limit" });
    for (let number = 0; number < 10; number++) expect(await limits.session(day)).toEqual({ remaining: 0 });
    expect(await limits.session(day)).toEqual({ code: "limit" });
    expect(storage.alarm).toBe(day + DAY + LEASE_MS);
    await limits.alarm();
    expect(storage.values.size).toBe(0);
  });

  it("учитывает предыдущий день для блокировки стрима и скользящей минуты", async () => {
    const old = new IpLimits({ storage: new MemoryStorage() } as never, {});
    const fresh = new IpLimits({ storage: new MemoryStorage() } as never, {});
    vi.setSystemTime(day + DAY - 10_000);
    for (let count = 0; count < 6; count++) {
      expect(await old.start(day, "old", [])).toEqual({ remaining: 29 - count });
      if (count < 5) old.release("old");
    }
    vi.setSystemTime(day + DAY);
    expect(old.holdPrevious("first")).toEqual({ code: "busy" });
    old.release("old");
    const hold = old.holdPrevious("first");
    expect(await fresh.start(day + DAY, "first", hold.recent ?? [])).toEqual({ code: "limit" });
    old.release("first");
    vi.setSystemTime(day + DAY + 50_000);
    expect(await fresh.start(day + DAY, "second", hold.recent ?? [])).toEqual({ remaining: 29 });
  });
});

it("глобальная квота действует до 00:00 UTC и очищается alarm", async () => {
  const storage = new MemoryStorage();
  const quota = new GlobalQuota({ storage } as never, {});
  expect(quota.isOpen()).toBe(true);
  await quota.close(day);
  expect(quota.isOpen()).toBe(false);
  expect(storage.alarm).toBe(day + DAY);
  vi.setSystemTime(day + DAY);
  expect(quota.isOpen()).toBe(true);
  await quota.close(day);
  expect(quota.isOpen()).toBe(true);
  await quota.alarm();
  expect(storage.values.size).toBe(0);
});
