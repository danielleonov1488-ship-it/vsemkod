import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Conversation, Schedule, ScheduleWhen } from "../shared/api";
import { automationStore, replaceAutomation, type AutomationHandler } from "./automation-store";

const hour = 3_600_000;
const catchUp = 12 * hour;
const poll = 30_000;
const scheduleId = z.uuid();
const whenSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily"), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).transform(days => [...new Set(days)].sort()) }),
  z.object({ type: z.literal("interval"), hours: z.number().int().min(1).max(168) })
]);
export const scheduleInput = z.object({
  id: scheduleId.optional(),
  name: z.string().trim().min(1).max(90),
  directory: z.string().min(1).max(32_768).refine(isAbsolute),
  prompt: z.string().trim().min(1).max(100_000),
  when: whenSchema,
  access: z.enum(["read", "edit", "full"], { error: "Для задачи по расписанию выберите доступ без подтверждений." }),
  model: z.string().trim().min(1).max(514).optional(),
  enabled: z.boolean()
});
const scheduleList = z.array(scheduleInput.extend({
  id: scheduleId,
  nextRun: z.number().int().nonnegative().optional(),
  lastRun: z.object({ at: z.number(), sessionId: z.string().optional(), ok: z.boolean(), error: z.string().optional() }).optional()
}));

function dailyOccurrence(when: Extract<ScheduleWhen, { type: "daily" }>, from: number, direction: 1 | -1) {
  const [hours, minutes] = when.time.split(":").map(Number);
  const base = new Date(from);
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(base);
    date.setDate(base.getDate() + offset * direction);
    const day = date.getDay() || 7;
    if (when.weekdays.length && !when.weekdays.includes(day)) continue;
    const at = date.setHours(hours, minutes, 0, 0);
    if (direction === 1 ? at > from : at <= from) return at;
  }
  throw new Error("Не удалось вычислить время запуска.");
}

export function nextRun(when: ScheduleWhen, from: number): number {
  return when.type === "interval" ? from + when.hours * hour : dailyOccurrence(when, from, 1);
}

export function missedRun(when: ScheduleWhen, due: number, now: number): number | undefined {
  if (due > now) return undefined;
  const latest = when.type === "daily" ? dailyOccurrence(when, now, -1)
    : due + Math.floor((now - due) / (when.hours * hour)) * when.hours * hour;
  return latest >= due && now - latest <= catchUp ? latest : undefined;
}

function advancePast(when: ScheduleWhen, due: number, now: number) {
  const from = when.type === "daily" ? now : due + Math.floor((now - due) / (when.hours * hour)) * when.hours * hour;
  return nextRun(when, from);
}

const stamp = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
});

type ScheduleDependencies = {
  project(directory: string): void;
  create(directory: string, title: string): Promise<Conversation>;
  send(session: string, schedule: Schedule): Promise<{ stopped: boolean }>;
  announce(title: string, body: string, session?: string): void;
  focus(session: string): Promise<void>;
};

export async function registerSchedules(handle: AutomationHandler, path: string, deps: ScheduleDependencies) {
  const store = await automationStore(path, scheduleList);
  const running = new Set<string>();
  let closed = false;

  async function run(id: string, manual = false) {
    if (closed) return;
    let claimed: Schedule | undefined;
    let at = 0;
    await store.update(items => {
      if (closed) return items;
      at = Date.now();
      const item = items.find(item => item.id === id);
      if (!item) {
        if (manual) throw new Error("Задача не найдена.");
        return items;
      }
      if (!manual && (!item.enabled || (item.nextRun ?? Infinity) > at)) return items;
      const busy = running.has(id);
      if (manual && busy) throw new Error("Задача уже выполняется.");
      if (!busy && (manual || missedRun(item.when, item.nextRun!, at) !== undefined)) {
        claimed = item;
      }
      const next = claimed ? nextRun(item.when, at) : advancePast(item.when, item.nextRun ?? at, at);
      return replaceAutomation(items, { ...item, nextRun: item.enabled ? next : undefined });
    }).then(() => {
      if (claimed) running.add(id);
    });
    if (!claimed) return;

    const item: Schedule = claimed;
    let sessionId: string | undefined;
    let error: string | undefined;
    try {
      if (closed) return;
      deps.project(item.directory);
      const folder = await realpath(item.directory).catch(() => undefined);
      if (folder !== item.directory || !(await stat(folder).catch(() => undefined))?.isDirectory()) {
        throw new Error("Папка проекта недоступна.");
      }
      if (closed) return;
      sessionId = (await deps.create(item.directory, item.name + " · " + stamp.format(at))).id;
      if (closed) return;
      if ((await deps.send(sessionId, item)).stopped) throw new Error("Ответ остановлен.");
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      try {
        await store.update(items => {
          const latest = items.find(item => item.id === id);
          if (!latest || closed && !sessionId) return items;
          const now = Date.now();
          const due = latest.nextRun;
          const next = due !== undefined && due <= now ? advancePast(latest.when, due, now) : due;
          const reason = error ?? (closed ? "Приложение завершило работу." : undefined);
          return replaceAutomation(items, { ...latest, nextRun: next, lastRun: { at, sessionId, ok: reason === undefined, error: reason } });
        });
      } finally {
        running.delete(id);
      }
    }
    if (!closed) deps.announce((error ? "Не получилось: " : "Готово: ") + item.name,
      error ?? "Агент закончил работу.", sessionId);
  }

  handle("automations:schedules", z.tuple([]), () => store.list());
  handle("automations:save-schedule", z.tuple([scheduleInput]), ([input]) => {
    return store.update(items => {
      const previous = items.find(item => item.id === input.id);
      if (input.id && !previous) throw new Error("Задача не найдена.");
      if (!previous || previous.directory !== input.directory) deps.project(input.directory);
      const sameTime = previous?.enabled && JSON.stringify(previous.when) === JSON.stringify(input.when);
      return replaceAutomation(items, {
        ...input, id: input.id ?? randomUUID(), lastRun: previous?.lastRun,
        nextRun: input.enabled ? (sameTime ? previous.nextRun : undefined) ?? nextRun(input.when, Date.now()) : undefined
      });
    });
  });
  handle("automations:remove-schedule", z.tuple([scheduleId]), ([id]) => store.update(items => items.filter(item => item.id !== id)));
  handle("automations:run-schedule", z.tuple([scheduleId]), async ([id]) => {
    await run(id, true);
    return store.list();
  });
  handle("automations:open-chat", z.tuple([scheduleId]), async ([id]) => {
    const session = store.list().find(item => item.id === id)?.lastRun?.sessionId;
    if (!session) throw new Error("Чат запуска не найден.");
    await deps.focus(session);
  });

  const tick = () => {
    const now = Date.now();
    for (const item of store.list()) {
      if (item.enabled && item.nextRun !== undefined && item.nextRun <= now) {
        void run(item.id).catch(error => console.error("[schedules]", error));
      }
    }
  };
  return {
    start() {
      const timer = setInterval(tick, poll);
      timer.unref();
      tick();
      return () => { closed = true; clearInterval(timer); };
    }
  };
}
