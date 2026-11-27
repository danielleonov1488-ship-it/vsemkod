import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatHistory, RemoteAccess } from "../src/shared/api";
import { parseTelegramUpdate, splitTelegramText, TelegramBot, type TelegramChats } from "../src/main/telegram-bot";

const token = "12345:test_bot_token";
const owner = { id: 17, first_name: "Владелец", username: "owner" };
const stranger = { id: 21, first_name: "Другой" };
const defaultPath = "project";
let updated: unknown[];
let calls: { method: string; body: Record<string, any> }[];
const changes: RemoteAccess["telegram"][] = [];
let mock: ReturnType<typeof createServer>;
let bot: TelegramBot;
let chats: TelegramChats;
let keys: Map<string, string>;
let nextId: number;
let sent: (value: { stopped: boolean }) => void;
let origin: string;

const conversation = { id: "session-1", directory: defaultPath, title: "Первое сообщение", updatedAt: 10 };
const history: ChatHistory = { changes: [], parts: [
  { id: "user", kind: "user", text: "Первое сообщение" },
  { id: "answer", kind: "text", text: "**Готово**. См. [пример](https://example.com)." },
  { id: "turn", kind: "turn", seconds: 1, files: [{ file: "a.txt", additions: 1, deletions: 0, status: "added", patch: "" }] }
] };

function newBot() {
  return new TelegramBot({
    get: id => keys.get(id),
    set: async (id, value) => { keys.set(id, value); },
    remove: async id => { keys.delete(id); }
  }, chats, () => changes.push(bot.state()), origin);
}

beforeEach(async () => {
  nextId = 0;
  const updates: unknown[] = updated = [];
  const requests: typeof calls = calls = [];
  changes.length = 0;
  keys = new Map();
  chats = {
    projects: () => ({ directory: defaultPath, available: [defaultPath, "other"] }),
    find: vi.fn(async () => conversation),
    create: vi.fn(async () => conversation),
    send: vi.fn(() => new Promise<{ stopped: boolean }>(resolve => { sent = resolve; })),
    stop: vi.fn(async () => { sent({ stopped: true }); }),
    history: vi.fn(async () => history).mockResolvedValueOnce({ parts: [], changes: [] }),
    permission: vi.fn(async () => {}),
    question: vi.fn(async () => {})
  };
  mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const method = req.url!.split("/").at(-1)!;
    requests.push({ method, body });
    if (!req.url?.startsWith("/bot" + token + "/")) {
      res.writeHead(401).end(JSON.stringify({ ok: false }));
      return;
    }
    if (method === "getUpdates") await delay(25);
    const result = method === "getMe" ? { id: 12345, username: "test_bot" }
      : method === "getUpdates" ? updates.splice(0, updates.length) : true;
    res.setHeader("content-type", "application/json").end(JSON.stringify({ ok: true, result }));
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  origin = "http://127.0.0.1:" + (mock.address() as AddressInfo).port;
  bot = newBot();
  await bot.configure(token);
});

afterEach(async () => {
  bot.stop();
  mock.closeAllConnections();
  await new Promise<void>(resolve => mock.close(() => resolve()));
});

const message = (text: string, from: { id: number; first_name: string; username?: string } = owner, type = "private") => updated.push({
  update_id: nextId++, message: { text, from, chat: { id: from.id, type } }
});
const callback = (data: string, from: { id: number; first_name: string; username?: string } = owner) => updated.push({
  update_id: nextId++, callback_query: { id: String(nextId), data, from, message: { chat: { id: from.id, type: "private" } } }
});
const telegramMessage = (text: string, chatId = owner.id) =>
  calls.find(item => item.method === "sendMessage" && item.body.text === text && item.body.chat_id === chatId);
async function pair() {
  message("/start " + bot.state().pairCode);
  await vi.waitFor(() => expect(bot.state().pairedUser).toBe("@owner"));
}

it("разбирает текст, отсеивает неполные сообщения и сохраняет границы Unicode", () => {
  expect(parseTelegramUpdate({ update_id: 1, message: { text: "текст", from: owner, chat: { id: 17, type: "private" } } })?.message?.text).toBe("текст");
  expect(parseTelegramUpdate({ update_id: 1, message: { text: "x" } })?.message).toBeUndefined();
  expect(parseTelegramUpdate({ message: {} })).toBeUndefined();
  const text = "a".repeat(3499) + "😀" + "б".repeat(3750) + "\nконец";
  const parts = splitTelegramText(text);
  expect(parts.join("")).toBe(text);
  expect(parts.every(item => item.length <= 3500)).toBe(true);
  expect(parts[1].startsWith("😀")).toBe(true);
});

