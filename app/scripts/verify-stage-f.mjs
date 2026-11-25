import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const renderer = join(root, "out", "renderer");
const output = process.env.VSEMKOD_STAGE_F_SCREENSHOTS ?? join(root, "screenshots");
const catalog = JSON.parse(await readFile(join(root, "resources", "catalog.json"), "utf8"));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname.replace(/^\/$/, "/index.html");
  const path = resolve(renderer, "." + pathname);
  if (!path.startsWith(renderer + sep)) return response.writeHead(404).end();
  try {
    const bytes = await readFile(path);
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(bytes);
  } catch { response.writeHead(404).end(); }
});

function mockDesktop({ catalog, theme, demo }) {
  const modelId = "nemotron-3.5-lightning";
  const directory = "C:/Projects/Очень длинное название рабочей папки проекта";
  const session = { id: "stage-f", title: "Демонстрация этапа F", directory, modelId, variant: "medium", updatedAt: Date.now() };
  const preferences = { directory, theme, fontSize: "normal", auto: true, defaultAccess: "ask", busyEnter: "queue", panelWidth: 360 };
  const state = { catalog, connected: ["kilo", "openrouter", "groq"], personal: [], subscriptions: ["openai"], personalModels: [], zenModels: [] };
  const stats = {
    kilo: { requests: { limit: 200, remaining: 183, period: "hour", resetAt: Date.now() + 34 * 60_000, source: "local" } },
    openrouter: { requests: { limit: 50, remaining: 37, period: "day", source: "headers" },
      credits: { usage: 2.5, limit: 10, isFreeTier: false } },
    groq: { requests: { limit: 1000, remaining: 940, period: "day", source: "headers" } }
  };
  const parts = [];
  let usage;
  const listeners = new Set();
  const statsListeners = new Set();
  const emit = event => listeners.forEach(callback => callback({ ...event, sessionId: session.id }));
  const listen = collection => callback => { collection.add(callback); return () => collection.delete(callback); };
  const noop = () => () => {};
  const sends = [];
  const opened = [];
  window.stageF = { sends, opened, emit, updateStats() {
    stats.kilo.requests.remaining = 12;
    statsListeners.forEach(callback => callback(structuredClone(stats)));
  }, amber() {
    stats.kilo.requests.remaining = 60;
    statsListeners.forEach(callback => callback(structuredClone(stats)));
  } };
  window.vsemkod = {
    initial: async () => ({ ...state, preferences, projects: [directory], version: "0.1.0" }),
    sessions: async () => [session],
    history: async () => ({ parts: structuredClone(parts), changes: [], usage }),
    send: async (id, text, modelId, files, options) => {
      sends.push({ id, text, modelId, files, options });
      if (!options.compact) {
        parts.push({ id: "prompt", kind: "user", text },
          { id: "answer", kind: "text", text: "В нижней строке доступны скорость ответа, кэш, контекст и лимиты провайдера." });
        usage = { input: 1300, output: 1700, reasoning: 300, cache: { read: 8700, write: 0 }, context: 200_000 };
        emit({ type: "usage", usage, speed: { tokensPerSecond: 42, firstTokenMs: 1200 } });
        emit({ type: "reply-cache", cachePercent: 87 });
      } else parts.push({ id: "compact", kind: "note", text: "Контекст сжат" });
      return { changes: [] };
    },
    tools: async () => ({ commands: [], skills: [] }),
    modelVariants: async () => ["low", "medium", "high"],
    onChat: listen(listeners), onCatalog: noop, onNotice: noop, onUpdate: noop, onTerminal: noop, onConnect: noop,
    cancelConnection: async () => {},
    watchClipboard: async () => {},
    disconnect: async id => ({ ...state, connected: state.connected = state.connected.filter(provider => provider !== id) }),
    openExternal: async url => { opened.push(url); },
    ...(demo ? { onDemoQuota: callback => { callback(3); return () => {}; } }
      : { routerStats: async () => structuredClone(stats), onRouterStats: listen(statsListeners) }),
    voice: {
      status: async () => ({ models: { accurate: { installed: 0, partial: 0 }, fast: { installed: 0, partial: 0 } }, vadInstalled: false }),
      subscribe: noop
    }
  };
}

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
const errors = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.VSEMKOD_CHROMIUM });
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: theme });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(mockDesktop, { catalog, theme });
    await page.goto(url);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "Демонстрация этапа F", exact: true }).click();
    const row = page.locator(".composer-status");
    const composer = page.getByRole("textbox", { name: "Сообщение агенту" });
    const shot = name => page.screenshot({ path: join(output, "f-" + theme + "-" + name + ".png"), animations: "disabled" });
    const send = page.getByRole("button", { name: "Отправить", exact: true });
    const model = page.getByLabel("Модель · Nemotron 3.5 Lightning");
    const limits = row.getByRole("button", { name: /Kilo · 183/ });
    await expect(row).not.toContainText("ток/с");
    await expect(limits).toBeVisible();
    await expect(row).toHaveCSS("height", "24px");
    await expect(row).toHaveCSS("font-size", "12px");
    await model.click();
    const reasoning = page.getByRole("button", { name: "Рассуждения: средне" });
    await expect(reasoning).toBeVisible();
    await reasoning.click();
    await expect(page.getByRole("region", { name: "Уровень рассуждений" })).toBeVisible();
    await page.getByRole("button", { name: "Высокий", exact: true }).click();
    await page.keyboard.press("Escape");

    await composer.fill("Покажи статистику последнего ответа.");
    await send.click();
    await expect(row.getByText("42 ток/с")).toBeVisible();
    await expect(row.getByText("Кэш 87%")).toBeVisible();
    assert.equal(await page.evaluate(() => window.stageF.sends[0].options.variant), "high");
    await page.mouse.move(4, 4);
    await shot("status");

    const context = row.getByRole("button", { name: "Контекст 6%" });
    for (const [name, metric, snippet] of [
      ["speed", row.locator(".metric-wrap--speed .status-metric"), "Первый токен пришёл через 1,2 с."],
      ["cache", row.locator(".metric-wrap--cache .status-metric"), "87% запроса взято из кэша провайдера"],
      ["context", context, "6% окна модели занято"],
      ["limits", limits, "Сброс через 34 мин."]
    ]) {
      await metric.hover();
      const tooltip = row.getByRole("tooltip");
      await expect(tooltip).toContainText(snippet);
      await shot("tooltip-" + name);
    }
    await page.mouse.move(4, 4);
    await row.locator(".metric-wrap--speed .status-metric").focus();
    await page.keyboard.press("Tab");
    await expect(row.getByRole("tooltip")).toContainText("87% запроса");
    await page.keyboard.press("Escape");
    await expect(row.getByRole("tooltip")).toHaveCount(0);

    await context.click();
    const contextPanel = page.getByRole("region", { name: "Контекст", exact: true });
    await expect(contextPanel.getByRole("heading")).toHaveText("Контекст · 6%");
    await expect(contextPanel).toContainText("Кэш (чтение/запись)");
    await shot("context");
    await page.keyboard.press("Escape");
    await composer.fill("Черновик сохраняется");
    await context.click();
    await contextPanel.getByRole("button", { name: "Сжать контекст" }).click();
    await expect(composer).toHaveValue("Черновик сохраняется");
    assert.equal(await page.evaluate(() => window.stageF.sends[1].options.compact), true);
    await composer.fill("");
    await expect(send).toBeVisible();

    await limits.click();
    const limitsPanel = page.getByRole("region", { name: "Подписки и лимиты" });
    await expect(limitsPanel).toContainText("Можно подключить");
    await expect(limitsPanel).toContainText("По нашим подсчётам");
    await expect(limitsPanel).toContainText("Кредиты ключа: 2,5 из 10 USD");
    await expect(limitsPanel).toHaveCSS("width", "360px");
    await shot("limits");
    await limitsPanel.getByRole("button", { name: "Действия · Kilo Gateway" }).click();
    await expect(limitsPanel.getByRole("button", { name: "Отключить" })).toHaveCount(0);
    await limitsPanel.getByRole("button", { name: "Открыть кабинет провайдера" }).click();
    assert.equal(await page.evaluate(() => window.stageF.opened[0]), "https://kilo.ai/gateway");
    await limitsPanel.getByRole("button", { name: "Действия · Groq", exact: true }).click();
    await limitsPanel.getByRole("button", { name: "Отключить" }).click();
    await expect(limitsPanel.getByRole("button", { name: "Действия · Groq", exact: true })).toHaveCount(0);

    const recommendation = limitsPanel.getByRole("button", { name: /^Подключить / }).first();
    await recommendation.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await limits.click();
    await limitsPanel.getByRole("button", { name: "Все подключения в настройках" }).click();
    await expect(page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Модели и подключения" }))
      .toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Демонстрация этапа F", exact: true }).click();
    await expect(row.getByText("42 ток/с")).toBeVisible();
    await page.evaluate(() => window.stageF.updateStats());
    await expect(row.locator(".metric-wrap--limits .quota-dot")).toHaveAttribute("data-tone", "red");
    await page.evaluate(() => window.stageF.amber());
    await expect(row.locator(".metric-wrap--limits .quota-dot")).toHaveAttribute("data-tone", "amber");
    await page.evaluate(() => window.stageF.emit({ type: "reply-cache" }));
    await expect(row.getByText(/Кэш/)).toHaveCount(0);
    await page.evaluate(() => window.stageF.emit({ type: "reply-cache", cachePercent: 87 }));

    await page.setViewportSize({ width: 900, height: 760 });
    await composer.fill("Продолжим работу над проектом.");
    await page.mouse.move(4, 4);
    await shot("composer-900");
    const geometry = await page.locator(".composer-toolbar").evaluate(toolbar => {
      const chips = [...toolbar.querySelectorAll([
        ".composer-controls > .composer-control", ".composer-popup > .composer-control",
        ".model-picker > summary", ".composer-controls > .send"
      ].join(", "))];
      const rect = toolbar.getBoundingClientRect();
      return chips.map(chip => {
        const bounds = chip.getBoundingClientRect();
        return { height: bounds.height, inside: bounds.left >= rect.left && bounds.right <= rect.right,
          radius: getComputedStyle(chip).borderRadius, left: bounds.left, right: bounds.right, top: bounds.top };
      });
    });
    assert.equal(geometry.length, 6);
    for (const chip of geometry) assert.deepEqual([chip.height, chip.inside, chip.radius], [28, true, "8px"]);
    for (let i = 1; i < geometry.length; i++) {
      assert(geometry[i].top === geometry[i - 1].top && geometry[i].left - geometry[i - 1].right >= 5.9,
        JSON.stringify(geometry));
    }
    await page.close();
  }
  const demo = await browser.newPage();
  demo.on("pageerror", error => errors.push(error.message));
  await demo.addInitScript(mockDesktop, { catalog, theme: "dark", demo: true });
  await demo.goto(url);
  const demoBar = demo.locator(".composer-status");
  await expect(demoBar).toHaveText("Демо · 3 сообщения осталось");
  await demo.getByRole("button", { name: "Демонстрация этапа F", exact: true }).click();
  await demo.getByRole("textbox", { name: "Сообщение агенту" }).fill("Демо");
  await demo.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(demoBar.getByText("42 ток/с")).toBeVisible();
  await expect(demoBar.getByRole("button", { name: "Контекст 6%" })).toBeVisible();
  await expect(demoBar.getByText(/Кэш/)).toHaveCount(0);
  await demo.close();
  assert.deepEqual(errors, []);
  console.log("Проверены обе темы, 4 подсказки, контекст, лимиты, подключения, подменю рассуждений, ширина 900px и режим демо. Сохранено 16 снимков.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
