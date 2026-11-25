import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = new URL("../../catalog-bot/data/", import.meta.url);
const port = Number(process.env.MOCK_PORT || 4173);
const limit = Number(process.env.MOCK_REMAINING || 10);
const open = process.env.MOCK_CLOSED !== "1";
const serveDemo = !process.argv.includes("--static");
const model = { id: "mock-model", name: "Демо-модель" };
const sessions = new Map();
const retried = new Set();
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
};

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function fail(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

async function jsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 300_000) return null;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function startStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
  });
  res.flushHeaders();
}

function eventBytes(event) {
  return Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`);
}

function sendEvent(res, event) {
  res.write(eventBytes(event));
}

function mockAnswer(prompt) {
  if (/xss/i.test(prompt)) {
    return [
      "### Проверка экранирования", "",
      "<img src=x onerror=alert(1)>", "<script>alert(2)</script>", "",
      "```html", "<img src=x onerror=alert(1)>", "<script>alert(2)</script>", "```",
    ].join("\n");
  }
  return [
    "### Как это сделать", "",
    "- Добавь выбор темы в `settings.tsx`.",
    "- Сохрани выбор и проверь, что тема применяется при запуске.", "",
    "```tsx", "const next = theme === 'dark' ? 'light' : 'dark';", "setTheme(next);", "```",
  ].join("\n");
}

async function startChat(req, res, messages) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return fail(res, 401, "auth", "Сессия истекла.");
  if (session.remaining <= 0) return fail(res, 429, "limit", "Сообщения закончились.");
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 8 ||
    !messages.every((message) => ["user", "assistant"].includes(message?.role) && typeof message.content === "string") ||
    messages.at(-1).role !== "user" || !messages.at(-1).content.trim() || messages.at(-1).content.length > 2000) {
    return fail(res, 400, "bad_request", "Отправь сообщение до 2000 символов.");
  }

  const prompt = messages.at(-1).content;
  startStream(res);
  if (prompt.startsWith(":auth") && (prompt.startsWith(":auth-twice") || !retried.has(prompt))) {
    retried.add(prompt);
    sessions.delete(token);
    sendEvent(res, { t: "error", code: "auth", message: "Сессия истекла." });
  } else if (prompt.startsWith(":busy")) {
    sendEvent(res, { t: "error", code: "busy", message: "Модель занята. Попробуй ещё раз." });
  } else {
    session.remaining -= 1;
    const response = mockAnswer(prompt);
    for (const part of response.match(/[\s\S]{1,12}/gu)) {
      if (res.destroyed) return;
      const bytes = eventBytes({ t: "delta", v: part });
      // Break SSE lines and UTF-8 characters across writes.
      const split = bytes.findIndex((byte) => byte >= 0xC0) + 1 || 8;
      res.write(bytes.subarray(0, split));
      await delay(14);
      if (res.destroyed) return;
      res.write(bytes.subarray(split));
      await delay(prompt.startsWith(":slow") ? 270 : 36);
    }
    if (!res.destroyed) sendEvent(res, { t: "done", remaining: session.remaining });
  }
  res.end();
}

async function api(req, res, route) {
  if (req.method === "GET" && route === "/status") return sendJson(res, 200, { open, model });
  if (!open) return fail(res, 503, "closed", "Дневная квота исчерпана.");
  if (req.method !== "POST") return fail(res, 405, "bad_request", "Метод недоступен.");
  if (route !== "/session" && route !== "/chat") return fail(res, 404, "bad_request", "Метод недоступен.");

  let body;
  try { body = await jsonBody(req); } catch {}
  if (!body || typeof body !== "object") return fail(res, 400, "bad_request", "Нужен JSON.");
  if (route === "/chat") return startChat(req, res, body.messages);

  if (typeof body.turnstile !== "string" || !body.turnstile.trim()) {
    return fail(res, 403, "auth", "Нужен тестовый токен Turnstile.");
  }
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  const session = { token: randomUUID(), expiresAt: now + 15 * 60_000, remaining: limit };
  sessions.set(session.token, session);
  sendJson(res, 200, session);
}

async function staticPage(req, res, path) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }

  const documentPath = path === "/" || path === "/harness/" ? `${path}index.html` : path;
  const file = resolve(root, "." + documentPath);
  if (!file.startsWith(resolve(root) + sep) || path.split("/").some((part) => part.startsWith("."))) {
    res.writeHead(404).end();
    return;
  }
  if (path === "/dev" || path.startsWith("/dev/")) {
    res.writeHead(404).end();
    return;
  }

  const data = path === "/catalog.json" || path === "/changes.json"
    ? await readFile(new URL(path.slice(1), catalog))
    : await readFile(file);
  const body = serveDemo && path === "/app.js"
    ? data.toString("utf8")
      .replace(/const DEMO_API = "[^"]*";/, 'const DEMO_API = "/demo";')
      .replace(/const TURNSTILE_SITEKEY = "[^"]*";/, 'const TURNSTILE_SITEKEY = "1x00000000000000000000BB";')
    : data;
  res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : body);
}

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (serveDemo && path.startsWith("/demo/")) {
      await api(req, res, path.slice(5));
    } else {
      await staticPage(req, res, path);
    }
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.end();
    } else if (error.code === "ENOENT" || error.code === "EISDIR") {
      res.writeHead(404, { "Content-Type": types[".html"] });
      res.end(await readFile(new URL("../404.html", import.meta.url)));
    } else {
      fail(res, 500, "upstream", "Ошибка локального сервера.");
    }
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port} (${serveDemo ? "mock" : "static"})`);
});
