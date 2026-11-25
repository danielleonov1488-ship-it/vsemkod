import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { activeOffers, rankedModels } from "../src/shared/catalog";
import { CatalogService } from "../src/main/catalog-service";
import { EngineService, engineBinary } from "../src/main/engine/service";
import { Router } from "../src/main/router";
import { ProviderHealth } from "../src/main/router/health";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".vsemkod-dev");
await mkdir(local, { recursive: true });
const data = await mkdtemp(join(local, "stage-d-"));
const project = join(data, "project");
await mkdir(project);
await writeFile(join(project, "hint.txt"), "mint-coffee-671", "utf8");
const catalog = new CatalogService(data, join(root, "resources", "catalog.json"));
await catalog.loadInitial();
await catalog.refresh();
const model = rankedModels(catalog.current).find(candidate =>
  activeOffers(catalog.current, candidate.id).some(({ offer, provider }) => provider.id === "kilo" && provider.auth.type === "none" && offer.supportsTools));
assert(model, "Нет бесплатной модели Kilo с инструментами.");
const useMock = process.env.VSEMKOD_STAGE_D_MOCK === "1";
let phase = "";
let sawMention = false;
let pendingWrite = false;
const provider = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const pieces: Buffer[] = [];
    for await (const piece of request) pieces.push(Buffer.from(piece));
    const input = JSON.parse(Buffer.concat(pieces).toString("utf8"));
    const conversation = JSON.stringify(input.messages);
    if (phase === "mention") sawMention ||= conversation.includes("mint-coffee-671");
    const write = input.tools?.find((tool: { function?: { name: string } }) => /(?:^|_)write$/.test(tool.function?.name ?? ""));
    const call = write && !pendingWrite && ["readonly", "edit"].includes(phase);
    if (call) pendingWrite = true;
    const delta = call ? { tool_calls: [{ index: 0, id: "test-write-" + phase, type: "function", function: {
      name: write.function.name, arguments: JSON.stringify({ path: phase === "edit" ? "hello.txt" : "readonly.txt", content: phase === "edit" ? "привет\n" : "тест" })
    } }] } : { content: phase === "compact" ? "## Objective\n- Verify chat tools.\n\n## Work State\n### Completed\n- Created and restored hello.txt.\n\n## Next Move\n1. None." : phase === "mention" && sawMention ? "mint-coffee-671" : "Готово." };
    const chunk = (payload: object, finish = null as string | null) => ({ id: "chatcmpl-test", object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, delta: payload, finish_reason: finish }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([chunk({ role: "assistant" }), chunk(delta), chunk({}, call ? "tool_calls" : "stop"),
      { ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }]
      .map(payload => "data: " + JSON.stringify(payload) + "\n\n").join("") + "data: [DONE]\n\n");
  } catch { response.writeHead(500).end(); }
});
if (useMock) await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const providerAddress = provider.address();
const activeCatalog = () => typeof providerAddress === "object" && providerAddress ? { ...catalog.current,
  providers: catalog.current.providers.map(item => item.id === "kilo" ? { ...item, baseUrl: "http://127.0.0.1:" + providerAddress.port + "/v1" } : item)
} : catalog.current;
const router = new Router({ catalog: activeCatalog, key: () => undefined, health: new ProviderHealth(join(data, "usage.json")) });
await router.start();
const approvals: string[] = [];
let issued: Promise<void>[] = [];
const engine = new EngineService(process.env.VSEMKOD_STAGE_D_ENGINE ?? engineBinary(join(root, "resources")), join(data, "engine"),
  activeCatalog, router, event => {
    if (event.type === "permission") {
      approvals.push(event.permission.action);
      const answer = engine.answer(event.sessionId, event.permission.id, "reject");
      void answer.catch(console.error);
      issued.push(answer);
    }
    if (event.type === "part" && event.part.kind === "tool") console.log("Инструмент", event.part.status, event.part.tool, event.part.target);
  });
const timeout = setTimeout(() => {
  console.error("Время живой проверки истекло.");
  void engine.close().then(() => router.close()).finally(() => process.exit(1));
}, 165_000);

