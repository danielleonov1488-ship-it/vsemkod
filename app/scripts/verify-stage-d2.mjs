import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "screenshots");
const renderer = join(root, "out", "renderer");
const catalog = JSON.parse(await readFile(join(root, "resources", "catalog.json"), "utf8"));
await mkdir(output, { recursive: true });
const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  const path = resolve(renderer, "." + new URL(request.url, "http://localhost").pathname.replace(/^\/$/, "/index.html"));
  if (!path.startsWith(renderer + sep)) return response.writeHead(404).end();
  try { response.writeHead(200, { "content-type": contentTypes[extname(path)] }).end(await readFile(path)); }
  catch { response.end(); }
});

function mockDesktop({ catalog, theme }) {
  const noop = () => () => {};
  const directory = "C:/Projects/coffee-landing";
  const second = "C:/Projects/telegram-bot";
  const selectedFolder = "C:/Projects/notes";
  const timeoutMessage = "Модель не прислала ни одного токена за 2 минуты. Повторите запрос или смените модель.";
  const state = { catalog, connected: ["kilo"], personal: [], subscriptions: [], personalModels: [], zenModels: [],
    latencies: [{ modelId: "nemotron-3.5-lightning", providerId: "kilo", averageMs: 2100 }] };
  const sessions = [
    { id: "landing", title: "Лендинг для кофейни", directory, updatedAt: 100 },
    { id: "menu", title: "Форма заказа", directory, updatedAt: 90 },
    { id: "bot", title: "Бот для Telegram", directory: second, updatedAt: 80 }
  ];
  const preferences = { directory, theme, defaultAccess: "ask", fontSize: "normal", auto: true };
  const histories = new Map(sessions.map(chat => [chat.id, []]));
  const listeners = new Set();
  let current;
  let picks = 0;
  function emit(event) {
    for (const callback of listeners) callback({ ...event, sessionId: current.session });
  }
  function part(value) {
    const parts = histories.get(current.session);
    const index = parts.findIndex(item => item.id === value.id);
    if (index < 0) parts.push(value);
    else parts[index] = value;
    emit({ type: "part", part: value });
  }
  function pulse(kind, id, delta) {
    const parts = histories.get(current.session);
    const existing = parts.find(item => item.id === id);
    if (existing) existing.text += delta;
    else parts.push({ id, kind, text: delta });
    emit({ type: "model-wait", since: Date.now() });
    emit({ type: "delta", kind, partId: id, delta });
  }
  const tool = (id, tool, target, status, extras) => part({ id, kind: "tool", tool, target, status, ...extras });
  const change = { file: "hello.txt", patch: "@@ -0,0 +1 @@\n+Привет!", additions: 1, deletions: 0, status: "added" };
  window.d2 = {
    sent: [],
    reason() {
      pulse("reasoning", "r" + current.number, "Запишу приветствие в hello.txt.\n");
      pulse("reasoning", "r" + current.number, "После записи прочитаю файл и сверю содержимое.\nЗатем проверю тесты.");
    },
    work() {
      tool("write", "write", "hello.txt", "completed", { diff: change });
      tool("read", "read", "hello.txt", "completed");
      tool("shell", "shell", "npm test", "running");
      emit({ type: "model-wait", since: null });
    },
    approve() {
      emit({ type: "permission", permission: { id: "p", action: "shell", resources: ["npm test"] } });
    },
    respond() {
      tool("shell", "shell", "npm test", "completed", { output: "Tests  17 passed" });
      pulse("text", "answer", "Готово. ");
    },
    finish() {
      pulse("text", "answer", "Создал hello.txt, прочитал «Привет!». Все 17 тестов прошли.");
      this.done(false);
    },
    done(stopped) {
      clearTimeout(current.timer);
      histories.get(current.session).push({ id: "end" + current.number, kind: "turn", seconds: 72, stopped });
      current.resolve({ changes: [change], stopped });
    },
    fallback() {
      emit({ type: "route", modelId: "ernie-5.5-flash-preview", providerId: "kilo", previousModelId: "beam-free",
        previousProviderId: "kilo", averageMs: 1850, reason: "quota" });
    }
  };
  window.vsemkod = {
    initial: async () => ({ ...state, preferences, projects: JSON.parse(sessionStorage.getItem("d2-projects") ?? "[]"), version: "0.1.0" }),
    sessions: async () => sessions,
    history: async id => ({ parts: structuredClone(histories.get(id)), changes: [] }),
    create: async (directory, title) => {
      const chat = { id: "new-" + sessions.length, directory, title, updatedAt: Date.now() };
      sessions.push(chat);
      histories.set(chat.id, []);
      return chat;
    },
    send: (session, text, model) => new Promise((resolve, reject) => {
      const number = window.d2.sent.push({ text, model });
      current = { resolve, session, number };
      histories.get(session).push({ id: "user" + number, kind: "user", text });
      emit({ type: "model-wait", since: Date.now() });
      if (text === "Медленный запрос" && number === 2) current.timer = setTimeout(() => reject(new Error(timeoutMessage)), 120_000);
    }),
    stop: async () => window.d2.done(true),
    answer: async () => emit({ type: "permission-resolved", id: "p" }),
    chooseDirectory: async () => {
      const chosen = picks++ ? null : selectedFolder;
      if (chosen) sessionStorage.setItem("d2-projects", JSON.stringify([chosen]));
      return chosen;
    },
    chooseFiles: async () => [{ id: "a1", name: "notes.txt", image: false }],
    tools: async () => ({ commands: [], skills: [] }),
    findFiles: async () => [{ path: "hello.txt", type: "file" }],
    modelVariants: async () => [],
    onChat: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    onCatalog: noop, onNotice: noop, onUpdate: noop, onTerminal: noop
  };
}

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch();
  const errors = [];
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: theme });
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.install();
    await page.addInitScript(mockDesktop, { catalog, theme });
    await page.goto(address);
    const shot = name => page.screenshot({ path: join(output, "d2-" + theme + "-" + name + ".png"), animations: "disabled" });
    const composer = page.getByRole("textbox", { name: "Сообщение агенту" });
    const chat = page.locator(".chat-heading");
    const sidebar = page.getByRole("navigation", { name: "Чаты по проектам" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "Добавить проект" }).click();
    await expect(sidebar.getByRole("button", { name: "notes", exact: true })).toHaveAttribute("aria-current", "true");
    await shot("projects");
    await sidebar.getByRole("button", { name: "Новый чат в проекте notes" }).click();
    await page.getByRole("button", { name: "Проект · notes" }).click();
    const projectPicker = page.getByRole("region", { name: "Выбор проекта" });
    await projectPicker.getByRole("button", { name: "Выбрать папку…" }).click();
    await expect(sidebar.getByRole("button", { name: "notes", exact: true })).toHaveAttribute("aria-current", "true");
    await page.reload();
    await expect(sidebar.getByRole("button", { name: "notes", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Проект · coffee-landing" }).click();
    await projectPicker.getByRole("button", { name: "telegram-bot" }).click();
    await expect(sidebar.getByRole("button", { name: "telegram-bot", exact: true })).toHaveAttribute("aria-current", "true");

    await sidebar.getByRole("button", { name: "Лендинг для кофейни", exact: true }).click();
    const plus = page.getByRole("button", { name: "Добавить в сообщение" });
    await plus.click();
    await shot("composer-menu");
    await page.getByRole("button", { name: "Прикрепить файлы или картинки" }).click();
    await expect(page.getByRole("button", { name: "Убрать notes.txt" })).toBeVisible();
    await page.getByRole("button", { name: "Убрать notes.txt" }).click();
    await plus.click();
    await page.getByRole("button", { name: "Упомянуть файл (@)" }).click();
    await page.getByRole("option", { name: "hello.txt" }).click();
    await expect(composer).toHaveValue("@hello.txt ");
    await plus.click();
    await page.getByRole("button", { name: "Команды (/)" }).click();
    await expect(page.getByRole("listbox", { name: "Список команд" })).toBeVisible();
    await composer.press("Escape");

    await composer.fill("Создай hello.txt, прочитай его и проверь тесты.");
    await composer.press("Enter");
    await expect(chat.getByText("Агент работает")).toBeVisible();
    await expect(sidebar.getByRole("img", { name: "Агент работает" })).toBeVisible();
    await expect(page.getByText("Думает…")).toBeVisible();
    await page.clock.fastForward(4000);
    await expect(page.locator(".turn-line time")).toHaveText("4 с");
    await page.evaluate(() => { window.d2.reason(); window.d2.work(); });
    const reason = page.getByRole("button", { name: "Рассуждения" });
    await expect(reason).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".reasoning-preview")).toContainText("Затем проверю тесты");
    await reason.click();
    await expect(reason).toHaveAttribute("aria-expanded", "true");
    await reason.click();
    await expect(page.locator(".action").filter({ hasText: "Запускает npm test" }).locator(".action-spinner")).toBeVisible();
    await shot("running");
    await page.evaluate(() => window.d2.approve());
    await expect(chat.getByText("Ждёт разрешения")).toBeVisible();
    await expect(sidebar.getByRole("img", { name: "Ждёт разрешения" })).toBeVisible();
    await page.getByRole("button", { name: "Разрешить", exact: true }).click();
    await page.evaluate(() => window.d2.respond());
    await expect(page.getByText("Готово.", { exact: true })).toBeVisible();
    await page.evaluate(() => window.d2.finish());
    await expect(page.locator(".turn-summary")).not.toHaveAttribute("open");
    await expect(page.getByText(/Работал 1 мин 12 с.*3 действия/)).toBeVisible();
    await expect(page.getByText(/Все 17 тестов прошли/)).toBeVisible();
    await shot("collapsed");
    await page.locator(".turn-summary > summary").click();
    await expect(page.getByText("· 17 пройдено")).toBeVisible();
    await page.locator(".turn-summary summary.action").filter({ hasText: "Создал" }).click();
    await expect(page.getByLabel("Изменения в hello.txt")).toBeVisible();
    await page.locator(".turn-summary > summary").click();

    await composer.fill("Медленный запрос");
    await composer.press("Enter");
    await expect(page.getByText("Думает…")).toBeVisible();
    await page.clock.fastForward(19_000);
    await expect(page.getByText(/Модель думает дольше обычного/)).toBeHidden();
    await page.clock.fastForward(1000);
    await expect(page.locator(".model-wait")).toBeInViewport({ ratio: 1 });
    await shot("slow-model");
    await page.getByRole("button", { name: "Сменить модель" }).click();
    const models = page.getByRole("region", { name: "Выбор модели" });
    await expect(models.getByText("~2 с")).toBeVisible();
    await models.getByText("Новые", { exact: false }).click();
    await models.getByRole("button", { name: /Beam/ }).click();
    await page.clock.fastForward(100_000);
    await expect(page.getByRole("alert")).toContainText("Модель не прислала ни одного токена за 2 минуты");
    await expect(chat.getByText("Ошибка")).toBeVisible();
    await expect(sidebar.getByRole("img", { name: "Ошибка" })).toBeVisible();
    const failure = page.locator(".turn-failure");
    await expect(failure.getByRole("button", { name: "Сменить модель" })).toBeVisible();
    await shot("timeout");
    await failure.getByRole("button", { name: "Повторить" }).click();
    await expect.poll(() => page.evaluate(() => window.d2.sent.map(turn => turn.model))).toEqual([
      "nemotron-3.5-lightning", "nemotron-3.5-lightning", "beam-free"
    ]);
    await page.evaluate(() => window.d2.fallback());
    await expect(page.getByRole("status").filter({ hasText: "кончилась квота" })).toContainText("Переключился на");
    await page.getByRole("button", { name: "Стоп" }).click();
    await expect(page.getByRole("button", { name: "Стоп" })).toBeHidden();
    await page.setViewportSize({ width: 780, height: 560 });
    const toolbar = page.locator(".composer-toolbar");
    await expect.poll(() => toolbar.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Этап D2 проверен в Chromium в обеих темах. Сохранено 12 снимков.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