it("проверяет токен, выдаёт код, записывает владельца и игнорирует чужие сообщения", async () => {
  expect(bot.state()).toMatchObject({ botName: "test_bot", connected: true });
  expect(bot.state().pairCode).toMatch(/^\d{6}$/);
  message("/start " + bot.state().pairCode, stranger, "group");
  await vi.waitFor(() => expect(telegramMessage("Это личный бот vsemkod", stranger.id)).toBeDefined());
  expect(bot.state().pairedUser).toBeUndefined();
  await pair();
  expect(bot.state().pairCode).toBeUndefined();
  message("Отправить от чужого", stranger);
  await vi.waitFor(() => expect(calls.filter(item => item.body.text === "Это личный бот vsemkod")).toHaveLength(2));
  expect(chats.send).not.toHaveBeenCalled();
  expect(calls.find(item => item.method === "getUpdates")?.body.timeout).toBe(30);
  expect(calls.find(item => item.method === "setMyCommands")?.body.commands.map((item: { command: string }) => item.command))
    .toEqual(["new", "stop", "project", "status", "help"]);
  bot.stop();
  bot = newBot();
  bot.load();
  expect(bot.state().pairedUser).toBe("@owner");
  await bot.configure("");
  expect(bot.state().pairedUser).toBeUndefined();
  expect(bot.state().pairCode).toMatch(/^\d{6}$/);
  await bot.configure(null);
  expect(bot.state().connected).toBe(false);
  expect(keys.size).toBe(0);
  await expect(bot.configure("12345:wrong")).rejects.toThrow("Не удалось проверить токен");
});

it("передаёт ответ в общий чат и принимает inline-разрешение только от владельца", async () => {
  await pair();
  message("Первое сообщение");
  await vi.waitFor(() => expect(chats.send).toHaveBeenCalledWith(conversation.id, "Первое сообщение"));
  expect(chats.create).toHaveBeenCalledWith(defaultPath, "Первое сообщение");
  expect(calls.some(item => item.method === "sendChatAction" && item.body.action === "typing")).toBe(true);
  bot.onChat({ type: "permission", sessionId: conversation.id, permission: { id: "p1", action: "write", resources: ["a.txt"] } });
  let button = "";
  await vi.waitFor(() => {
    const permission = calls.find(item => item.body.text === "Запрос разрешения: write\na.txt");
    button = permission?.body.reply_markup.inline_keyboard[0][0].callback_data;
    expect(button).toBeTruthy();
  });
  callback(button, stranger);
  await vi.waitFor(() => expect(calls.some(item => item.method === "answerCallbackQuery" && item.body.text === "Это личный бот vsemkod")).toBe(true));
  expect(chats.permission).not.toHaveBeenCalled();
  callback(button);
  await vi.waitFor(() => expect(chats.permission).toHaveBeenCalledWith(conversation.id, "p1", "once"));
  bot.onChat({ type: "permission-resolved", sessionId: conversation.id, id: "p1" });
  bot.onChat({ type: "question", sessionId: conversation.id, question: {
    id: "q1", title: "Как продолжить?", fields: [{ type: "string", key: "plan", required: true, custom: false,
      options: [{ value: "short", label: "Кратко" }] }]
  } });
  await vi.waitFor(() => {
    const question = calls.find(item => item.body.text === "Как продолжить?\nplan");
    button = question?.body.reply_markup.inline_keyboard[0][0].callback_data;
    expect(button).toBeTruthy();
  });
  callback(button);
  await vi.waitFor(() => expect(chats.question).toHaveBeenCalledWith(conversation.id, "q1", { plan: "short" }));
  sent({ stopped: false });
  await vi.waitFor(() => expect(telegramMessage("Готово. См. пример.\n\nИзменено файлов: 1")).toBeDefined());
});

it("переключает проект кнопкой и останавливает текущий ход", async () => {
  await pair();
  message("/project");
  let button = "";
  await vi.waitFor(() => {
    const menu = telegramMessage("Выберите проект для новых чатов.");
    button = menu?.body.reply_markup.inline_keyboard[1][0].callback_data;
    expect(button).toBeTruthy();
  });
  callback(button);
  await vi.waitFor(() => expect(bot.state().project).toBe("other"));
  message("Новый вопрос");
  await vi.waitFor(() => expect(chats.send).toHaveBeenCalled());
  expect(chats.create).toHaveBeenCalledWith("other", "Новый вопрос");
  message("/stop");
  await vi.waitFor(() => expect(chats.stop).toHaveBeenCalledWith(conversation.id));
});
