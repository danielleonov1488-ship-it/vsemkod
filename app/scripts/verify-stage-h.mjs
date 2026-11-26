import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.VSEMKOD_QA_SCREENSHOTS ? resolve(process.env.VSEMKOD_QA_SCREENSHOTS) : join(root, "screenshots");
const profile = await mkdtemp(join(tmpdir(), "vsemkod-h-electron-"));
const source = JSON.parse(await readFile(join(root, "resources/catalog.json"), "utf8"));
const deepSeek = source.models.find(model => /deepseek-v4[.-]1-flash/.test(model.id)) ?? {
  ...source.models[0], id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", tier: "top", rank: 0
};
const fast = source.models.find(model => model.id === "nemotron-3.5-lightning") ?? source.models.find(model => model.id !== deepSeek.id);
const template = source.offers.find(offer => offer.providerId === "kilo" && offer.supportsTools);
const html = "<!doctype html><meta charset=\"utf-8\"><title>Студия</title><h1>Студия</h1><script>console.error(\"Нет файла стилей\"); throw new Error(\"Сценарий ещё не настроен\");</script>";
const serverCommand = "node server.cjs";
const mainQuestion = "Как устроен проект «Студия»?";
const sideQuestion = "Какой адрес мы обсуждали?";
const calls = [];
const upstream = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
  const pieces = [];
  for await (const piece of req) pieces.push(piece);
  const input = JSON.parse(Buffer.concat(pieces).toString());
  calls.push(input);
  if (input.model === deepSeek.id) { res.writeHead(503).end("Numes temporarily unavailable"); return; }
  const side = JSON.stringify(input.messages).includes(sideQuestion);
  const response = side ? "Мы обсуждали локальную страницу проекта. Ссылка была в основном чате." :
    "Стартовая страница проекта готова. Предпросмотр доступен по адресу http://localhost:" + upstream.address().port + "/.";
  const packet = (delta, finish_reason = null) => "data: " + JSON.stringify({
    id: "chatcmpl-h-" + calls.length, model: input.model, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta, finish_reason }]
  }) + "\n\n";
  res.writeHead(200, { "content-type": "text/event-stream" });
  const write = input.tools?.find(tool => /(?:^|_)write$/.test(tool.function?.name ?? ""));
  const first = !side && write && !input.messages.some(message => message.role === "tool");
  const body = first ? packet({ tool_calls: [{ index: 0, id: "stage-h-write", type: "function",
    function: { name: write.function.name, arguments: JSON.stringify({ path: "index.html", content: html }) } }] }) + packet({}, "tool_calls")
    : packet({ content: response.slice(30) }) + packet({}, "stop");
  res.write(packet({ role: "assistant" }));
  if (!first) { res.write(packet({ content: response.slice(0, 30) })); await delay(425); }
  res.end(body + "data: [DONE]\n\n");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");

