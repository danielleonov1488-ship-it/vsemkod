import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, STATUS_CODES, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type { Socket } from "node:net";
import type { RemoteAccess } from "../shared/api";

type Target = { url: string; authorization: string };
const cookieName = "vsemkod_key";
const denied = "Нет доступа. Отсканируйте QR-код в vsemkod → Настройки → Доступ с телефона.";
const attemptWindow = 10 * 60_000;
const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

function responseHeaders(message: IncomingMessage): OutgoingHttpHeaders {
  const headers = { ...message.headers };
  const connection = message.headers.connection?.toLowerCase().split(",").map(value => value.trim()) ?? [];
  for (const name of [...hopHeaders, ...connection]) delete headers[name];
  return headers;
}

function addresses() {
  const local = (address: string) => /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
  const all = Object.values(networkInterfaces()).flatMap(entries =>
    entries?.filter(entry => !entry.internal && entry.family === "IPv4").map(entry => entry.address) ?? []);
  return [...new Set(all)].sort((a, b) => Number(local(b)) - Number(local(a)));
}

function sameOrigin(req: IncomingMessage) {
  return req.headers["sec-fetch-site"] !== "cross-site" &&
    (!req.headers.origin || req.headers.origin === "http://" + req.headers.host);
}

export class RemoteWeb {
  private server?: ReturnType<typeof createServer>;
  private port?: number;
  private password?: string;
  private sockets = new Set<Socket>();
  private attempts = new Map<string, { count: number; until: number }>();

  constructor(private readonly target: () => Promise<Target>) {}

  get enabled() { return this.server !== undefined; }

  state(): RemoteAccess["web"] {
    const { port, password } = this;
    if (port === undefined || !password) return { enabled: false, urls: [] };
    const urls = addresses().map(address => "http://" + address + ":" + port + "/?key=" + password);
    return { enabled: true, urls, password };
  }

