import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, Hook, Schedule } from "../src/shared/api";
import type { AutomationHandler } from "../src/main/automation-store";
import { registerHooks, runHookCommand } from "../src/main/hooks";
import { missedRun, nextRun, registerSchedules, scheduleInput } from "../src/main/schedules";

const hour = 3_600_000;
const monday = new Date(2026, 10, 23, 9).getTime();
const daily = { type: "daily", time: "09:00", weekdays: [1, 5] } as const;
const weekdays = { ...daily, weekdays: [...daily.weekdays] };
const interval = { type: "interval", hours: 6 } as const;
let project: string;

beforeEach(async () => { project = await mkdtemp(join(tmpdir(), "vsemkod-k4-test-")); });
afterEach(async () => {
  vi.useRealTimers();
  await rm(project, { recursive: true, force: true });
});

function ipc() {
  const methods = new Map<string, (args: unknown[]) => unknown>();
  const handle: AutomationHandler = (channel, schema, fn) => {
    methods.set(channel, args => fn(schema.parse(args)));
  };
  return {
    handle,
    async call<T>(channel: string, ...args: unknown[]) { return await methods.get("automations:" + channel)!(args) as T; }
  };
}

describe("расписание", () => {
  it("выбирает следующий локальный день недели и отсчитывает интервал в часах", () => {
    expect(nextRun(weekdays, monday - 1)).toBe(monday);
    expect(nextRun(weekdays, monday)).toBe(new Date(2026, 10, 27, 9).getTime());
    expect(nextRun({ ...daily, weekdays: [] }, monday)).toBe(new Date(2026, 10, 24, 9).getTime());
    expect(nextRun(interval, monday)).toBe(monday + 6 * hour);
  });

  it("выбирает один недавний пропуск и пропускает запуск старше 12 часов", () => {
    const friday = new Date(2026, 10, 27, 9).getTime();
    expect(missedRun(weekdays, monday, friday + 12 * hour)).toBe(friday);
    expect(missedRun(weekdays, monday, friday + 12 * hour + 1)).toBeUndefined();
    expect(missedRun(interval, monday, monday + 19 * hour)).toBe(monday + 18 * hour);
    expect(missedRun(interval, monday, monday - 1)).toBeUndefined();
  });

  it("отклоняет доступ с подтверждением и неверное время при сохранении", () => {
    const input = { directory: project, name: "Проверка", prompt: "Ответь", when: weekdays, enabled: true };
    expect(scheduleInput.safeParse({ ...input, access: "ask" }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...input, access: "edit", when: { ...daily, time: "25:00" } }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...input, access: "read" }).success).toBe(true);
  });

  it("при старте запускает просроченную задачу, записывает результат и уведомляет", async () => {
    vi.setSystemTime(monday + hour);
    const transport = ipc();
    const path = join(project, "schedules.json");
    const task = { id: "f5ddcb8a-4481-45e1-8f42-507dcb088efa", name: "Проверка", directory: project,
      prompt: "Ответь", when: interval, nextRun: monday, enabled: true, access: "read" };
    await writeFile(path, JSON.stringify([task]));
    const create = vi.fn(async (directory: string, title: string) => ({ directory, title, id: "chat", updatedAt: Date.now() }));
    const send = vi.fn(async () => ({ stopped: false }));
    const announce = vi.fn();
    const schedules = await registerSchedules(transport.handle, path, { project() {}, create, send, announce, focus: vi.fn() });
    const stop = schedules.start();
    try {
      await vi.waitFor(() => expect(announce).toHaveBeenCalledOnce());
      expect(create).toHaveBeenCalledWith(project, expect.stringMatching(/^Проверка · /));
      expect(send).toHaveBeenCalledWith("chat", task);
      expect(await transport.call<Schedule[]>("schedules")).toMatchObject([{
        nextRun: monday + 7 * hour, lastRun: { at: monday + hour, sessionId: "chat", ok: true }
      }]);
    } finally {
      stop();
    }
  });

  it("пропускает повторный запуск занятой задачи и сохраняет ошибку недоступного проекта", async () => {
    const transport = ipc();
    const path = join(project, "schedules.json");
    let complete!: (value: { stopped: boolean }) => void;
    const response = new Promise<{ stopped: boolean }>(resolve => { complete = resolve; });
    const create = vi.fn(async (directory: string, title: string) => ({ directory, title, id: "chat", updatedAt: Date.now() }));
    const send = vi.fn(() => response);
    const announce = vi.fn();
    await registerSchedules(transport.handle, path, { project() {}, create, send, announce, focus: vi.fn() });
    const [task] = await transport.call<Schedule[]>("save-schedule", {
      name: "Проверка", directory: project, prompt: "Ответь", when: interval, enabled: true, access: "read"
    });
    const running = transport.call<Schedule[]>("run-schedule", task.id);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      await expect(transport.call("run-schedule", task.id)).rejects.toThrow("уже выполняется");
    } finally { complete({ stopped: false }); }
    await running;
    await transport.call("save-schedule", { ...task, directory: join(project, "нет") });
    expect(await transport.call("run-schedule", task.id)).toMatchObject([{ lastRun: { ok: false, error: "Папка проекта недоступна." } }]);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("хуки", () => {
  it("пропускает хук без файловых правок и для другого проекта", async () => {
    const transport = ipc();
    const execute = vi.fn(async () => ({ exitCode: 0, output: "" }));
    const hooks = await registerHooks(transport.handle, join(project, "hooks.json"), () => {}, vi.fn(), execute);
    await transport.call("save-hook", { name: "Тесты", command: "npm test", directory: project,
      onlyWhenFilesChanged: true, fixAttempts: 2, enabled: true });
    expect(await hooks.afterTurn("чат", project, false)).toBe("");
    expect(await hooks.afterTurn("чат", join(project, "другой"), true)).toBe("");
    expect(execute).not.toHaveBeenCalled();
    await hooks.afterTurn("чат", project, true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("отправляет текст сбоя с лимитом на чат и сбрасывает попытки после успеха и сообщения пользователя", async () => {
    const transport = ipc();
    const events: Extract<ChatEvent, { type: "hook" }>[] = [];
    let exitCode = 1;
    const execute = vi.fn(async () => ({ exitCode, output: "AssertionError" }));
    const hooks = await registerHooks(transport.handle, join(project, "hooks.json"), () => {}, event => events.push(event), execute);
    await transport.call("save-hook", { name: "Тесты", command: "npm test",
      onlyWhenFilesChanged: false, fixAttempts: 2, enabled: true });
    const run = (session = "чат") => hooks.afterTurn(session, project, false);
    const message = ["Команда `npm test` завершилась с ошибкой (код 1):", "```", "AssertionError", "```",
      "Найди причину, исправь и проверь снова."].join("\n");
    expect(await run()).toBe(message);
    expect(events.map(event => event.status)).toEqual(["running", "failed"]);
    expect(events.at(-1)).toMatchObject({ exitCode: 1, output: "AssertionError" });
    expect(await transport.call<Hook[]>("hooks")).toMatchObject([{ lastRun: { exitCode: 1, output: "AssertionError" } }]);
    expect(await run()).toBe(message);
    expect(await run()).toBe("");
    expect(await run("другой чат")).toBe(message);
    exitCode = 0;
    expect(await run()).toBe("");
    expect(events.at(-1)?.status).toBe("passed");
    exitCode = 1;
    expect(await run()).toBe(message);
    expect(await run()).toBe(message);
    expect(await run()).toBe("");
    hooks.reset("чат");
    expect(await run()).toBe(message);
  });

  it("сохраняет только хвост stdout и stderr, завершает зависший процесс", async () => {
    const output = await runHookCommand('node -e "process.stdout.write(\'x\'.repeat(9000)); process.stderr.write(\'tail\')"', project);
    expect(output.exitCode).toBe(0);
    expect(Buffer.byteLength(output.output, "utf8")).toBe(4096);
    expect(output.output).toContain("tail");
    const timeout = await runHookCommand('node -e "setTimeout(() => {}, 1000)"', project, 100);
    expect(timeout).toMatchObject({ exitCode: 124, output: expect.stringContaining("Превышено время") });
  });
});
