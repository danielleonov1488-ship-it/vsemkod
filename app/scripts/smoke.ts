import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeOffers, rankedModels } from "../src/shared/catalog";
import { CatalogService } from "../src/main/catalog-service";
import { EngineService, engineBinary } from "../src/main/engine/service";
import { Router } from "../src/main/router";
import { ProviderHealth } from "../src/main/router/health";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".vsemkod-dev");
await mkdir(local, { recursive: true });
const data = await mkdtemp(join(local, "smoke-"));
const project = join(data, "project");
await mkdir(project);
const catalog = new CatalogService(data, join(root, "resources", "catalog.json"));
await catalog.loadInitial();
await catalog.refresh();
const model = rankedModels(catalog.current).find(candidate =>
  activeOffers(catalog.current, candidate.id).some(({ offer, provider }) =>
    provider.id === "kilo" && provider.auth.type === "none" && offer.supportsTools));
assert(model, "Нет бесплатной модели Kilo с инструментами.");
const router = new Router({
  catalog: () => catalog.current, key: () => undefined, health: new ProviderHealth(join(data, "usage.json"))
});
await router.start();
let sessionId = "";
let permissions = 0;
let action = "";
let decision: "always" | "reject" = "always";
const acknowledgements: Promise<void>[] = [];
const engine = new EngineService(engineBinary(join(root, "resources")), join(data, "engine"), () => catalog.current, router, event => {
  if (event.type === "permission") {
    permissions++;
    console.log("Разрешение OpenCode:", event.permission.action, event.permission.resources.join(", "));
    const approval = engine.answer(sessionId, event.permission.id, decision);
    void approval.catch(console.error);
    acknowledgements.push(approval);
  } else if (event.type === "part" && event.part.kind === "tool" && event.part.status === "completed") {
    action = event.part.tool;
    console.log("Инструмент OpenCode:", action, event.part.target);
  }
});
const timeout = setTimeout(() => {
  console.error("Время интеграционного теста истекло.");
  void engine.close().then(() => router.close()).finally(() => process.exit(1));
}, 145_000);

try {
  const response = await fetch(router.baseUrl + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + router.token, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id, stream: true, max_tokens: 128,
      messages: [{ role: "user", content: "Reply with OK." }]
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const stream = await response.text();
  assert.equal(response.status, 200, stream);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(stream, /"content":"OK"/i);
  assert.match(stream, /data: \[DONE\]/);
  console.log("Router → Kilo:", model.id, "HTTP 200, SSE «OK» и [DONE], без ключа");
  const client = await engine.ready();
  const session = await client.create(project, "Проверка этапа A");
  sessionId = session.id;
  assert.deepEqual(await client.providerIds(project), ["vsemkod"]);
  console.log("Сессия OpenCode создана.");
  const result = await engine.send(sessionId, project, "Создай файл hello.txt со словом привет. Используй инструмент записи файла. Ответь по-русски.", model.id, false, []);
  await Promise.all(acknowledgements);
  assert.equal((await readFile(join(project, "hello.txt"), "utf8")).trim(), "привет");
  assert(permissions > 0, "Движок не запросил разрешение.");
  assert(action, "Движок не передал действие в интерфейс.");
  assert(result.changes.some(change => change.file.endsWith("hello.txt") && change.patch.includes("+привет")), "Дифф создания файла отсутствует.");
  const history = await engine.history(sessionId, project);
  assert(history.parts.some(part => part.kind === "user"), "История чата OpenCode не загрузилась.");
  console.log("OpenCode → Router → Kilo: hello.txt содержит «привет». Действие, разрешение и дифф получены.");

  const initialPermissions = permissions;
  action = "";
  await engine.send(sessionId, project,
    "Повторно запиши в hello.txt слово привет инструментом write. Нужна именно повторная запись файла, даже если там уже есть это слово.", model.id, false, []);
  assert.equal(permissions, initialPermissions, "Разрешение в том же чате должно примениться автоматически.");
  assert.equal(action, "write");

  decision = "reject";
  sessionId = (await client.create(project, "Проверка запрета в новом чате")).id;
  await engine.send(sessionId, project,
    "Попробуй создать forbidden.txt со словом тест инструментом write. Если пользователь запретит эту запись, сообщи об этом и не повторяй попытку.", model.id, false, []);
  await Promise.all(acknowledgements);
  assert(permissions > initialPermissions, "Разрешение должно быть ограничено первым чатом.");
  await assert.rejects(access(join(project, "forbidden.txt")), { code: "ENOENT" });
  console.log("«Разрешить всегда» действует в одном чате. В другом чате запись была запрещена.");
} finally {
  clearTimeout(timeout);
  await engine.close();
  await router.close();
}
