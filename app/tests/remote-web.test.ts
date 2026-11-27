import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteWeb } from "../src/main/remote-web";

vi.mock("node:os", () => ({
  networkInterfaces: () => ({
    first: [{ family: "IPv4", address: "203.0.113.1", internal: false }],
    wifi: [{ family: "IPv4", address: "192.168.1.2", internal: false }],
    loop: [{ family: "IPv4", address: "127.0.0.1", internal: true }]
  })
}));

const authorization = "Basic test-engine";
let upstream: ReturnType<typeof createServer>;
let proxy: RemoteWeb;
let base: string;
let password: string;
let cookie: string;
const peers = new Set<Socket>();

beforeEach(async () => {
  upstream = createServer((req, res) => {
    if (req.headers.authorization !== authorization || req.headers.cookie) { res.writeHead(400).end(); return; }
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: начало\n\n");
      return;
    }
    res.end("OpenCode");
  });
  upstream.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== authorization || req.headers.cookie) { socket.destroy(); return; }
    const peer = socket as Socket;
    peers.add(peer);
    peer.once("close", () => peers.delete(peer));
    peer.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    if (head.length) peer.write(head);
    peer.on("data", data => peer.write(data));
  });
  upstream.listen(0, "0.0.0.0");
  await once(upstream, "listening");
  proxy = new RemoteWeb(async () => ({ url: "http://127.0.0.1:" + (upstream.address() as AddressInfo).port, authorization }));
  await proxy.start(0, 0);
  const state = proxy.state();
  const url = new URL(state.urls[0]);
  base = "http://127.0.0.1:" + url.port;
  password = state.password!;
  cookie = "vsemkod_key=" + password;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await proxy.stop();
  for (const peer of peers) peer.destroy();
  upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
});

describe("доступ к веб-интерфейсу OpenCode", () => {
  it("отдаёт 401, а ссылка выдаёт HttpOnly-cookie и редирект", async () => {
    const denied = await fetch(base);
    expect(denied.status).toBe(401);
    expect(await denied.text()).toContain("Отсканируйте QR-код");
    const login = await fetch(base + "/?key=" + password, { redirect: "manual" });
    expect(password).toMatch(/^[\w-]{24}$/);
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    expect(login.headers.getSetCookie()).toEqual([cookie + "; Path=/; HttpOnly; SameSite=Lax"]);
    const response = await fetch(base, { headers: { cookie, authorization: "other" } });
    expect(await response.text()).toBe("OpenCode");
    expect(proxy.state().urls.map(value => new URL(value).hostname)).toEqual(["192.168.1.2", "203.0.113.1"]);
    expect((await fetch(base, { method: "POST", headers: { cookie, origin: "https://other.example" } })).status).toBe(403);
  });

  it("блокирует попытки после десяти ошибок и снимает блокировку через 10 минут", async () => {
    const initial = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
    for (let i = 0; i < 10; i++) {
      expect((await fetch(base + "/?key=bad")).status).toBe(401);
    }
    const locked = await fetch(base + "/?key=" + password, { redirect: "manual" });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("600");
    expect((await fetch(base, { headers: { cookie } })).status).toBe(200);
    clock.mockReturnValue(initial + 600_000);
    expect((await fetch(base + "/?key=" + password, { redirect: "manual" })).status).toBe(303);
  });

  it("передаёт SSE сразу и закрывает открытый поток при отключении", async () => {
    const response = await fetch(base + "/event", { headers: { cookie } });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("data: начало\n\n");
    await proxy.stop();
    await expect(reader.read()).rejects.toThrow();
  });

  it("проверяет cookie на upgrade и передаёт байты в обе стороны", async () => {
    const open = () => createConnection(Number(new URL(base).port), "127.0.0.1");
    const headers = "GET /socket HTTP/1.1\r\nHost: " + new URL(base).host + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n";
    const denied = open();
    denied.end(headers + "\r\n");
    expect(String((await once(denied, "data"))[0])).toContain("401 Unauthorized");
    const socket = open();
    try {
      let received = "";
      const complete = new Promise<string>((resolve, reject) => {
        socket.on("error", reject);
        socket.on("data", data => {
          received += data.toString();
          if (received.endsWith("firstsecond")) resolve(received);
        });
      });
      socket.write(headers + "Cookie: " + cookie + "\r\nOrigin: " + base + "\r\n\r\nfirst");
      expect(String((await once(socket, "data"))[0])).toContain("101 Switching Protocols");
      socket.write("second");
      expect(await complete).toContain("firstsecond");
    } finally { socket.destroy(); }
  });

  it("переходит к следующему порту и меняет ключ по повторному включению", async () => {
    const blockedPort = (upstream.address() as AddressInfo).port;
    if (blockedPort === 65535) throw new Error("У тестового порта нет следующего порта.");
    await proxy.stop();
    await proxy.start(blockedPort, Math.min(blockedPort + 4, 65535));
    expect(Number(new URL(proxy.state().urls[0]).port)).toBeGreaterThan(blockedPort);
    expect(proxy.state().password).not.toBe(password);
  });
});