  async start(firstPort = 47800, lastPort = 47820) {
    if (this.server) return;
    await this.target();
    this.password = randomBytes(18).toString("base64url");
    const server = createServer((req, res) => { void this.forward(req, res); });
    server.on("connection", socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("upgrade", (req, socket, head) => {
      void this.upgrade(req, socket as Socket, head);
    });
    for (let port = firstPort; port <= lastPort; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => { server.off("listening", ready); reject(error); };
          const ready = () => { server.off("error", failed); resolve(); };
          server.once("error", failed).once("listening", ready);
          server.listen(port, "0.0.0.0");
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Адрес сервера недоступен.");
        this.port = address.port;
        this.server = server;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          this.password = undefined;
          throw new Error("Не удалось открыть доступ в локальной сети.");
        }
      }
    }
    this.password = undefined;
    throw new Error("Порты 47800–47820 уже заняты.");
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.password = undefined;
    this.attempts.clear();
    if (!server) return;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  private authenticate(req: IncomingMessage, key: string | null): 200 | 401 | 429 {
    const now = Date.now();
    for (const [ip, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(ip);
    const ip = req.socket.remoteAddress ?? "";
    const attempt = this.attempts.get(ip);
    const cookie = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(cookieName + "="));
    const credential = key ?? cookie?.slice(cookieName.length + 1);
    if ((key === null || !attempt || attempt.count < 10) && this.password && credential?.length === this.password.length) {
      const value = Buffer.from(credential);
      const expected = Buffer.from(this.password);
      if (value.length === expected.length && timingSafeEqual(value, expected)) return 200;
    }
    if (attempt && attempt.count >= 10) return 429;
    const count = (attempt?.count ?? 0) + 1;
    this.attempts.set(ip, { count, until: count === 10 ? now + attemptWindow : attempt?.until ?? now + attemptWindow });
    return 401;
  }

  private async upstream(req: IncomingMessage, upgrade = false) {
    const target = await this.target();
    const headers = responseHeaders(req);
    delete headers.cookie;
    delete headers.referer;
    for (const name of Object.keys(headers)) {
      if (name === "forwarded" || name.startsWith("x-forwarded-")) delete headers[name];
    }
    const url = new URL(target.url);
    headers.host = url.host;
    headers.authorization = target.authorization;
    if (headers.origin) headers.origin = url.origin;
    if (upgrade) {
      headers.connection = "Upgrade";
      headers.upgrade = req.headers.upgrade;
    }
    return { url, upstream: request(url, { path: req.url, method: req.method, headers }) };
  }

  private async forward(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? "GET";
    const path = req.url ?? "";
    if (!path.startsWith("/") || path.startsWith("//")) { res.writeHead(400).end(); return; }
    if ((method !== "GET" && method !== "HEAD") && !sameOrigin(req)) { res.writeHead(403).end(); return; }
    const url = new URL("http://localhost" + path);
    const key = method === "GET" && url.pathname === "/" ? url.searchParams.get("key") : null;
    const status = this.authenticate(req, key);
    if (status !== 200) {
      if (status === 429) res.setHeader("Retry-After", Math.max(1, Math.ceil(
        ((this.attempts.get(req.socket.remoteAddress ?? "")?.until ?? Date.now()) - Date.now()) / 1000)));
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><meta charset=\"utf-8\"><title>Нет доступа</title><p>" + denied + "</p>");
      return;
    }
    if (key !== null) {
      res.writeHead(303, { location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer",
        "set-cookie": cookieName + "=" + key + "; Path=/; HttpOnly; SameSite=Lax" }).end();
      return;
    }

    const fail = () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end("Движок OpenCode недоступен.");
    };
    try {
      const { url: target, upstream } = await this.upstream(req);
      upstream.once("error", fail);
      if (res.destroyed) { upstream.destroy(); return; }
      res.once("close", () => upstream.destroy());
      upstream.once("response", incoming => {
        incoming.once("error", fail);
        const headers = responseHeaders(incoming);
        delete headers["set-cookie"];
        if (typeof headers.location === "string" && headers.location.startsWith(target.origin + "/")) {
          headers.location = headers.location.slice(target.origin.length);
        }
        headers["referrer-policy"] = "no-referrer";
        res.writeHead(incoming.statusCode ?? 502, headers);
        incoming.pipe(res);
      });
      req.pipe(upstream);
    } catch { fail(); }
  }

  private async upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    const reject = (status: number) => {
      if (!socket.destroyed) socket.end("HTTP/1.1 " + status + " " + STATUS_CODES[status] + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    };
    socket.on("error", () => socket.destroy());
    if (!sameOrigin(req)) { reject(403); return; }
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) { reject(400); return; }
    const status = this.authenticate(req, null);
    if (status !== 200) { reject(status); return; }
    socket.pause();
    try {
      const { upstream } = await this.upstream(req, true);
      upstream.once("error", () => reject(502));
      if (socket.destroyed) { upstream.destroy(); return; }
      socket.once("close", () => upstream.destroy());
      upstream.once("response", incoming => {
        incoming.resume();
        reject(incoming.statusCode ?? 502);
      });
      upstream.once("upgrade", (incoming, peer, initial) => {
        const headers = responseHeaders(incoming);
        delete headers["set-cookie"];
        const lines = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: " + incoming.headers.upgrade];
        for (const [name, value] of Object.entries(headers)) {
          for (const entry of Array.isArray(value) ? value : [value]) lines.push(name + ": " + entry);
        }
        socket.write(lines.join("\r\n") + "\r\n\r\n");
        if (initial.length) socket.write(initial);
        if (head.length) peer.write(head);
        const close = () => { peer.destroy(); socket.destroy(); };
        peer.on("error", close).once("close", close);
        socket.once("close", close);
        socket.pipe(peer).pipe(socket);
      });
      upstream.end();
    } catch { reject(502); }
  }
}
