import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://localhost:8000";
const turnstile = "XXXX.DUMMY.TOKEN.XXXX";
const dummySecret = "1x0000000000000000000000000000000AA";

const smokeDir = join(root, ".wrangler", "smoke");
await mkdir(smokeDir, { recursive: true });
const state = await mkdtemp(join(smokeDir, "run-"));
const secret = randomBytes(32).toString("base64url");
const wrangler = spawn(process.execPath, [
  join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--local",
  "--ip", "127.0.0.1", "--port", "0", "--show-interactive-dev-session=false",
  "--persist-to", state, "--var", "DEV:1", "--var", "UPSTREAM_MOCK:1",
  "--var", `TURNSTILE_SECRET:${dummySecret}`, "--var", `SESSION_SECRET:${secret}`,
], {
  cwd: root,
  env: { ...process.env, NO_COLOR: "1", XDG_CONFIG_HOME: state, WRANGLER_LOG_PATH: join(state, "wrangler.log") },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
const ready = Promise.withResolvers();
wrangler.once("error", ready.reject);
wrangler.once("exit", () => ready.reject(new Error("Wrangler завершился до запуска")));
const closed = new Promise((resolve) => wrangler.once("close", resolve));
for (const stream of [wrangler.stdout, wrangler.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (text) => {
    output = (output + text).slice(-24_000);
    const address = /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    if (address) ready.resolve(address);
  });
}
const bootDeadline = setTimeout(() => ready.reject(new Error("Wrangler не запустился за 30 секунд")), 30_000);

async function chatEvents(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream\b/);
  return (await response.text()).trim().split(/\r?\n\r?\n/).map((event) => {
    assert.match(event, /^data: /);
    return JSON.parse(event.slice(6));
  });
}

try {
  const url = await ready.promise;
  clearTimeout(bootDeadline);
  function request(path, { method = "GET", body, token, from = origin } = {}) {
    const headers = { Origin: from, "User-Agent": "vsemkod-demo-smoke" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(new URL(path, url), { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  }

  const status = await request("/status");
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("access-control-allow-origin"), origin);
  const model = await status.json();
  assert.equal(model.open, true);
  assert.equal(model.model.id, "@cf/openai/gpt-oss-120b");
  assert.ok(model.model.name);
  console.log(`GET /status → 200, open=true (${model.model.name})`);

  const session = await request("/session", { method: "POST", body: { turnstile } });
  if (session.status !== 200) {
    const { error } = await session.json();
    throw new Error(`POST /session → ${session.status} (${error?.code ?? "unknown"})`);
  }
  const { token, expiresAt, remaining } = await session.json();
  assert.match(token, /^[\w-]+\.[\w-]+$/);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 15 * 60_000);
  assert.equal(remaining, 30);
  console.log("POST /session → 200, Turnstile OK, remaining=30");

  const turn = () => request("/chat", { method: "POST", token, body: { messages: [{ role: "user", content: "Привет" }] } });
  const events = await chatEvents(await turn());
  assert.deepEqual(events, [
    { t: "delta", v: "Привет! " }, { t: "delta", v: "Это ответ демо." }, { t: "done", remaining: 29 },
  ]);
  console.log("POST /chat → 200 SSE, delta ×2, done remaining=29");

  for (let count = 2; count <= 6; count++) {
    assert.deepEqual((await chatEvents(await turn())).at(-1), { t: "done", remaining: 30 - count });
  }
  const limited = await chatEvents(await turn());
  assert.equal(limited.length, 1);
  assert.equal(limited[0].t, "error");
  assert.equal(limited[0].code, "limit");
  console.log("POST /chat ×7 → 6 ответов, затем SSE error limit");

  const foreign = await request("/status", { from: "https://foreign.example" });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  console.log("Чужой Origin → 403");
  console.log("Smoke OK");
} catch (error) {
  console.error(error.message);
  if (output) console.error(output.replaceAll(secret, "[hidden]"));
  process.exitCode = 1;
} finally {
  clearTimeout(bootDeadline);
  if (wrangler.pid && wrangler.exitCode === null && wrangler.signalCode === null) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(wrangler.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      } catch { wrangler.kill(); }
    } else {
      wrangler.kill();
    }
  }
  await closed;
}
