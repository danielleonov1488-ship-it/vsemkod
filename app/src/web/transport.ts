export type DemoConfig = { DEMO_API: string; TURNSTILE_SITEKEY: string };
export type DemoStatus = { open: boolean; model: { id: string; name: string } };
export type DemoMessage = { role: "user" | "assistant"; content: string };
type Session = { token: string; expiresAt: number; remaining: number };
type StreamEvent = { t: "delta"; v: string } | { t: "done"; remaining: number } |
  { t: "error"; code: string; message: string };

export class DemoError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

let config: Promise<DemoConfig> | undefined;
export function demoConfig() {
  // The landing page owns these exports. The mock serves the same module with local values.
  const url = new URL("../app.js", location.href).href;
  return config ??= import(/* @vite-ignore */ url).catch(error => {
    config = undefined;
    throw error;
  });
}

async function endpoint(path: string, options?: RequestInit) {
  const { DEMO_API } = await demoConfig();
  if (!DEMO_API) throw new DemoError("closed", "Живой чат пока недоступен.");
  const response = await fetch(DEMO_API.replace(/\/+$/, "") + path, {
    cache: "no-store", credentials: "omit", ...options
  });
  if (response.ok) return response;
  const payload = await response.json().catch(() => null);
  const codes: Record<number, string> = { 401: "auth", 403: "auth", 429: "limit", 503: "closed" };
  throw new DemoError(payload?.error?.code ?? codes[response.status] ?? "upstream",
    payload?.error?.message ?? "Демо-API временно недоступен.");
}

export async function status(): Promise<DemoStatus> {
  const response = await endpoint("/status", { signal: AbortSignal.timeout(8000) });
  return response.json();
}

function post(body: object, signal: AbortSignal, token?: string): RequestInit {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", "Bearer " + token);
  return { method: "POST", headers, body: JSON.stringify(body), signal };
}

type Turnstile = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  execute(id: string): void;
  remove(id: string): void;
};

let script: Promise<Turnstile> | undefined;
export function preloadTurnstile() {
  return script ??= new Promise<Turnstile>((resolve, reject) => {
    const element = document.createElement("script");
    const failed = () => {
      clearTimeout(timeout);
      element.remove();
      reject(new DemoError("upstream", "Не удалось загрузить проверку Turnstile."));
    };
    const timeout = setTimeout(failed, 12_000);
    element.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    element.async = true;
    element.addEventListener("error", failed, { once: true });
    element.addEventListener("load", () => {
      const turnstile = (window as Window & { turnstile?: Turnstile }).turnstile;
      if (turnstile) { clearTimeout(timeout); resolve(turnstile); }
      else failed();
    }, { once: true });
    document.head.append(element);
  }).catch(error => {
    script = undefined;
    throw error;
  });
}

async function turnstileToken(sitekey: string, signal: AbortSignal) {
  const turnstile = await preloadTurnstile();
  const challenge = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  challenge.throwIfAborted();
  const host = document.createElement("div");
  host.className = "harness-turnstile";
  document.body.append(host);
  let id: string | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const failed = () => reject(new DemoError("upstream", "Проверка Turnstile не пройдена."));
      abort = () => signal.aborted ? reject(signal.reason) : failed();
      challenge.addEventListener("abort", abort, { once: true });
      id = turnstile.render(host, {
        sitekey, execution: "execute", appearance: "interaction-only", retry: "never",
        callback: resolve, "error-callback": failed, "expired-callback": failed,
        "timeout-callback": failed, "unsupported-callback": failed
      });
      turnstile.execute(id);
    });
  } finally {
    challenge.removeEventListener("abort", abort);
    if (id !== undefined) turnstile.remove(id);
    host.remove();
  }
}

export async function startSession(signal: AbortSignal): Promise<Session> {
  const { TURNSTILE_SITEKEY } = await demoConfig();
  const turnstile = await turnstileToken(TURNSTILE_SITEKEY, signal);
  const response = await endpoint("/session", post({ turnstile }, signal));
  return response.json();
}

export async function streamChat(token: string, messages: DemoMessage[], signal: AbortSignal, delta: (text: string) => void) {
  const response = await endpoint("/chat", post({ messages }, signal, token));
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    throw new DemoError("upstream", "Сервер не вернул поток ответа.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let separator = /\r?\n\r?\n/.exec(buffer); separator; separator = /\r?\n\r?\n/.exec(buffer)) {
        const data = buffer.slice(0, separator.index).split(/\r?\n/)
          .filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        buffer = buffer.slice(separator.index + separator[0].length);
        if (!data) continue;
        const event = JSON.parse(data) as StreamEvent;
        if (event.t === "done") return event.remaining;
        if (event.t === "error") throw new DemoError(event.code, event.message);
        if (event.t === "delta") delta(event.v);
      }
    }
    throw new DemoError("upstream", "Ответ прервался. Попробуй ещё раз.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