async function verify(theme) {
  const data = join(profile, theme);
  const project = join(data, "Студия");
  await mkdir(project, { recursive: true });
  await mkdir(output, { recursive: true });
  await promisify(execFile)("git", ["init", "-b", "main"], { cwd: project }).catch(() => {});
  const baseUrl = "http://127.0.0.1:" + upstream.address().port + "/v1";
  const providers = source.providers.map(provider => ["kilo", "numes"].includes(provider.id) ? { ...provider, baseUrl,
    auth: { type: "none" }, clicksToConnect: 0 } : provider);
  const offers = [[fast.id, "kilo"], [deepSeek.id, "numes"], [deepSeek.id, "modelscope"], [deepSeek.id, "runcrate"]]
    .map(([modelId, providerId]) => ({ ...template, modelId, providerId, providerModelId: modelId, expiresAt: null, promo: false, status: "active" }));
  const catalog = { ...source, generatedAt: new Date(Math.max(Date.now(), Date.parse(source.generatedAt) + 1000)).toISOString(),
    providers, models: [fast, deepSeek], offers, candidates: [] };
  await Promise.all([
    writeFile(join(data, "preferences.json"), JSON.stringify({ directory: project, theme, auto: false, catalogUpdates: false, defaultAccess: "edit",
      notifications: false, notificationSound: false, connectionWizardSeen: true, panelWidth: 430 })),
    writeFile(join(data, "catalog.json"), JSON.stringify(catalog)),
    writeFile(join(data, "mcp.json"), JSON.stringify({ "docs-local": { type: "local", disabled: true, command: ["node", "docs.cjs"] } })),
    writeFile(join(project, "server.cjs"), 'const s=require("node:http").createServer((q,r)=>r.end("ok"));s.listen(0,"::1",()=>console.log("Serving at http://localhost:"+s.address().port+"/"));')
  ]);
  const executablePath = process.env.VSEMKOD_QA_ELECTRON;
  const desktop = await electron.launch({
    executablePath: executablePath && resolve(executablePath), cwd: root, timeout: 30_000,
    args: ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-sandbox", "."],
    env: { ...process.env, VSEMKOD_DEV_DATA: data, TMP: profile, TEMP: profile, TMPDIR: profile }
  });
  try {
    const page = await desktop.firstWindow();
    const errors = [];
    page.on("pageerror", error => { errors.push(error); console.error("Renderer:", error); });
    desktop.process().stderr?.on("data", content => process.stderr.write(content));
    page.setDefaultTimeout(18_000);
    const resize = (width, height) => desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await resize(1320, 900);
    await page.waitForFunction(() => window.innerWidth >= 1300 && window.innerHeight >= 875);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    const shot = name => page.screenshot({ path: join(output, "h-" + theme + "-" + name + ".png"), animations: "disabled" });
    const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
    const menu = page.getByRole("group", { name: "Доступные панели" });
    const openPanel = async name => { await button("Панели").click(); await menu.getByRole("button", { name: new RegExp("^" + name) }).click(); };
    const composer = page.getByRole("textbox", { name: "Сообщение агенту" });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const send = async text => { await composer.fill(text); await button("Отправить").click(); };
    await send(mainQuestion);
    await page.getByText(/Стартовая страница проекта готова/).waitFor();
    await button("Открыть в браузере приложения").waitFor();
    await button("Панели").click();
    await menu.getByText("Боковой чат", { exact: true }).waitFor();
    const menuBounds = await menu.boundingBox();
    assert(menuBounds?.width === 260 && menuBounds.height >= 200, JSON.stringify(menuBounds));
    await shot("panels");
    await page.keyboard.press("Escape");
    await button("Сводка").click();
    const summary = page.getByRole("group", { name: "Сводка сессии" });
    await summary.getByText("Этот компьютер").waitFor();
    await summary.getByText("main", { exact: true }).waitFor();
    await summary.getByRole("button", { name: "index.html", exact: true }).waitFor();
    const summaryBounds = await summary.boundingBox();
    assert(summaryBounds?.width === 320 && summaryBounds.height >= 225, JSON.stringify(summaryBounds));
    await shot("summary");
    await summary.getByRole("button", { name: /Контекст/ }).click();
    await page.getByRole("region", { name: "Контекст", exact: true }).waitFor();
    await page.keyboard.press("Escape");

    const answer = page.locator(".agent-text").filter({ hasText: "Стартовая страница проекта готова" });
    await answer.evaluate(element => {
      const node = element.querySelector("p").firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 16);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await button("Цитировать").click();
    assert.match(await composer.inputValue(), /^> Стартовая/);
    await composer.fill("");
    await button("Открыть в приложении", answer).click();
    const address = page.getByRole("textbox", { name: "Адрес страницы" });
    await button("Открыть в браузере приложения").click();
    await page.waitForFunction(() => document.querySelector(".browser-address input")?.value.endsWith("/index.html"));
    assert((await address.inputValue()).startsWith("file:"));
    await page.getByRole("button", { name: /● 2 ошибки/ }).waitFor();
    await shot("browser");
    await page.getByRole("button", { name: /● 2 ошибки/ }).click();
    await page.locator(".browser-popover--errors").getByText(/Сценарий ещё не настроен/).waitFor();
    await button("Отправить агенту").click();
    assert.match(await composer.inputValue(), /Ошибки в браузере/);
    await composer.fill("");

    await button("Добавить вкладку").click();
    await menu.getByRole("button", { name: /^Терминал/ }).click();
    await button("Запустить в фоне").click();
    await page.getByRole("textbox", { name: "Команда фоновой задачи" }).fill(serverCommand);
    await button("Запустить").click();
    await openPanel("Фоновые задачи");
    const task = page.locator(".task-card").filter({ hasText: serverCommand });
    await task.getByText("Работает", { exact: true }).waitFor();
    await task.locator(".task-heading").click();
    const serverOutput = task.getByText(/Serving at http:\/\/localhost/);
    await serverOutput.waitFor();
    const serverUrl = (await serverOutput.textContent()).match(/https?:\/\/localhost:\d+\//)?.[0];
    assert(serverUrl);
    const loopbackUrl = serverUrl.replace("localhost", "[::1]");
    assert.equal(await (await fetch(loopbackUrl)).text(), "ok");
    await shot("tasks");

    await page.keyboard.press(mod + "+Semicolon");
    const side = page.getByRole("textbox", { name: "Сообщение в боковой чат" });
    await side.fill(sideQuestion);
    await button("Отправить в боковой чат").click();
    await page.getByText("Мы обсуждали локальную страницу проекта.", { exact: false }).waitFor();
    const sideCall = calls.findLast(call => JSON.stringify(call.messages).includes(sideQuestion));
    assert(JSON.stringify(sideCall?.messages).includes(mainQuestion), "Боковой чат должен получить историю родительского чата");
    await shot("side-chat");
    await button("Вставить в основной чат").click();
    assert.match(await composer.inputValue(), /^> Мы обсуждали/);
    await composer.fill("");
    await page.getByRole("tab", { name: "Боковой чат" }).hover();
    await button("Закрыть вкладку «Боковой чат»").click();
    const chats = await page.evaluate(() => window.vsemkod.sessions());
    assert.equal(chats.length, 1);
    await page.getByRole("tab", { name: "Фоновые задачи" }).click();
    await button("Остановить", task).click();
    await button("Точно остановить?", task).click();
    await task.getByText("Остановлен", { exact: true }).waitFor();
    await assert.rejects(() => fetch(loopbackUrl));

    await resize(940, 850);
    await page.waitForFunction(() => window.innerWidth < 1000);
    assert.equal(await page.locator(".workspace-panel").evaluate(el => getComputedStyle(el).position), "absolute");
    await page.keyboard.press("Escape");
    await page.getByRole("complementary", { name: "Правая панель" }).waitFor({ state: "hidden" });
    await resize(1320, 900);

    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("updates:ready", { version: "0.2.0", action: "restart" });
    });
    await page.getByText("Обновление 0.2.0 готово", { exact: true }).waitFor();
    await shot("update");
    await page.locator(".update-close").click();
    await page.locator(".update-pill--folded").waitFor();
    await shot("update-folded");
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("updates:ready", undefined));

    await page.getByRole("button", { name: /^Модель ·/ }).click();
    const picker = page.getByRole("region", { name: "Выбор модели" });
    await picker.getByRole("searchbox").fill(deepSeek.name);
    await picker.locator(".model-option").filter({ hasText: deepSeek.name }).first().click();
    await send("Проверь надёжность источника ответа.");
    const issue = page.locator(".route-card");
    await issue.getByText(/Numes сейчас не отвечает/).waitFor();
    await shot("model-fallback");
    await button("Настройки").click();
    await button("Модели и подключения").click();
    await button("Подключить всё за пару минут").click();
    const wizard = page.getByRole("dialog", { name: "Подключить всё за пару минут" });
    await wizard.waitFor();
    assert.equal(await wizard.locator(".wizard-providers li").first().locator("strong").textContent(), "OpenRouter");
    await shot("connect-wizard");
    await button("Готово", wizard).click();
    assert.deepEqual(errors, []);
    console.log(theme + " — 9 снимков, браузер, фоновые задачи, форк и отказ провайдера проверены");
  } finally {
    const windows = desktop.windows();
    for (const window of windows) {
      await window.evaluate(async () => {
        const tasks = await window.vsemkod.tasks();
        await Promise.allSettled(tasks.map(task => window.vsemkod.stopTask(task.id)));
      }).catch(() => {});
    }
    await desktop.close();
  }
}

try {
  for (const theme of ["dark", "light"]) await verify(theme);
} finally {
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
}
