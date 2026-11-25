import type { ChatPart, FileChange } from "../shared/api";
import { type createDemo, type ScriptTurn } from "./demo-api";

const change: FileChange = {
  file: "src/theme.ts", additions: 2, deletions: 1, status: "modified",
  patch: "--- a/src/theme.ts\n+++ b/src/theme.ts\n@@ -1,2 +1,3 @@\n export type Theme = \"light\" | \"dark\";\n-export const defaultTheme: Theme = \"dark\";\n+const key = \"demo-theme\";\n+export const defaultTheme = localStorage.getItem(key) === \"light\" ? \"light\" : \"dark\";"
};
type Event = Parameters<Parameters<ScriptTurn>[0]>[0];
type Step = { click: string; text?: string } | { send: string; events: Event[] };

function tool(id: string, name: string, target: string, extra?: Partial<Extract<ChatPart, { kind: "tool" }>>): Event {
  return { type: "part", part: { id, kind: "tool", tool: name, target, status: "completed", ...extra } };
}
function reply(text: string): Event {
  return { type: "delta", partId: "answer", delta: text };
}

const edit: Step = {
  send: "Добавь выбор темы и запоминай его между запусками.",
  events: [
    tool("read", "read", "src/theme.ts"), tool("edit", "edit", change.file, { diff: change }),
    tool("test", "shell", "npm test", { output: "Tests: 17 passed" }),
    reply("Готово. Тема запоминается между запусками. Все 17 тестов прошли.")
  ]
};
const panel = { click: 'button[aria-label="Правая панель"]' };
const scenarios: Record<string, Step[]> = {
  edit: [edit, panel, { click: ".panel-diff summary" }],
  revert: [edit, {
    send: "Поставь светлую тему по умолчанию.",
    events: [tool("edit", "edit", change.file, { diff: change }), reply("Готово. Светлая тема установлена по умолчанию.")]
  }, { click: ".user-turn .message-actions button", text: "Откатить сюда" }],
  modes: [
    { click: "button.access-chip" }, { click: "button.access-chip" }, { click: "button.access-chip" },
    { send: "Составь план переключения темы.", events: [reply("1. Добавить переключатель в настройки.\n2. Сохранять выбор.\n3. Проверить обе темы.")] },
    { send: "Выполни план", events: edit.events }
  ],
  failover: [{
    send: "Проверь, как сохраняется выбранная тема.",
    events: [
      { type: "route", modelId: "browser:glm", previousModelId: "browser:example", providerId: "kilo", averageMs: 480, reason: "quota" },
      tool("read", "read", "src/theme.ts"), reply("Проверил. Выбранная тема сохранится после перезапуска.")
    ]
  }],
  subscriptions: [
    { click: ".model-picker > summary" },
    { click: ".model-picker .subscription-link" },
    { click: '.settings-panel button[aria-label^="Подключить "]' },
    { click: ".harness-dialog button", text: "Закрыть" }
  ],
  mcp: [
    { click: ".sidebar-end button" },
    { click: ".settings-nav button", text: "MCP-серверы" },
    { click: ".settings-nav button", text: "Навыки" }
  ],
  todo: [{
    send: "Разбей настройку темы на шаги и уточни, какую тему выбрать.",
    events: [
      tool("todo", "todowrite", "", { todos: [
        { content: "Проверить настройки", status: "completed" },
        { content: "Уточнить тему по умолчанию", status: "in_progress" },
        { content: "Добавить переключатель", status: "pending" }
      ] }),
      { type: "question", question: { id: "theme", title: "Какую тему поставить по умолчанию?", fields: [
        { type: "string", key: "theme", title: "Тема", options: [{ value: "dark", label: "Тёмная" }, { value: "light", label: "Светлая" }] }
      ] } },
      { type: "question-resolved", id: "theme" }, reply("Выбрана тёмная тема. Добавлю переключатель в настройки.")
    ]
  }]
};

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function runScenarios(root: HTMLElement, demo: ReturnType<typeof createDemo>) {
  let active = "";
  let controller: AbortController | undefined;
  let playback: Promise<void> | undefined;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  // Scripted confirmations only affect this isolated, in-memory preview.
  window.confirm = () => true;

  async function find<T extends HTMLElement>(selector: string, signal: AbortSignal, text?: string) {
    const deadline = Date.now() + 8000;
    while (!signal.aborted && Date.now() < deadline) {
      const match = [...document.querySelectorAll<T>(selector)].find(node => !node.matches(":disabled") && (!text || node.textContent?.trim() === text));
      if (match) return match;
      await wait(50, signal);
    }
    signal.throwIfAborted();
    throw new Error("Сценарий не нашёл элемент " + selector);
  }

  async function play(steps: Step[], signal: AbortSignal) {
    await find(".sidebar .group-name", signal);
    while (!signal.aborted) {
      document.querySelector<HTMLDialogElement>(".harness-dialog[open]")?.close();
      root.querySelector<HTMLButtonElement>(".workspace-panel:not([hidden]) .panel-heading > button")?.click();
      (await find(".sidebar-row--new", signal)).click();
      await wait(80, signal);
      for (const step of steps) {
        if ("click" in step) {
          (await find(step.click, signal, step.text)).click();
          await wait(reduced.matches ? 120 : 1250, signal);
          continue;
        }
        demo.setScript(async (emit, turnSignal) => {
          const combined = AbortSignal.any([signal, turnSignal]);
          const events = step.events.map((event): Event => {
            if (event.type === "delta") return { ...event, partId: crypto.randomUUID() };
            if (event.type === "part") return { ...event, part: { ...event.part, id: crypto.randomUUID() } };
            return event;
          });
          for (const event of events) {
            await wait(reduced.matches ? 0 : event.type === "question-resolved" ? 2700 : 520, combined);
            emit(event);
          }
          return events.flatMap(event => event.type === "part" && event.part.kind === "tool" && event.part.diff ? [event.part.diff] : []);
        });
        if (step.send === "Выполни план") (await find(".plan-card .small-button", signal)).click();
        else {
          const input = await find<HTMLTextAreaElement>(".composer-input", signal);
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, step.send);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await wait(40, signal);
          input.form?.requestSubmit();
        }
        await wait(100, signal);
        await find(".sidebar-row--new", signal);
        if (step.send === "Составь план переключения темы.") await wait(reduced.matches ? 0 : 1400, signal);
      }
      if (reduced.matches) return;
      await wait(6000, signal);
      while (document.hidden) await wait(500, signal);
    }
  }

  return (id: string) => {
    if (!Object.hasOwn(scenarios, id)) id = "edit";
    if (active === id) return;
    active = id;
    controller?.abort();
    demo.stopScript();
    const signal = (controller = new AbortController()).signal;
    playback = (playback ?? Promise.resolve()).then(() => play(scenarios[id], signal)).catch(error => {
      if (!signal.aborted) console.error(error);
    });
  };
}
