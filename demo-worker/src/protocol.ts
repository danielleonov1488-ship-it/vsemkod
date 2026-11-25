export type Message = { role: "user" | "assistant"; content: string };

const messages = {
  limit: "Лимит демо исчерпан. Попробуйте позже.",
  busy: "Дождитесь завершения предыдущего ответа.",
  closed: "Дневная квота демо исчерпана. Демо снова откроется в 00:00 UTC.",
  auth: "Сессия истекла или недействительна. Обновите её и попробуйте снова.",
  bad_request: "Проверьте формат запроса и длину сообщений.",
  upstream: "Модель временно недоступна. Попробуйте позже.",
  turnstile: "Не удалось пройти проверку Turnstile. Попробуйте снова.",
  forbidden: "Этот источник не поддерживается.",
  not_found: "Маршрут не найден.",
  method: "Метод не поддерживается.",
};

export type ErrorCode = keyof typeof messages;
type ChatCode = Exclude<ErrorCode, "turnstile" | "forbidden" | "not_found" | "method">;
export type ChatEvent =
  | { t: "delta"; v: string }
  | { t: "done"; remaining: number }
  | { t: "error"; code: ChatCode; message: string };

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

export async function readJson(input: Request | Response, maxBytes: number): Promise<unknown> {
  if (!input.body) return;
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return;
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(utf8.decode(body));
  } catch {
    return;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function chatMessages(input: unknown): Message[] | undefined {
  const body = record(input);
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.messages)) return;
  const entries: unknown[] = body.messages;
  if (entries.length < 1 || entries.length > 8) return;
  let total = 0;
  const result: Message[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (!item || Object.keys(item).length !== 2 || typeof item.content !== "string") return;
    if (item.role !== "user" && item.role !== "assistant") return;
    const length = [...item.content].length;
    total += length;
    if (length > 2000 || total > 8000) return;
    result.push({ role: item.role, content: item.content });
  }
  if (result.at(-1)?.role === "user") return result;
}

export function originIsAllowed(origin: string, allowed: string[], dev: boolean): boolean {
  try {
    const url = new URL(origin);
    if (url.origin !== origin || !["https:", "http:"].includes(url.protocol)) return false;
    if (url.hostname === "localhost" && url.protocol === "http:") return dev;
    return allowed.includes(origin);
  } catch {
    return false;
  }
}

export function jsonError(code: ErrorCode, status: number): Response {
  return Response.json({ error: { code, message: messages[code] } }, { status });
}

export function chatErrorEvent(code: ChatCode): ChatEvent {
  return { t: "error", code, message: messages[code] };
}

export function sseEvent(event: ChatEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function sseResponse(body: ReadableStream<Uint8Array> | Uint8Array, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform" },
  });
}
