import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".vsemkod-dev");
const screenshots = join(root, "screenshots");
await mkdir(local, { recursive: true });
await mkdir(screenshots, { recursive: true });
const data = await mkdtemp(join(local, "stage-b-"));
const key = "test-key-for-local-mock";
const upstream = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer " + key) { res.writeHead(401).end(); return; }
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "local-model", name: "Модель локального сервера" }] }));
    return;
  }
  if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (input.model !== "local-model" || !input.stream) { res.writeHead(400).end(); return; }
  const event = {
    id: "test-chat", model: "local-model", object: "chat.completion.chunk", created: 0,
    choices: [{ index: 0, delta: { role: "assistant", content: "STAGE_B_OK" }, finish_reason: null }]
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end("data: " + JSON.stringify(event) + "\n\ndata: " +
    JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const url = "http://127.0.0.1:" + upstream.address().port + "/v1";
let desktop;
try {
  const runtime = process.env.VSEMKOD_QA_ELECTRON;
  desktop = await electron.launch({
    executablePath: runtime ? resolve(runtime) : undefined,
    args: [...(runtime ? ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-sandbox"] : []), "."],
    cwd: root, env: { ...process.env, VSEMKOD_DEV_DATA: data, TMP: local, TEMP: local, TMPDIR: local }
  });
  const page = await desktop.firstWindow();
  if (process.env.VSEMKOD_QA_MOCK_STORAGE === "1") {
    await desktop.evaluate(({ safeStorage }) => {
      const keys = new Map();
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = text => {
        const handle = process.getBuiltinModule("node:crypto").randomBytes(32);
        keys.set(handle.toString("hex"), text);
        return handle;
      };
      safeStorage.decryptString = handle => keys.get(handle.toString("hex"));
    });
    console.log("Только для проверки: вместо системного шифрования используется хранилище в памяти.");
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  const shot = name => page.screenshot({ path: join(screenshots, name + ".png"), animations: "disabled" });
  const dialog = () => page.getByRole("dialog");
  await page.getByRole("heading", { name: "Чем займёмся?" }).waitFor();
  await page.getByRole("button", { name: "Настройки" }).click();
    await page.getByRole("button", { name: "Модели и подключения", exact: true }).click();
  const clipboard = page.getByRole("switch", { name: "Ловить ключ из буфера" });
  assert.equal(await clipboard.isChecked(), false);
  const updates = page.getByRole("switch", { name: "Проверять обновления каталога" });
  await updates.click();
  await page.waitForFunction(async () => !(await window.vsemkod.initial()).preferences.catalogUpdates);
  await updates.click();
  await page.waitForFunction(async () => (await window.vsemkod.initial()).preferences.catalogUpdates);
  await shot("08-settings");

  await desktop.evaluate(({ shell }) => {
    const open = shell.openExternal.bind(shell);
    shell.openExternal = async url => {
      await open(url);
      if (new URL(url).origin === "https://openrouter.ai") globalThis.stageBCallback = new URL(url).searchParams.get("callback_url");
    };
  });
  await page.getByRole("button", { name: "Подключить OpenRouter" }).click();
  await shot("05-openrouter");
  await dialog().getByRole("button", { name: "Продолжить в браузере" }).click();
  await dialog().getByText("Ждём вход…", { exact: true }).waitFor();
  const callback = await desktop.evaluate(() => globalThis.stageBCallback);
  assert(callback, "OpenRouter: системный браузер не запущен.");
  assert.match(callback, /^http:\/\/localhost:\d+\/callback$/);
  assert.equal((await fetch(callback)).status, 400);
  await shot("05-openrouter-waiting");
  await dialog().getByRole("button", { name: "Отмена" }).click();
  await dialog().waitFor({ state: "hidden" });
  console.log("OpenRouter: браузер открылся, callback отвечает. Вход отменён до авторизации.");

  await page.getByRole("button", { name: "Свои подписки и ключи" }).click();
  await shot("07-subscriptions");
  await page.getByRole("button", { name: "Подключить GitHub Copilot" }).click();
  await dialog().getByRole("button", { name: "Подключить", exact: true }).click();
  const github = dialog().getByRole("button", { name: "Открыть GitHub" });
  const githubError = dialog().getByRole("alert");
  await github.or(githubError).first().waitFor();
  if (!await github.isVisible()) throw new Error(await githubError.textContent());
  assert.match(await dialog().locator("kbd").textContent(), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i);
  await dialog().getByRole("button", { name: "Отмена" }).click();
  console.log("GitHub Copilot: расширение движка выдало код устройства. Вход отменён.");
  await page.getByRole("button", { name: "Подключить OpenAI", exact: true }).click();
  assert.equal(await dialog().getByRole("switch").isChecked(), false);
  await shot("06-manual-key");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Подключить Свой OpenAI-совместимый" }).click();
  await dialog().getByLabel("Базовый URL").fill(url);
  await dialog().getByLabel("Вставь ключ").fill("wrong-test-key");
  await dialog().getByRole("button", { name: "Подключить", exact: true }).click();
  await dialog().getByRole("alert").getByText(/Ключ не подошёл/).waitFor();
  await dialog().getByLabel("Вставь ключ").fill(key);
  await dialog().getByRole("button", { name: "Подключить", exact: true }).click();
  await page.getByText("Подключено: Свой OpenAI-совместимый", { exact: true }).waitFor();
  await shot("09-toast");
  assert(!(await readFile(join(data, "keys.json"), "utf8")).includes(key), "Ключ не должен храниться открытым текстом.");
  await page.getByRole("button", { name: "Новый чат" }).click();
  await page.locator(".model-picker > summary").click();
  await page.getByRole("heading", { name: "Мои подписки" }).waitFor();
  await page.getByRole("button", { name: /Модель локального сервера/ }).click();
  await page.getByRole("textbox", { name: "Сообщение агенту" }).fill("Проверка локальной модели");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await page.getByText("STAGE_B_OK", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Отправить", exact: true }).waitFor();
  await page.getByRole("button", { name: "Настройки" }).click();
    await page.getByRole("button", { name: "Модели и подключения", exact: true }).click();
  await page.getByRole("button", { name: "Отключить Свой OpenAI-совместимый" }).click();
  await page.getByRole("button", { name: "Отключить Свой OpenAI-совместимый" }).waitFor({ state: "hidden" });
  assert.deepEqual(JSON.parse(await readFile(join(data, "keys.json"), "utf8")), {});
  console.log("Ключ: отказ, подключение, модель в меню, реальный чат OpenCode через Router, удаление ключа.");
} finally {
  await desktop?.close();
  upstream.close();
  upstream.closeAllConnections();
}