try {
  const client = await engine.ready();
  const { id } = await client.create(project, "Проверка этапа D");
  console.log("OpenCode запущен. Сессия", id);
  const list = await client.list();
  assert(list.some(chat => chat.id === id), "Чат отсутствует в общем списке.");
  let indexed = await client.findFiles(project, "hint");
  for (let i = 0; i < 20 && !indexed.some(entry => entry.path === "hint.txt"); i++) {
    await wait(250);
    indexed = await client.findFiles(project, "hint");
  }
  assert(indexed.some(entry => entry.path === "hint.txt"), "Файл не найден через OpenCode.");
  assert.equal(await client.readFile(project, "hint.txt"), "mint-coffee-671");
  console.log("Поиск файлов и текстовый просмотр работают.");
  let output = "";
  const terminal = await engine.openTerminal(project, text => { output += text; }, () => {});
  try {
    terminal.input("echo ok\r");
    for (let i = 0; i < 75 && !/\r?\n(?:\x1b\[[0-9;?]*[A-Za-z])*ok\r?\n/i.test(output); i++) await wait(100);
    assert.match(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), /(?:\r?\n)ok(?:\r?\n)/i);
  } finally { await terminal.close(); }
  console.log("PTY выполнил echo ok.");
  if (!useMock) {
    const response = await fetch(router.baseUrl + "/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + router.token, "content-type": "application/json" },
      body: JSON.stringify({ model: model.id, max_tokens: 20, messages: [{ role: "user", content: "Reply OK." }] }),
      signal: AbortSignal.timeout(40_000)
    });
    assert.equal(response.status, 200, "Kilo недоступен: " + await response.text());
  }
  phase = "readonly";
  await engine.send(id, project, "Если тебе разрешено, создай файл readonly.txt со словом тест. Используй инструмент write, если он недоступен, кратко опиши план.", model.id, false, [], undefined, { access: "read" });
  await Promise.all(issued);
  issued = [];
  assert.equal(approvals.length, 0, "Режим чтения не должен запрашивать разрешение на запись.");
  await assert.rejects(access(join(project, "readonly.txt")), { code: "ENOENT" });
  console.log("Режим чтения не изменил файлы.");
  phase = "edit";
  pendingWrite = false;
  await engine.send(id, project, "Создай файл hello.txt инструментом write с единственной строкой привет. Не используй команды оболочки.", model.id, false, [], undefined, { access: "edit" });
  await Promise.all(issued);
  assert.equal(approvals.length, 0, "Авто-правки должны выполнить запись без разрешения.");
  assert.equal((await readFile(join(project, "hello.txt"), "utf8")).trim(), "привет");
  const history = await engine.history(id, project);
  assert(history.changes.some(change => change.file === "hello.txt"), "Дифф файла отсутствует.");
  const boundary = history.parts.findLast(part => part.kind === "user");
  assert(boundary);
  await engine.revert(id, project, boundary.id);
  await assert.rejects(access(join(project, "hello.txt")), { code: "ENOENT" });
  await engine.revert(id, project);
  assert.equal((await readFile(join(project, "hello.txt"), "utf8")).trim(), "привет");
  console.log("Авто-правки, откат и возврат файла работают.");
  phase = "mention";
  await engine.send(id, project, 'Не используй инструменты. Ответь только содержимым вложенного файла @hint.txt.', model.id, false, [], undefined, { access: "read" });
  const mentioned = await engine.history(id, project);
  assert(mentioned.parts.slice(-4).some(part => part.kind === "text" && part.text.includes("mint-coffee-671")));
  if (useMock) assert(sawMention, "Содержимое упомянутого файла не передано модели.");
  phase = "compact";
  await engine.send(id, project, "/compact", model.id, false, [], undefined, { access: "read", compact: true });
  assert((await engine.history(id, project)).parts.some(part => part.kind === "note" && part.text === "Контекст сжат"));
  console.log("Упоминание файла попало в запрос модели, /compact сжал контекст.", useMock ? "Провайдер подменён локальным сервером." : "Провайдер Kilo.");
} finally {
  clearTimeout(timeout);
  await engine.close();
  await router.close();
  if (useMock) await new Promise<void>(resolve => provider.close(() => resolve()));
}
