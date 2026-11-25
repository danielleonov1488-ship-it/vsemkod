import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAnswer } from "../src/upstreams";

const history = [{ role: "user" as const, content: "Сообщение" }];
const primary = "@cf/openai/gpt-oss-120b";
const backup = "@cf/zai-org/glm-4.7-flash";
const encoder = new TextEncoder();

function provider(run: ReturnType<typeof vi.fn>) {
  return { AI: { run } as unknown as Ai, AI_MODEL: primary, AI_BACKUP_MODEL: backup };
}

function sse(...lines: (object | string)[]): ReadableStream<Uint8Array> {
  return new Response(lines.map((line) => `data: ${typeof line === "string" ? line : JSON.stringify(line)}\r\n\r\n`).join("")).body!;
}

const final = (content: string) => ({ choices: [{ delta: { content } }] });
const done = (content: string) => sse(final(content), "[DONE]");

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("апстримы", () => {
  it("переключается после 429 и отправляет модели только заданный промпт, историю и лимит", async () => {
    const run = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(done("Резерв"));
    const chunks: string[] = [];
    expect(await streamAnswer(provider(run), history, new AbortController().signal, (chunk) => chunks.push(chunk))).toBe("done");
    expect(chunks).toEqual(["Резерв"]);
    const messages = [{ role: "system", content: expect.stringContaining("vsemkod.ru") }, ...history];
    expect(run).toHaveBeenNthCalledWith(1, primary, { messages, stream: true, max_tokens: 900, reasoning_effort: "low" });
    expect(run).toHaveBeenNthCalledWith(2, backup, { messages, stream: true, max_completion_tokens: 900 });
    expect(console.warn).toHaveBeenCalledWith("upstream_429");
  });

  it("разбирает разрезанные UTF-8 и SSE и отфильтровывает рассуждения и служебные поля", async () => {
    const text = [
      { choices: [{ delta: { reasoning_content: "скрыто", tool_calls: [{ id: "hidden" }] } }] },
      { choices: [{ delta: { content: "скрыто", channel: "analysis" } }] },
      final("Ответ 🧪"),
      { response: "", usage: { total_tokens: 40 } },
    ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const run = vi.fn().mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        const bytes = encoder.encode(text);
        for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
        controller.close();
      },
    }));
    const chunks: string[] = [];
    expect(await streamAnswer(provider(run), history, new AbortController().signal, (chunk) => chunks.push(chunk))).toBe("done");
    expect(chunks).toEqual(["Ответ 🧪"]);
  });

  it.each([
    [{ choices: [{ delta: { reasoning_content: "hidden" } }] }, []],
    [final("Частичный"), ["Частичный"]],
  ])("не переключается после любого первого байта", async (event, expected) => {
    const run = vi.fn().mockResolvedValueOnce(sse(event, { error: { status: 503 } })).mockResolvedValueOnce(done("запасной"));
    const chunks: string[] = [];
    expect(await streamAnswer(provider(run), history, new AbortController().signal, (chunk) => chunks.push(chunk))).toBe("upstream");
    expect(run).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(expected);
  });

  it("ждёт первый байт максимум 20 с даже после заголовков и отменяет чтение", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const run = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }))).mockResolvedValueOnce(done("Резерв"));
    const answer = streamAnswer(provider(run), history, new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(19_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe("done");
    expect(run).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("ограничивает всю цепочку 60 с и отменяет внешний fetch", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise(() => {}));
    const external = vi.fn(async (_url, { signal }) => {
      expect(signal.aborted).toBe(false);
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(": heartbeat\n\n")); },
      }));
    });
    vi.stubGlobal("fetch", external);
    const env = { ...provider(run), FALLBACK_API_KEY: "test", FALLBACK_BASE_URL: "https://provider.example/v1", FALLBACK_MODEL: "reserve" };
    const answer = streamAnswer(env, history, new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(59_999);
    expect(external).toHaveBeenCalledOnce();
    expect(external.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe("upstream");
    expect(external.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("закрывает демо только при исчерпании квоты у всех доступных источников", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("AiError: 3036: Daily allocation"))
      .mockRejectedValueOnce({ errors: [{ code: 3036 }] });
    const fetch = vi.fn(async () => Response.json({ error: { code: "rate_limit_exceeded", message: "Tokens per day (TPD)" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    const env = { ...provider(run), FALLBACK_BASE_URL: "https://provider.example/v1", FALLBACK_MODEL: "reserve" };
    expect(await streamAnswer(env, history, new AbortController().signal, () => {})).toBe("closed");
    expect(fetch).not.toHaveBeenCalled();
    run.mockRejectedValue({ status: 429 });
    expect(await streamAnswer({ ...env, FALLBACK_API_KEY: "test" }, history, new AbortController().signal, () => {})).toBe("upstream");
    run.mockRejectedValue({ internalCode: 3036, status: 429 });
    expect(await streamAnswer({ ...env, FALLBACK_API_KEY: "test" }, history, new AbortController().signal, () => {})).toBe("closed");
    expect(fetch).toHaveBeenLastCalledWith(new URL("https://provider.example/v1/chat/completions"), expect.objectContaining({
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      redirect: "manual",
      body: expect.stringContaining('"max_tokens":900'),
    }));
  });

  it("при отмене клиентом не переключает модель и отменяет её стрим", async () => {
    const cancel = vi.fn();
    const run = vi.fn().mockResolvedValue(new ReadableStream({ cancel }));
    const disconnect = new AbortController();
    const answer = streamAnswer(provider(run), history, disconnect.signal, () => {});
    disconnect.abort();
    expect(await answer).toBe("cancelled");
    expect(run).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
