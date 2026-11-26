import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "screenshots");
const directory = await mkdtemp(join(tmpdir(), "vsemkod-g-electron-"));
const catalog = JSON.parse(await readFile(join(root, "resources/catalog.json"), "utf8"));
const kilo = catalog.providers.find(provider => provider.id === "kilo");
const template = catalog.offers.find(offer => offer.providerId === "kilo" && offer.supportsTools);
const benchmarkSource = { name: "Artificial Analysis", url: "https://artificialanalysis.ai/", indexVersion: "5.0" };
const held = new Map();
const calls = [];
const pending = new Set();
const document = [
  '<svg width="270" height="145" viewBox="0 0 270 145" xmlns="http://www.w3.org/2000/svg">',
  '<rect x="0" y="0" width="270" height="145" rx="12" fill="#16232e"/>',
  '<circle cx="191" cy="48" r="25" fill="#ffd98b"/>',
  '<path d="M0 119 69 49 126 110 161 76 239 145H0z" fill="#537594"/>',
  '<path d="M0 130 66 93 130 141 218 103 270 133v12H0z" fill="#69a68d"/>',
  '</svg>'
].join("\n");

const upstream = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
  try {
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    const input = JSON.parse(Buffer.concat(pieces).toString());
    const conversation = JSON.stringify(input.messages);
    const phase = /Параллельный чат [АБВГ]/u.exec(conversation)?.[0];
    const assets = conversation.includes("Собери иллюстрацию для проекта");
    const write = input.tools?.find(tool => /(?:^|_)write$/.test(tool.function?.name ?? ""));
    const call = assets && write && !pending.has(input.messages.length + input.model) && !conversation.includes("landscape.svg");
    if (call) pending.add(input.messages.length + input.model);
    calls.push({ phase, model: input.model, streamOptions: input.stream_options });
    const id = "chatcmpl-stage-g-" + calls.length;
    const packet = (delta, finish = null) => {
      if (res.destroyed) return;
      res.write("data: " + JSON.stringify({ id, model: input.model, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    packet({ role: "assistant" });
    if (call) {
      packet({ tool_calls: [{ index: 0, id: "stage-g-write-landscape", type: "function", function: {
        name: write.function.name, arguments: JSON.stringify({ path: "landscape.svg", content: document })
      } }] });
      packet({}, "tool_calls");
    } else {
      packet({ reasoning_content: "Проверю структуру проекта и файлы." });
      await delay(160);
      packet({ content: phase ? "Собираю данные по проекту. " : "Готово. Иллюстрация сохранена в " });
      if (phase) {
        await new Promise(done => {
          held.set(phase, done);
          res.on("close", done);
        });
        held.delete(phase);
      } else await delay(1050);
      packet({ content: phase ? "Фоновый ответ завершён." :
        "«LANDSCAPE». Текст страницы — src/index.html:24. Справка: https://example.org/docs.".replace("«LANDSCAPE»", "\x60landscape.svg\x60") });
      packet({}, "stop");
    }
    if (!res.destroyed) res.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");

async function verify(theme) {
  pending.clear();
  const data = join(directory, theme);
  const project = join(data, "Студия");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(output, { recursive: true });
  const now = new Date(Math.max(Date.now(), Date.parse(catalog.generatedAt) + 1000)).toISOString();
  const best = catalog.models.filter(model => model.tier === "top").slice(0, 6);
  const extra = catalog.models.filter(model => model.tier === "good").slice(0, 6);
  const available = [...best, ...extra];
  const url = "http://127.0.0.1:" + upstream.address().port + "/v1";
  const providers = catalog.providers.map(provider => provider.id === "kilo" ? { ...kilo, baseUrl: url } : provider);
  const offers = available.map(model => ({ ...template, modelId: model.id, providerModelId: model.id, expiresAt: null, promo: false, status: "active" }));
  const locked = catalog.offers.filter(offer => offer.providerId !== "kilo" && offer.status === "active" && offer.supportsTools);
  await Promise.all([
    writeFile(join(data, "preferences.json"), JSON.stringify({ directory: project, theme, catalogUpdates: false, notifications: false })),
    writeFile(join(data, "catalog.json"), JSON.stringify({ ...catalog, generatedAt: now, providers, offers: [...offers, ...locked], candidates: [] })),
    writeFile(join(data, "benchmarks.json"), JSON.stringify({ schemaVersion: 1, generatedAt: now, source: benchmarkSource,
      models: Object.fromEntries(best.map((model, index) => [model.id, { index: 62.1 - index * 2.3, speed: 180 - index * 13, ttft: 0.58 + index * 0.12 }])) })),
    writeFile(join(project, "src/index.html"), "<!doctype html>\n" + Array.from({ length: 46 }, (_, index) => "<!-- Строка " + (index + 2) + " -->").join("\n"))
  ]);

  const executablePath = process.env.VSEMKOD_QA_ELECTRON;
  const desktop = await electron.launch({
    executablePath: executablePath && resolve(executablePath), cwd: root, timeout: 30_000,
    args: ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-sandbox", "."],
    env: { ...process.env, VSEMKOD_DEV_DATA: data, TMP: directory, TEMP: directory, TMPDIR: directory }
  });
  try {
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(16_000);
    page.on("pageerror", error => console.error("Renderer:", error));
    desktop.process().stderr?.on("data", content => process.stderr.write(content));
    await page.getByRole("heading", { name: "Чем займёмся?" }).waitFor();
    const size = await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(1320, 900);
      return win.getSize();
    });
    assert.deepEqual(size, [1320, 900]);
    await page.waitForFunction(() => window.innerHeight >= 875);
    const shot = name => page.screenshot({ path: join(output, "g-" + theme + "-" + name + ".png"), animations: "disabled" });
    const input = page.getByRole("textbox", { name: "Сообщение агенту" });
    const send = async text => {
      await input.fill(text);
      await page.getByRole("button", { name: "Отправить", exact: true }).click();
    };
    const home = () => page.locator(".wordmark").click();
    const chat = title => page.locator(".chat-sidebar-item").filter({ has: page.locator('.conversation[title="' + title + '"]') });
    const status = (title, value) => chat(title).locator('.chat-status-dot[data-status="' + value + '"]');
    await page.getByRole("heading", { name: "Чем займёмся?" }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    const projectRow = page.locator(".group-name");
    await projectRow.click();
    assert.equal(await projectRow.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".chat-sidebar-item").count(), 0);
    await projectRow.click();
    await page.getByText("Нет чатов", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Модель ·/ }).click();
    const picker = page.getByRole("region", { name: "Выбор модели" });
    await picker.getByRole("heading", { name: "Лучшие бесплатные" }).waitFor();
    assert.equal(await picker.getByRole("searchbox").evaluate(element => document.activeElement === element), true);
    const bounds = await picker.boundingBox();
    assert(bounds && bounds.y >= 8 && bounds.height <= 561, JSON.stringify(bounds));
    await shot("models-900");
    await picker.getByRole("searchbox").fill(best[0].name.split(/\s+/)[0]);
    await picker.getByRole("searchbox").press("Enter");

    await page.getByRole("button", { name: "Спрашивать", exact: true }).click();
    const access = page.getByRole("region", { name: "Режим доступа" });
    await access.waitFor();
    await shot("access");
    await access.getByRole("button", { name: /^Полный доступ/ }).click();
    await shot("access-warning");
    await access.getByRole("button", { name: "Отмена" }).click();
    assert.equal(await page.evaluate(async () => (await window.vsemkod.initial()).preferences.fullAccessConfirmed), false);
    await access.getByRole("button", { name: /^Авто-правки/ }).click();

    const first = "Собери иллюстрацию для проекта";
    await send(first);
    const image = page.locator(".turn-file-image img");
    await image.waitFor();
    assert.match(await image.getAttribute("src"), /^data:image\/svg\+xml;base64,/);
    assert.match(await readFile(join(project, "landscape.svg"), "utf8"), /<svg/);
    const fileChip = page.locator(".file-chip").filter({ hasText: "landscape.svg" });
    await fileChip.waitFor();
    assert.equal(await page.getByRole("link", { name: "https://example.org/docs", exact: true }).count(), 1);
    await shot("files");
    await fileChip.click();
    const preview = page.getByRole("region", { name: "Просмотр файла" });
    await preview.locator("img").waitFor();
    await shot("preview");
    await preview.getByRole("button", { name: "Код", exact: true }).click();
    await preview.locator(".preview-code").getByText("</svg>", { exact: true }).waitFor();
    await page.locator(".file-chip").filter({ hasText: "index.html" }).click();
    await preview.locator('.preview-line[data-current="true"]').getByText("24", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Закрыть панель" }).click();
    await page.locator(".metric-wrap--speed").getByText(/≈ .*ток\/с/).waitFor();
    await shot("speed");

    const parallel = ["А", "Б", "В", "Г"].map(letter => "Параллельный чат " + letter);
    for (const title of parallel.slice(0, 2)) {
      await home();
      await send(title);
      await status(title, "working").waitFor();
    }
    await status(parallel[0], "working").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".conversation .chat-status-dot[data-status=working]").length === 2);
    await page.getByText("Собираю данные по проекту.", { exact: false }).waitFor();
    await shot("parallel");
    for (const title of parallel.slice(2)) {
      await home();
      await send(title);
    }
    await status(parallel[3], "queued").waitFor();
    assert.equal(calls.filter(call => call.phase === parallel[3]).length, 0);
    await page.getByRole("button", { name: "Стоп", exact: true }).click();
    await status(parallel[3], "queued").waitFor({ state: "hidden" });
    for (const title of parallel.slice(0, 3)) await status(title, "working").waitFor();
    await chat(parallel[0]).locator(".conversation").click();
    await page.getByRole("button", { name: "Стоп", exact: true }).click();
    await status(parallel[0], "working").waitFor({ state: "hidden" });
    for (const title of parallel.slice(1, 3)) {
      await status(title, "working").waitFor();
      assert(held.has(title), title + " didn't reach the provider.");
      held.get(title)();
      await status(title, "ready").waitFor();
    }
    await chat(parallel[1]).locator(".conversation").click();
    await page.getByText("Фоновый ответ завершён.", { exact: false }).waitFor();
    await status(parallel[1], "ready").waitFor({ state: "hidden" });
    assert(calls.some(call => call.streamOptions?.include_usage === true));
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("button", { name: /^Режим доступа по умолчанию/ }).click();
    const settingAccess = page.getByRole("region", { name: "Режим доступа" });
    await settingAccess.getByRole("button", { name: /^Полный доступ/ }).click();
    await settingAccess.getByRole("button", { name: "Включить", exact: true }).click();
    await page.waitForFunction(async () => {
      const { preferences } = await window.vsemkod.initial();
      return preferences.defaultAccess === "full" && preferences.fullAccessConfirmed;
    });
    console.log(theme + " — семь снимков, очередь и фоновый ответ проверены");
  } finally { await desktop.close(); }
}

try {
  for (const theme of ["dark", "light"]) await verify(theme);
} finally {
  held.forEach(done => done());
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
}
