import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "screenshots");
const renderer = join(root, "out", "renderer");
const catalog = JSON.parse(await readFile(join(root, "resources", "catalog.json"), "utf8"));
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  const path = resolve(renderer, "." + new URL(request.url, "http://localhost").pathname.replace(/^\/$/, "/index.html"));
  if (!path.startsWith(renderer + sep)) return response.writeHead(404).end();
  try {
    const payload = await readFile(path);
    const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    response.writeHead(200, { "content-type": contentTypes[extname(path)] ?? "application/octet-stream" }).end(payload);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;

function mockDesktop({ catalog, theme }) {
  const noop = async () => {};
  const directory = "C:/Projects/coffee-landing";
  const prefs = { directory, theme, fontSize: "normal", auto: true, clipboard: false, catalogUpdates: true,
    defaultAccess: "ask", fullAccessConfirmed: false, busyEnter: "queue", notifications: true,
    notificationSound: true, keepAwake: false, panelWidth: 365, agentSteps: 0, webSearch: false };
  const own = { id: "custom-api:vision", name: "Dev Vision", providerId: "custom-api", providerName: "Свой OpenAI-совместимый",
    upstreamId: "dev-vision", context: 128000, output: 8192, vision: true };
  const state = { catalog: { ...catalog, generatedAt: new Date().toISOString() },
    personal: ["custom-api"], connected: ["kilo", "openrouter"], subscriptions: [], personalModels: [own], zenModels: [] };
  const modelId = catalog.models.find(model => model.tier === "top" && !model.capabilities.includes("vision") &&
    catalog.offers.some(offer => offer.modelId === model.id && offer.providerId === "kilo" && offer.supportsTools))?.id;
  const environment = [
    { id: "chat-a", title: "Лендинг для кофейни", directory, modelId, updatedAt: 6, pinned: true },
    { id: "chat-b", title: "Форма заказа", directory, updatedAt: 4 },
    { id: "chat-c", title: "Починить мобильную версию", directory, updatedAt: 3 },
    { id: "chat-d", title: "Подключить оплату", directory, updatedAt: 2 },
    { id: "chat-e", title: "Бот для Telegram", directory: "C:/Projects/telegram-bot", updatedAt: 1 },
    { id: "chat-f", title: "Старый вариант меню", directory, archived: true, updatedAt: 0 }
  ];
  const change = { file: "src/App.tsx", status: "modified", additions: 2, deletions: 1,
    patch: "@@ -8,3 +8,4 @@\n <main className=\"landing\">\n-  <Hero />\n+  <Hero onOrder={openOrder} />\n+  <Menu items={menuItems} />\n </main>" };
  const history = { changes: [change], usage: { input: 17130, output: 440, reasoning: 930, cache: { read: 3000, write: 0 }, context: 128000 },
    parts: [
      { id: "u1", kind: "user", text: "Сделай лендинг для кофейни с меню и формой заказа на React" },
      { id: "r1", kind: "reasoning", text: "Уточню структуру проекта и переиспользую компоненты.", seconds: 12 },
      { id: "a1", kind: "text", text: "Посмотрю структуру проекта и соберу лендинг." },
      { id: "t1", kind: "tool", status: "completed", tool: "read", target: "4 файла" },
      { id: "t2", kind: "tool", status: "completed", tool: "edit", target: "src/App.tsx", diff: change },
      { id: "t3", kind: "tool", status: "completed", tool: "shell", target: "npm run dev", output: "Готово · localhost:5173" },
      { id: "todo", kind: "tool", status: "completed", tool: "todowrite", target: "", todos: [
        { content: "Проверить структуру проекта", status: "completed" }, { content: "Проверить форму заказа", status: "in_progress" }
      ] },
      { id: "a2", kind: "text", text: "Готово. Лендинг с меню, корзиной и формой заказа запущен на [localhost:5173](http://localhost:5173)." }
    ] };
  const projectTools = { commands: [{ name: "review", description: "Проверить изменения" }], skills: [
    { id: "review", name: "react-review", description: "Проверка компонентов React и форм.", path: "C:/Projects/coffee-landing/.opencode/skills/react-review/SKILL.md" },
    { id: "docs", name: "project-docs", description: "Обновление README проекта.", path: "C:/vsemkod/opencode/config/opencode/skills/project-docs/SKILL.md" }
  ] };
  const entries = [{ path: "src", type: "directory" }, { path: "src/App.tsx", type: "file" }, { path: "src/components", type: "directory" },
    { path: "src/components/Menu.tsx", type: "file" }, { path: "package.json", type: "file" }, { path: "README.md", type: "file" }];
  const mcp = [
    { name: "project-docs", status: "connected", managed: true },
    { name: "design-preview", status: "disabled", managed: true },
    { name: "local-tools", status: "failed", error: "Сервер не ответил при запуске.", managed: true }
  ];
  const terminals = new Set();
  const chatListeners = new Set();
  const subscribe = listeners => callback => { listeners.add(callback); return () => listeners.delete(callback); };
  let complete;
  window.mockStageD = {
    turns: [],
    finish() { complete?.(); },
    ask() {
      for (const callback of chatListeners) callback({ type: "question", sessionId: "chat-a", question: {
        id: "question", title: "Как оформить форму заказа?", fields: [{ key: "layout", title: "Размещение",
          type: "string", required: true, custom: true, options: [
            { value: "inline", label: "Внизу страницы", description: "Под меню и корзиной" }, { value: "popup", label: "Во всплывающем окне" }
          ] }]
      } });
    }
  };
  window.vsemkod = {
    initial: async () => ({ ...state, preferences: { ...prefs }, version: "0.1.0" }),
    sessions: async () => environment,
    create: async (directory, title) => ({ id: "new", title, directory, updatedAt: Date.now(), modelId }),
    history: async () => history,
    send: async (_id, text, _model, files, options) => {
      window.mockStageD.turns.push({ text, files, options });
      await new Promise(resolve => { complete = resolve; });
      return { changes: history.changes };
    },
    stop: async () => complete?.(),
    answer: noop,
    answerQuestion: async () => { for (const callback of chatListeners) callback({ type: "question-resolved", sessionId: "chat-a", id: "question" }); },
    chooseDirectory: async () => directory,
    chooseFiles: async () => [{ id: "picture", name: "эскиз.png", image: true }],
    filePath: () => "",
    captureFiles: async (_directory, files) => files.map((file, i) => ({ id: String(i), name: file.name, image: file.mime.startsWith("image/") })),
    preferences: async patch => ({ ...Object.assign(prefs, patch) }),
    tools: async () => projectTools,
    findFiles: async (_directory, query) => entries.filter(item => item.path.toLowerCase().includes(query.toLowerCase())),
    listFiles: async (_directory, path) => entries.filter(item => item.path.split("/").slice(0, -1).join("/") === (path ?? "")),
    readFile: async () => 'import { Hero } from "./components/Hero";\nimport { Menu } from "./components/Menu";\n\nexport function App() {\n  return <main className="landing">\n    <Hero onOrder={openOrder} />\n    <Menu items={menuItems} />\n  </main>;\n}',
    modelVariants: async () => ["low", "medium", "high"],
    chatAction: async (id, action) => {
      const chat = environment.find(item => item.id === id);
      if (action.type === "delete") return null;
      if (action.type === "fork") return { ...chat, id: "fork", title: "Копия чата" };
      return Object.assign(chat, action.type === "pin" ? { pinned: action.value } : action.type === "archive" ? { archived: action.value } : { title: action.title });
    },
    revert: async (_id, message) => message ? { parts: [], changes: [], reverted: true } : history,
    revertFile: async () => ({ ...history, changes: [] }),
    exportChats: async id => id ? 1 : environment.length,
    readInstructions: async () => "# Правила проекта\n\n- Пиши текст интерфейса по-русски.\n- Перед сдачей запускай тесты и проверку типов.\n- Сохраняй существующий дизайн.",
    saveInstructions: noop,
    mcpList: async () => mcp,
    mcpChange: async (_directory, name, action) => action === "delete" ? mcp.filter(item => item.name !== name) : mcp,
    openFolder: noop, clearCatalog: noop, refreshCatalog: async () => state, copyText: noop,
    customModels: async () => [{ id: "dev-vision", name: "Dev Vision", context: 128000, output: 8192, vision: true },
      { id: "code-local", name: "Code Local", context: 64000, output: 4096 }],
    saveCustomModels: async () => state,
    openTerminal: async (_directory, id) => {
      for (const callback of terminals) callback({ id, text: "PS C:\\Projects\\coffee-landing> echo ok\r\nok\r\nPS C:\\Projects\\coffee-landing> " });
    },
    terminalResize: noop, terminalInput: noop, closeTerminal: noop,
    onTerminal: subscribe(terminals), onChat: subscribe(chatListeners),
    onCatalog: () => () => {}, onConnect: () => () => {}, onNotice: () => () => {}, onUpdate: () => () => {},
    openExternal: noop, windowAction: noop, checkUpdates: async () => "current", applyUpdate: noop,
    disconnect: async () => state, connect: async () => state, cancelConnection: noop, watchClipboard: noop
  };
}

const sections = [
  ["Общие", "general"], ["Модели и подключения", "models"], ["Агент", "agent"], ["MCP-серверы", "mcp"],
  ["Навыки", "skills"], ["Горячие клавиши", "keys"], ["Данные", "data"], ["О программе", "about"]
];
const errors = [];
let browser;
try {
  browser = await chromium.launch({ args: ["--disable-gpu"] });
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: theme });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("dialog", dialog => void dialog.accept());
    await page.addInitScript(mockDesktop, { catalog, theme });
    await page.goto(address);
    await page.getByRole("heading", { name: "Чем займёмся?" }).waitFor();
    await page.getByRole("button", { name: "Лендинг для кофейни", exact: true }).waitFor();
    const shot = name => page.screenshot({ path: join(output, `d-${theme}-${name}.png`), animations: "disabled" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    await shot("home");
    await page.getByRole("button", { name: "Лендинг для кофейни", exact: true }).click();
    await page.getByText("Думал 12 с").waitFor();
    await page.locator(".chat-thread summary.action").filter({ hasText: "src/App.tsx" }).click();
    await shot("chat");
    const draft = page.getByRole("textbox", { name: "Сообщение агенту" });
    await draft.fill("/");
    await page.getByRole("listbox", { name: "Список команд" }).waitFor();
    await shot("commands");
    await draft.fill("Проверь @src");
    await page.getByRole("listbox", { name: "Упоминания файлов" }).waitFor();
    await shot("mention");
    await draft.press("ArrowDown");
    await draft.press("Tab");
    assert.match(await draft.inputValue(), /@src\//);
    await draft.fill("");
    await page.getByRole("button", { name: "Прикрепить файл" }).click();
    await page.getByText("Выбранная модель не принимает изображения.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Закрыть уведомление" }).click();
    await page.keyboard.press("Control+b");
    const panel = page.getByRole("complementary", { name: "Правая панель" });
    await panel.getByText("src/App.tsx", { exact: true }).click();
    await shot("panel-changes");
    await panel.getByRole("button", { name: "Файлы", exact: true }).click();
    await panel.getByRole("button", { name: "src", exact: true }).click();
    await panel.getByRole("button", { name: "App.tsx" }).click();
    await panel.getByText("import { Hero }", { exact: false }).waitFor();
    await shot("panel-files");
    await panel.getByRole("button", { name: "Терминал", exact: true }).click();
    await page.locator(".xterm-screen").waitFor();
    await page.waitForTimeout(220);
    await shot("panel-terminal");
    await page.keyboard.press("Control+b");

    await draft.fill("Первое сообщение");
    await draft.press("Enter");
    await page.getByText("Агент работает", { exact: true }).waitFor();
    await draft.fill("Сообщение в очереди");
    await draft.press("Enter");
    await page.getByRole("list", { name: "Очередь сообщений" }).getByText("Сообщение в очереди").waitFor();
    await page.getByRole("button", { name: "Убрать из очереди" }).click();
    await page.evaluate(() => window.mockStageD.ask());
    await page.getByText("Как оформить форму заказа?").waitFor();
    await shot("question");
    await page.getByText("Во всплывающем окне", { exact: true }).click();
    await page.getByRole("button", { name: "Ответить" }).click();
    await draft.fill("Срочная правка");
    await draft.press("Control+Enter");
    await page.waitForFunction(() => window.mockStageD.turns.length === 2);
    assert.equal(await page.evaluate(() => window.mockStageD.turns[1].text), "Срочная правка");
    await page.evaluate(() => window.mockStageD.finish());
    await page.getByRole("button", { name: "Стоп", exact: true }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Разделы настроек" });
    for (const [title, name] of sections) {
      await navigation.getByRole("button", { name: title, exact: true }).click();
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
      if (name === "models") {
        await page.getByRole("button", { name: "Загрузить список моделей" }).click();
        await page.getByRole("spinbutton", { name: "Макс. вывод Dev Vision" }).waitFor();
      }
      if (name === "mcp") await page.getByText("design-preview", { exact: true }).waitFor();
      if (name === "agent") await page.getByRole("textbox", { name: "Правила для всех проектов" }).waitFor();
      if (name === "skills") await page.getByRole("heading", { name: "react-review" }).waitFor();
      await shot("settings-" + name);
    }
    await navigation.getByRole("button", { name: "Общие", exact: true }).click();
    await page.getByLabel("Тема", { exact: true }).selectOption(theme === "dark" ? "light" : "dark");
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme === "dark" ? "light" : "dark");
    await page.getByLabel("Размер шрифта", { exact: true }).selectOption("large");
    await page.waitForFunction(() => document.documentElement.dataset.fontSize === "large");
    await page.close();
  }
  assert.deepEqual(errors, [], "Ошибки рендерера");
  console.log("Проверены очередь, вмешательство, вопросы, режимы рендерера и запрет изображений. Сохранено 32 снимка.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
