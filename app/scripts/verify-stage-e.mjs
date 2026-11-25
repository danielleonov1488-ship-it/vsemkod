import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const renderer = join(root, "out", "renderer");
const output = join(root, "screenshots");
const catalog = JSON.parse(await readFile(join(root, "resources", "catalog.json"), "utf8"));
const contentTypes = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const path = resolve(renderer, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!path.startsWith(renderer + sep)) return response.writeHead(404).end();
  try {
    const bytes = await readFile(path);
    response.writeHead(200, { "content-type": (contentTypes[extname(path)] ?? "application/octet-stream") + "; charset=utf-8" }).end(bytes);
  } catch { response.writeHead(404).end(); }
});

function mockDesktop({ catalog, theme }) {
  const listeners = new Set();
  const noop = () => () => {};
  const state = { catalog, connected: ["kilo"], personal: ["groq-api"], subscriptions: [], personalModels: [], zenModels: [] };
  const prefs = { directory: "C:/Projects/voice-demo", theme, defaultAccess: "ask", auto: true, fontSize: "normal",
    voiceModel: "accurate", voiceLanguage: "auto", voiceSilence: 30, voiceDevice: "", voiceGroq: false };
  const status = { models: { accurate: { installed: 0, partial: 0 }, fast: { installed: 0, partial: 0 } },
    vadInstalled: false, recommendFast: "cpu", groq: true };
  let id;
  let resolveDownload;
  let audio = 0;
  let starts = 0;
  let downloads = 0;
  const send = event => listeners.forEach(listener => listener(event));
  window.voiceTest = {
    counts: () => ({ audio, starts, downloads }),
    downloaded() {
      status.models.accurate.installed = 574041195;
      status.vadInstalled = true;
      delete status.download;
      resolveDownload(structuredClone(status));
      send({ type: "status", status: structuredClone(status) });
    },
    text(type, phrase, text) { send({ type, phrase, text, id }); },
    silence() { send({ type: "silence", id }); }
  };
  window.vsemkod = {
    initial: async () => ({ ...state, preferences: { ...prefs }, version: "0.1.0" }),
    sessions: async () => [],
    tools: async () => ({ commands: [], skills: [] }),
    modelVariants: async () => [],
    preferences: async patch => ({ ...Object.assign(prefs, patch) }),
    onChat: noop, onCatalog: noop, onNotice: noop, onUpdate: noop, onTerminal: noop,
    voice: {
      status: async () => structuredClone(status),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      download(model, consent) {
        if (!consent) throw new Error("Missing download consent");
        downloads++;
        status.download = { model, received: 235_000_000, total: 574_926_293, phase: "download" };
        send({ type: "progress", progress: status.download });
        return new Promise(resolve => { resolveDownload = resolve; });
      },
      pause: async () => {},
      remove: async model => {
        status.models[model].installed = 0;
        return structuredClone(status);
      },
      start: async value => { id = value; starts++; },
      audio: async (value, pcm) => { if (value === id && pcm.byteLength > 0) audio++; },
      stop: async id => send({ type: "done", id }),
      cancel: async () => { id = undefined; }
    }
  };
}

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.VSEMKOD_CHROMIUM, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--use-file-for-fake-audio-capture=" + join(root, "tests", "fixtures", "voice-en.wav")] });
  const errors = [];
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: theme, permissions: ["microphone"] });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(mockDesktop, { catalog, theme });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const mic = page.getByRole("button", { name: "Голосовой ввод" });
    const composer = page.getByRole("textbox", { name: "Сообщение агенту" });
    const shot = name => page.screenshot({ path: join(output, "e-" + theme + "-" + name + ".png"), animations: "disabled" });
    await expect(mic).toBeVisible();
    await shot("mic");
    await mic.click();
    const consent = page.getByRole("group", { name: "Согласие на загрузку" });
    await expect(consent).toContainText("Рекомендуем Быструю");
    await consent.getByRole("button", { name: "Отмена" }).click();
    assert.equal((await page.evaluate(() => window.voiceTest.counts())).downloads, 0);
    await mic.click();
    await consent.getByRole("button", { name: "Загрузить Точную" }).click();
    await expect(page.getByRole("progressbar", { name: "Загрузка · Точная" })).toBeVisible();
    await shot("download");
    await page.evaluate(() => window.voiceTest.downloaded());
    await expect(mic).toBeEnabled();

    await composer.fill("Сначала потом");
    await composer.evaluate(input => input.setSelectionRange(7, 7));
    await mic.click();
    const recording = page.getByRole("group", { name: "Голосовая запись" });
    await expect(recording.getByRole("button", { name: "Стоп" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.voiceTest.counts().audio)).toBeGreaterThan(1);
    await page.evaluate(() => {
      window.voiceTest.text("final", 1, "открой папку");
      window.voiceTest.text("partial", 2, "и проверь настройки");
    });
    await expect(composer).toHaveValue("Сначала открой папку потом");
    await expect(page.getByLabel("Промежуточный текст")).toHaveText("и проверь настройки");
    await expect.poll(() => recording.locator(".voice-wave i").nth(3).evaluate(el => parseFloat(el.style.height))).toBeGreaterThan(4);
    await shot("recording");
    await page.evaluate(() => window.voiceTest.text("final", 2, "и проверь настройки"));
    await page.keyboard.press("Escape");
    await expect(recording).toHaveCount(0);
    await expect(composer).toHaveValue("Сначала открой папку и проверь настройки потом");

    await composer.press("Control+Space");
    await expect(recording.getByRole("button", { name: "Стоп" })).toBeVisible();
    await page.evaluate(() => window.voiceTest.text("final", 1, "Отменяемая фраза"));
    await recording.getByRole("button", { name: "Отмена" }).click();
    await expect(composer).toHaveValue("Сначала открой папку и проверь настройки потом");

    await page.keyboard.down("Control");
    await page.keyboard.down("Space");
    await expect(recording.getByRole("button", { name: "Стоп" })).toBeVisible();
    await page.keyboard.up("Space");
    await page.keyboard.up("Control");
    await expect(recording).toHaveCount(0);

    await mic.click();
    await expect(recording.getByRole("button", { name: "Стоп" })).toBeVisible();
    await page.evaluate(() => window.voiceTest.silence());
    await expect(recording).toHaveCount(0);
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("button", { name: "Голос", exact: true }).click();
    await expect(page.getByLabel("Модель по умолчанию")).toHaveValue("accurate");
    await expect(page.getByLabel("Автостоп по тишине")).toHaveValue("30");
    await expect(page.getByRole("switch", { name: "Облачное распознавание через мой ключ Groq" })).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Удалить модель «Точная»" })).toBeVisible();
    await shot("settings");
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Голос: интерфейс Chromium в обеих темах, AudioWorklet, Ctrl+Space, Esc, автостоп, позиции курсора. 8 снимков.");
} finally {
  await browser?.close();
  server.close();
}
