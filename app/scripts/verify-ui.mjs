import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = join(root, "screenshots");
await mkdir(screenshots, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + (process.argv[2] ?? "9417"));
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /127\.0\.0\.1/.test(page.url()));
  assert(page, "Не найдено окно vsemkod в dev-режиме.");
  await page.setViewportSize({ width: 1600, height: 1000 });
  const waitFor = async (locator, timeout = 20_000) => locator.waitFor({ state: "visible", timeout });
  const model = page.locator(".model-picker summary");
  const menu = page.getByRole("region", { name: "Выбор модели" });
  await waitFor(page.getByRole("heading", { name: "Чем займёмся?" }));
  await waitFor(page.getByText("vsemkod Projects", { exact: true }));
  await waitFor(model.getByText("Nemotron 3 Ultra", { exact: true }));
  await page.screenshot({ path: join(screenshots, "01-home.png") });

  const input = page.getByRole("textbox", { name: "Сообщение агенту" });
  await input.fill("Создай файл hello.txt со словом привет. Используй инструмент записи. Ответь по-русски.");
  await page.getByRole("button", { name: "Отправить" }).click();
  const approval = page.getByRole("region", { name: "Запрос разрешения" });
  await waitFor(approval, 55_000);
  await approval.getByRole("button", { name: "Разрешить", exact: true }).click();
  await waitFor(page.getByRole("button", { name: "Изменения 1" }), 55_000);
  await waitFor(page.getByRole("button", { name: "Отправить" }));
  const file = page.locator(".diff-toggle summary").filter({ hasText: "hello.txt" });
  await waitFor(file);
  await file.click();
  await waitFor(page.getByLabel("Изменения в hello.txt"));
  assert.match(await page.getByLabel("Изменения в hello.txt").textContent(), /\+привет/);
  await page.screenshot({ path: join(screenshots, "02-chat.png") });

  await model.click();
  await waitFor(menu);
  await waitFor(menu.getByRole("heading", { name: "Подключены" }));
  await waitFor(menu.getByRole("heading", { name: "Бесплатно — подключить в один клик" }));
  await waitFor(menu.getByRole("switch", { name: "Автовыбор модели" }));
  await page.screenshot({ path: join(screenshots, "03-models.png") });
  const more = menu.getByRole("button", { name: "Показать ещё" });
  await more.click();
  const good = await page.evaluate(async () => (await window.vsemkod.initial()).catalog.models.find(model => model.id === "nemotron-3.5-super")?.name);
  assert(good, "В каталоге отсутствует дополнительная модель Kilo.");
  await waitFor(menu.getByText(good, { exact: true }));
  await menu.getByRole("button", { name: "Подключить Kimi K3.1 Pro" }).click();
  await waitFor(page.getByRole("dialog", { name: "Подключить Kimi K3.1 Pro" }));
  await page.screenshot({ path: join(screenshots, "04-connect.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Настройки" }).click();
  await waitFor(page.getByRole("heading", { name: "Папка по умолчанию" }));
  const preferences = await page.evaluate(async () => (await window.vsemkod.initial()).preferences);
  assert.equal((await readFile(join(preferences.directory, "hello.txt"), "utf8")).trim(), "привет");
  console.log("Окно Electron: каталог, чат Kilo, разрешение, hello.txt, дифф, меню и настройки.");
} finally {
  await browser.close();
}
