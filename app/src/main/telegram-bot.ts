import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ChatEvent, ChatHistory, Conversation, PermissionDecision, Question, QuestionAnswer, RemoteAccess } from "../shared/api";
import type { KeyStore } from "./key-store";

const keyId = "telegram-bot";
const personal = "Это личный бот vsemkod";
const networkError = "Не удалось связаться с Telegram. Повторяем подключение.";
const commands = [
  { command: "new", description: "Начать новый чат" },
  { command: "stop", description: "Остановить агента" },
  { command: "project", description: "Выбрать проект" },
  { command: "status", description: "Узнать, что делает агент" },
  { command: "help", description: "Показать команды" }
];

const username = z.string().regex(/^[A-Za-z0-9_]+$/);
const tokenSchema = z.string().regex(/^\d+:[A-Za-z0-9_-]+$/);
const ownerId = z.int();
const recordSchema = z.object({
  token: tokenSchema, name: username, project: z.string().optional(),
  owner: z.object({ id: ownerId, chatId: ownerId, label: z.string() }).optional(),
  session: z.object({ id: z.string(), directory: z.string() }).optional()
});
type BotRecord = z.infer<typeof recordSchema>;
type Run = { controller: AbortController; offset?: number };
const user = z.object({ id: ownerId, username: z.string().optional(), first_name: z.string(), last_name: z.string().optional() });
const chatSchema = z.object({ id: ownerId, type: z.string() });
const updateSchema = z.object({
  update_id: z.int().nonnegative(),
  message: z.object({ text: z.string().optional(), from: user.optional(), chat: chatSchema }).optional().catch(undefined),
  callback_query: z.object({ id: z.string(), from: user, data: z.string().optional(), message: z.object({ chat: chatSchema }).optional() }).optional().catch(undefined)
});
type Update = z.infer<typeof updateSchema>;
type Button = { text: string; callback_data: string } | { text: string; url: string };
type ButtonAction = { group: string; run: () => Promise<void> };
type Turn = {
  session?: string; stopped: boolean; status: string;
  waiting: Map<string, string>;
  formInput?: { id: string; answer: (text: string) => Promise<void> };
};

export type TelegramChats = {
  projects: () => { directory: string; available: string[] };
  find: (session: string, directory: string) => Promise<Conversation | undefined>;
  create: (directory: string, title: string) => Promise<Conversation>;
  send: (session: string, text: string) => Promise<{ stopped: boolean }>;
  stop: (session: string) => Promise<void>;
  history: (session: string, directory: string) => Promise<ChatHistory>;
  permission: (session: string, id: string, decision: PermissionDecision) => Promise<void>;
  question: (session: string, id: string, answer?: QuestionAnswer) => Promise<void>;
};

