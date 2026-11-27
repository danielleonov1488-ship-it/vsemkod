import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ChatEvent, Hook } from "../shared/api";
import { automationStore, replaceAutomation, type AutomationHandler } from "./automation-store";

const outputLimit = 4096;
const commandTimeout = 5 * 60_000;
const hookId = z.uuid();
const hookInput = z.object({
  id: hookId.optional(),
  name: z.string().trim().min(1).max(90),
  command: z.string().trim().min(1).max(16_384).refine(value => !value.includes("\0")),
  directory: z.string().min(1).max(32_768).refine(isAbsolute).optional(),
  onlyWhenFilesChanged: z.boolean(),
  fixAttempts: z.number().int().min(0).max(5),
  enabled: z.boolean()
});
const hookList = z.array(hookInput.extend({
  id: hookId,
  lastRun: z.object({ at: z.number(), exitCode: z.number(), output: z.string() }).optional()
}));

type CommandResult = { exitCode: number; output: string };

function stopCommand(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5000 },
      error => { if (error) child.kill(); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
}

export function runHookCommand(command: string, directory: string, timeout = commandTimeout, signal?: AbortSignal): Promise<CommandResult> {
  if (signal?.aborted) return Promise.resolve({ exitCode: 130, output: "Команда остановлена." });
  return new Promise(resolve => {
    const child = spawn(command, {
      cwd: directory, shell: process.platform === "win32" ? true : "sh",
      detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let tail = Buffer.alloc(0);
    let failure: { code: number; text: string } | undefined;
    let settled = false;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer) => {
      const end = chunk.subarray(-outputLimit);
      tail = Buffer.concat([tail.subarray(Math.max(0, tail.length + end.length - outputLimit)), end]);
    };
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killDeadline);
      signal?.removeEventListener("abort", abort);
      if (failure) append(Buffer.from("\n" + failure.text));
      let start = 0;
      while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
      resolve({ exitCode: failure?.code ?? exitCode, output: tail.toString("utf8", start).trimEnd() });
    };
    const interrupt = (code: number, text: string) => {
      if (failure !== undefined) return;
      failure = { code, text };
      killDeadline = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(code);
      }, 5500);
      stopCommand(child);
    };
    const abort = () => interrupt(130, "Команда остановлена.");
    const timer = setTimeout(() => interrupt(124, "Превышено время выполнения команды."), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", error => { append(Buffer.from("\n" + error.message)); finish(1); });
    child.once("close", code => finish(code ?? 1));
  });
}

function repairPrompt(command: string, result: CommandResult) {
  const longest = (text: string) => Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const code = "`".repeat(longest(command) + 1);
  const fence = "`".repeat(Math.max(3, longest(result.output) + 1));
  return [
    "Команда " + code + command + code + " завершилась с ошибкой (код " + result.exitCode + "):",
    fence, result.output, fence, "Найди причину, исправь и проверь снова."
  ].join("\n");
}

export async function registerHooks(handle: AutomationHandler, path: string, project: (directory: string) => void,
  emit: (event: Extract<ChatEvent, { type: "hook" }>) => void, execute = runHookCommand) {
  const store = await automationStore(path, hookList);
  const attempts = new Map<string, Map<string, number>>();
  handle("automations:hooks", z.tuple([]), () => store.list());
  handle("automations:save-hook", z.tuple([hookInput]), ([input]) => store.update(items => {
    const previous = items.find(item => item.id === input.id);
    if (input.id && !previous) throw new Error("Хук не найден.");
    if (input.directory && input.directory !== previous?.directory) project(input.directory);
    const sameCommand = previous?.command === input.command && previous.directory === input.directory;
    return replaceAutomation(items, { ...input, id: input.id ?? randomUUID(), lastRun: sameCommand ? previous.lastRun : undefined });
  }));
  handle("automations:remove-hook", z.tuple([hookId]), async ([id]) => {
    const items = await store.update(items => items.filter(item => item.id !== id));
    for (const [session, counts] of attempts) {
      counts.delete(id);
      if (!counts.size) attempts.delete(session);
    }
    return items;
  });

  return {
    reset: (session: string) => { attempts.delete(session); },
    async afterTurn(session: string, directory: string, changed: boolean, signal?: AbortSignal) {
      const prompts: string[] = [];
      const counts = attempts.get(session) ?? new Map<string, number>();
      const matches = (hook: Hook) => hook.enabled && (!hook.directory || hook.directory === directory) &&
        (changed || !hook.onlyWhenFilesChanged);
      for (const hook of store.list().filter(matches)) {
        if (signal?.aborted) break;
        if (!store.list().some(current => current.id === hook.id && current.command === hook.command && matches(current))) continue;
        const at = Date.now();
        const event = { type: "hook" as const, sessionId: session, hook: hook.name, command: hook.command };
        emit({ ...event, status: "running" });
        const result = await execute(hook.command, directory, commandTimeout, signal)
          .catch(error => ({ exitCode: 1, output: String(error) }));
        await store.update(items => {
          const current = items.find(item => item.id === hook.id && item.command === hook.command && item.directory === hook.directory);
          return current && (!current.lastRun || current.lastRun.at <= at)
            ? replaceAutomation(items, { ...current, lastRun: { at, ...result } }) : items;
        }).catch(error => console.error("[hooks]", error));
        emit({ ...event, ...result, status: result.exitCode === 0 ? "passed" : "failed" });
        const current = store.list().find(item => item.id === hook.id && item.command === hook.command &&
          item.directory === hook.directory && item.enabled);
        const used = counts.get(hook.id) ?? 0;
        if (result.exitCode === 0) counts.delete(hook.id);
        else if (!signal?.aborted && current && used < current.fixAttempts) {
          counts.set(hook.id, used + 1);
          prompts.push(repairPrompt(hook.command, result));
        }
      }
      if (counts.size) attempts.set(session, counts);
      else attempts.delete(session);
      return prompts.join("\n\n");
    }
  };
}