export function parseTelegramUpdate(value: unknown): Update | undefined {
  const result = updateSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function splitTelegramText(text: string): string[] {
  const pieces: string[] = [];
  while (text.length > 3500) {
    const breakAt = Math.max(text.lastIndexOf("\n", 3499), text.lastIndexOf(" ", 3499));
    let end = breakAt >= 1750 ? breakAt + 1 : 3500;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    pieces.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) pieces.push(text);
  return pieces;
}

function plainMarkdown(text: string) {
  return text.replace(/^ {0,3}(?:~~~|```)[^\n]*$/gm, "")
    .replace(/^ {0,3}(?:#{1,6} +|> ?)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/(\*{1,3}|_{1,3}|~~|`+)(\S[^\n]*?)\1/g, "$2")
    .trim();
}

function titleFor(prompt: string) {
  return [...prompt.trim().split(/\s+/).slice(0, 8).join(" ")].slice(0, 60).join("") || "Чат из Telegram";
}

export class TelegramBot {
  private record?: BotRecord;
  private run?: Run;
  private pairCode?: string;
  private error?: string;
  private active?: Turn;
  private buttons = new Map<string, ButtonAction>();
  private writes = Promise.resolve();
  private closed = false;

  constructor(
    private readonly keys: Pick<KeyStore, "get" | "set" | "remove">,
    private readonly chats: TelegramChats,
    private readonly publish: () => void,
    private readonly baseUrl = "https://api.telegram.org"
  ) {}

  load() {
    try { this.record = recordSchema.parse(JSON.parse(this.keys.get(keyId) ?? "null")); }
    catch { return; }
    this.restart();
  }

  state(): RemoteAccess["telegram"] {
    const record = this.record;
    if (!record) return { connected: false };
    const { directory, available: projects } = this.chats.projects();
    return { connected: true, botName: record.name, pairedUser: record.owner?.label,
      pairCode: this.pairCode, project: record.project && projects.includes(record.project) ? record.project : directory, error: this.error };
  }

  stop() {
    this.closed = true;
    this.endRun();
  }

  configure(token: string | null, selected?: string): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      const record = this.record;
      const project = selected === undefined ? undefined : this.checkedProject(selected);
      if (token === null) {
        await this.keys.remove(keyId);
        this.record = undefined;
        this.restart();
      } else if (token === "") {
        if (!record) throw new Error("Сначала подключите бота.");
        if (project !== undefined) {
          if (project !== this.state().project) await this.save({ ...record, project, session: undefined });
        } else {
          await this.save({ ...record, owner: undefined, session: undefined });
          this.restart();
        }
      } else {
        if (!tokenSchema.safeParse(token).success) throw new Error("Проверьте токен бота от @BotFather.");
        let name: string;
        try {
          const info = await this.call(token, "getMe", {}, AbortSignal.timeout(12_000));
          name = z.object({ username }).parse(info).username;
        } catch { throw new Error("Не удалось проверить токен бота в Telegram."); }
        if (this.closed) return;
        if (record?.token === token) {
          await this.save({ ...record, name, ...(project && project !== this.state().project ? { project, session: undefined } : {}) });
        } else {
          await this.save({ token, name, project });
        }
        this.restart(record?.token === token);
      }
      this.publish();
    });
  }

  onChat(event: ChatEvent) {
    const turn = this.active;
    const run = this.run;
    if (!run || !turn || turn.session !== event.sessionId) return;
    if (event.type === "turn-status") turn.status = event.status === "queued" ? "Агент ждёт свободного места." : "Агент работает.";
    if (event.type === "permission-resolved" || event.type === "question-resolved") {
      turn.waiting.delete(event.id);
      this.forget(event.id);
      if (turn.formInput?.id === event.id) turn.formInput = undefined;
    }
    if (event.type === "permission") {
      const { permission } = event;
      turn.waiting.set(permission.id, "Агент ждёт разрешения.");
      const choices: [string, PermissionDecision][] = [["Разрешить один раз", "once"], ["Разрешить всегда", "always"], ["Запретить", "reject"]];
      const buttons = choices.map(([label, decision]) => [this.button(label, permission.id,
        () => this.chats.permission(event.sessionId, permission.id, decision))]);
      void this.ownerMessage(run, ["Запрос разрешения: " + permission.action, ...permission.resources].join("\n"), buttons).catch(() => {});
    }
    if (event.type === "question") {
      turn.waiting.set(event.question.id, "Агент ждёт ответа на вопрос.");
      void this.ask(run, turn, event.sessionId, event.question).catch(() => {});
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writes.then(action);
    this.writes = result.then(() => {}, () => {});
    return result;
  }

  private async save(record: BotRecord) {
    await this.keys.set(keyId, JSON.stringify(record));
    this.record = record;
  }

  private checkedProject(project: string) {
    if (!this.chats.projects().available.includes(project)) throw new Error("Проект больше недоступен.");
    return project;
  }

  private restart(keepOffset = true) {
    const offset = keepOffset ? this.run?.offset : undefined;
    this.endRun();
    const record = this.record;
    this.error = undefined;
    this.pairCode = record && !record.owner ? String(randomInt(1_000_000)).padStart(6, "0") : undefined;
    if (!record || this.closed) return;
    const run = { controller: new AbortController(), offset };
    this.run = run;
    void this.poll(run, record.token);
  }

  private endRun() {
    this.run?.controller.abort();
    this.run = undefined;
    this.buttons.clear();
    const turn = this.active;
    this.active = undefined;
    if (turn?.session && !turn.stopped) void this.chats.stop(turn.session).catch(() => {});
  }

  private async call(token: string, method: string, payload: object, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await fetch(this.baseUrl + "/bot" + token + "/" + method, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        redirect: "error", signal
      });
      const json = await response.json() as { ok?: boolean; result?: unknown };
      if (!response.ok || json.ok !== true) throw new Error();
      return json.result;
    } catch { throw new Error("Запрос к Telegram не выполнен."); }
  }

  private request(run: Run, method: string, payload: object = {}) {
    if (run !== this.run || !this.record) return Promise.reject(new Error("Подключение к Telegram закрыто."));
    return this.call(this.record.token, method, payload, AbortSignal.any([
      run.controller.signal, AbortSignal.timeout(method === "getUpdates" ? 40_000 : 12_000)
    ]));
  }

  private async poll(run: Run, token: string) {
    let registered = false;
    let wait = 1000;
    while (this.run === run) {
      try {
        if (!registered) {
          await this.request(run, "setMyCommands", { commands });
          registered = true;
        }
        const updates = await this.request(run, "getUpdates", {
          offset: run.offset, timeout: 30, allowed_updates: ["message", "callback_query"]
        });
        if (!Array.isArray(updates)) throw new Error();
        if (this.error && this.run === run) { this.error = undefined; this.publish(); }
        for (const item of updates) {
          if (this.run !== run || this.record?.token !== token) return;
          const update = parseTelegramUpdate(item);
          if (!update || update.update_id < (run.offset ?? 0)) continue;
          run.offset = update.update_id + 1;
          try { await this.update(run, update); }
          catch { await this.ownerMessage(run, "Не удалось выполнить действие.").catch(() => {}); }
        }
        wait = 1000;
      } catch {
        if (run !== this.run) return;
        if (!this.error) { this.error = networkError; this.publish(); }
        await delay(wait, undefined, { signal: run.controller.signal }).catch(() => {});
        wait = Math.min(wait * 2, 15_000);
      }
    }
  }

  private async update(run: Run, { message, callback_query: callback }: Update) {
    const record = this.record;
    if (!record || this.run !== run) return;
    if (callback) {
      const owned = this.isOwner(callback.from.id, callback.message?.chat);
      const action = owned && callback.data ? this.buttons.get(callback.data) : undefined;
      void this.request(run, "answerCallbackQuery", { callback_query_id: callback.id,
        text: !owned ? personal : !action ? "Кнопка устарела." : undefined }).catch(() => {});
      await action?.run();
      return;
    }
    const text = message?.text?.trim();
    if (!message?.from || !text) return;
    const { from, chat } = message;
    if (!this.isOwner(from.id, chat)) {
      const match = /^\/start(?:@([A-Za-z0-9_]+))?\s+(\d{6})$/i.exec(text);
      const code = match && (!match[1] || match[1].toLowerCase() === record.name.toLowerCase()) ? match[2] : undefined;
      const paired = code && chat.type === "private" && await this.serialize(async () => {
        const current = this.record;
        if (this.run !== run || !current || current.owner || code !== this.pairCode) return false;
        await this.save({ ...current, owner: { id: from.id, chatId: chat.id,
          label: from.username ? "@" + from.username : [from.first_name, from.last_name].filter(Boolean).join(" ") } });
        this.pairCode = undefined;
        this.publish();
        return true;
      });
      await this.message(run, chat.id, paired ? "Бот привязан. Напишите сообщение или откройте /help." : personal);
      return;
    }

    const command = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text);
    if (command?.[2] && command[2].toLowerCase() !== record.name.toLowerCase()) return;
    switch (command?.[1].toLowerCase()) {
      case "stop": return this.stopTurn(run);
      case "new":
        if (this.active) return this.ownerMessage(run, "Сначала остановите агента командой /stop.");
        await this.change(run, current => ({ ...current, session: undefined }));
        return this.ownerMessage(run, "Следующее сообщение начнёт новый чат.");
      case "project": return this.projectMenu(run);
      case "status": return this.ownerMessage(run, this.active ? [...this.active.waiting.values()].at(-1) ?? this.active.status : "Агент свободен.");
      case "start":
      case "help": return this.ownerMessage(run, "Напишите сообщение, чтобы обратиться к агенту.\n\n" +
        commands.map(item => "/" + item.command + " — " + item.description).join("\n"));
      default:
        if (command) return this.ownerMessage(run, "Неизвестная команда. Доступные команды — /help.");
        if (this.active?.formInput) return this.active.formInput.answer(text);
        if (this.active) return this.ownerMessage(run, "Агент уже работает. Используйте /status или /stop.");
        void this.startTurn(run, text);
    }
  }

  private isOwner(id: number, chat?: z.infer<typeof chatSchema>) {
    return chat?.type === "private" && this.record?.owner?.id === id && this.record.owner.chatId === chat.id;
  }

  private change(run: Run, update: (record: BotRecord) => BotRecord) {
    return this.serialize(async () => {
      if (run !== this.run || !this.record) return;
      await this.save(update(this.record));
      this.publish();
    });
  }

  private async message(run: Run, chatId: number, text: string, buttons?: Button[][]) {
    const pieces = splitTelegramText(text);
    for (const [i, part] of pieces.entries()) {
      await this.request(run, "sendMessage", { chat_id: chatId, text: part,
        link_preview_options: { is_disabled: true },
        reply_markup: buttons && i === pieces.length - 1 ? { inline_keyboard: buttons } : undefined });
    }
  }

  private async ownerMessage(run: Run, text: string, buttons?: Button[][]) {
    const owner = this.record?.owner;
    if (run === this.run && owner) await this.message(run, owner.chatId, text, buttons);
  }

  private button(text: string, group: string, run: ButtonAction["run"]): Button {
    const id = randomBytes(12).toString("base64url");
    this.buttons.set(id, { group, run });
    return { text: [...text].slice(0, 64).join(""), callback_data: id };
  }

  private forget(group: string) {
    for (const [id, button] of this.buttons) if (button.group === group) this.buttons.delete(id);
  }

  private async projectMenu(run: Run, page = 0) {
    this.forget("projects");
    const { available: projects } = this.chats.projects();
    const choose = (project: string) => this.button(project.split(/[/\\]/).filter(Boolean).at(-1) ?? project, "projects", async () => {
      this.checkedProject(project);
      await this.change(run, current => current.project === project ? current : { ...current, project, session: undefined });
      this.forget("projects");
      await this.ownerMessage(run, "Проект выбран: " + project);
    });
    const pageSize = 12;
    const buttons = projects.slice(page * pageSize, (page + 1) * pageSize).map(project => [choose(project)]);
    const nav: Button[] = [];
    if (page > 0) nav.push(this.button("Назад", "projects", () => this.projectMenu(run, page - 1)));
    if ((page + 1) * pageSize < projects.length) nav.push(this.button("Далее", "projects", () => this.projectMenu(run, page + 1)));
    if (nav.length) buttons.push(nav);
    await this.ownerMessage(run, "Выберите проект для новых чатов.", buttons);
  }

  private async stopTurn(run: Run) {
    const turn = this.active;
    if (!turn) return this.ownerMessage(run, "Агент свободен.");
    if (turn.session) await this.chats.stop(turn.session);
    turn.stopped = true;
    turn.status = "Агент останавливается.";
    await this.ownerMessage(run, turn.status);
  }

  private async startTurn(run: Run, text: string) {
    const turn: Turn = { stopped: false, status: "Агент готовится к работе.", waiting: new Map() };
    this.active = turn;
    const type = () => {
      const chatId = this.record?.owner?.chatId;
      if (chatId !== undefined && !turn.stopped && !turn.waiting.size) {
        void this.request(run, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      }
    };
    type();
    const timer = setInterval(type, 4000);
    try {
      const directory = this.state().project!;
      const stored = this.record?.session;
      let chat = stored?.directory === directory ? await this.chats.find(stored.id, directory) : undefined;
      if (turn.stopped || run !== this.run) return;
      if (!chat) {
        chat = await this.chats.create(directory, titleFor(text));
        const id = chat.id;
        if (!turn.stopped && run === this.run && directory === this.state().project) {
          await this.change(run, current => current.project && current.project !== directory ? current : { ...current, session: { id, directory } });
        }
      }
      if (turn.stopped || run !== this.run) return;
      const previous = (await this.chats.history(chat.id, chat.directory)).parts.findLast(part => part.kind === "user");
      if (turn.stopped || run !== this.run) return;
      turn.session = chat.id;
      const result = await this.chats.send(chat.id, text).finally(() => { turn.session = undefined; });
      if (result.stopped || turn.stopped || run !== this.run) return;
      const { parts } = await this.chats.history(chat.id, chat.directory);
      const recent = parts.slice(parts.findIndex(part => part.kind === "user" && part.id === previous?.id) + 1);
      const lastUser = recent.findLastIndex(part => part.kind === "user");
      const reply = lastUser < 0 ? "" : plainMarkdown(recent.slice(lastUser + 1)
        .flatMap(part => part.kind === "text" ? [part.text] : []).join("\n\n"));
      const files = new Set(recent.flatMap(part => part.kind === "turn" ? part.files?.map(file => file.file) ?? [] : []));
      await this.ownerMessage(run, (reply || "Ответ пуст.") + (files.size ? "\n\nИзменено файлов: " + files.size : ""));
    } catch {
      if (!turn.stopped) await this.ownerMessage(run, "Не удалось получить ответ агента. Подробности доступны в приложении.").catch(() => {});
    } finally {
      clearInterval(timer);
      for (const group of turn.waiting.keys()) this.forget(group);
      if (this.active === turn) this.active = undefined;
    }
  }

  private async ask(run: Run, turn: Turn, session: string, question: Question) {
    const { id, title } = question;
    const fields = question.fields.filter(field => !("hidden" in field && field.hidden));
    const values: QuestionAnswer = Object.fromEntries(question.fields.flatMap(field =>
      "default" in field && field.default !== undefined ? [[field.key, field.default]] : []));
    const submit = async (answer?: QuestionAnswer) => {
      await this.chats.question(session, id, answer);
      this.forget(id);
      if (turn.formInput?.id === id) turn.formInput = undefined;
    };
    const show = async (index: number, offset = 0) => {
      if (run !== this.run || this.active !== turn || !turn.waiting.has(id)) return;
      this.forget(id);
      if (turn.formInput?.id === id) turn.formInput = undefined;
      const field = fields[index];
      if (!field) { await submit(values); return; }
      const next = () => show(index + 1);
      const set = async (value: QuestionAnswer[string]) => { values[field.key] = value; await next(); };
      const label = [title, field.title ?? field.key, "description" in field ? field.description : undefined].filter(Boolean).join("\n");
      const skip = this.button("Пропустить вопрос", id, () => submit());
      if (field.type === "external") {
        const url = URL.parse(field.url);
        const link = url?.protocol === "https:" || url?.protocol === "http:" ? [[{ text: "Открыть ссылку", url: url.href }]] : [];
        await this.ownerMessage(run, label, [...link, [this.button("Далее", id, next), skip]]);
        return;
      }
      const options = field.type === "boolean" ? [{ label: "Да", value: true }, { label: "Нет", value: false }]
        : "options" in field ? field.options ?? [] : [];
      const selectedValue = values[field.key];
      const selected = Array.isArray(selectedValue) ? selectedValue : [];
      const multiple = field.type === "multiselect";
      const custom = field.type !== "boolean" && (!options.length || ("custom" in field && field.custom !== false));
      if (custom) {
        turn.formInput = { id, answer: async text => {
          const numeric = field.type === "number" || field.type === "integer";
          const number = Number(text);
          if (numeric && (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number)))) {
            await this.ownerMessage(run, "Введите число.");
            return;
          }
          await set(multiple ? [...new Set([...selected, text])] : numeric ? number : text);
        } };
      }
      const size = 16;
      const rows = options.slice(offset, offset + size).map(option => {
        const checked = multiple && typeof option.value === "string" && selected.includes(option.value);
        return [this.button((checked ? "✓ " : "") + option.label, id, async () => {
          if (multiple && typeof option.value === "string") {
            const value = option.value;
            values[field.key] = checked ? selected.filter(entry => entry !== value) : [...selected, value];
            await show(index, offset);
          } else await set(option.value);
        })];
      });
      const nav: Button[] = [];
      if (offset > 0) nav.push(this.button("Назад", id, () => show(index, offset - size)));
      if (offset + size < options.length) nav.push(this.button("Далее", id, () => show(index, offset + size)));
      if (nav.length) rows.push(nav);
      if (!field.required || (multiple && selected.length) || (!multiple && selectedValue !== undefined)) rows.push([this.button("Подтвердить", id, next)]);
      rows.push([skip]);
      await this.ownerMessage(run, label + (custom ? "\nМожно отправить свой ответ текстом." : ""), rows);
    };
    await show(0);
  }
}
