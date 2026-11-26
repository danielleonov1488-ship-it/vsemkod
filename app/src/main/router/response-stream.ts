
import { once } from "node:events";
import type { ServerResponse } from "node:http";

type Choice = {
  index?: number;
  finish_reason?: string | null;
  delta?: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    reasoning_details?: unknown;
    tool_calls?: unknown[];
  };
};

export class CompletionStream {
  text = "";
  reasoning = false;
  tools = false;
  finished = false;
  done = false;

  event(frame: string, continuation: boolean) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n").trim();
    if (data === "[DONE]") this.done = true;
    if (!data || this.done) return frame;
    let event: { choices?: Choice[]; error?: unknown };
    try { event = JSON.parse(data); }
    catch { return frame; }
    if (event?.error) throw new Error("Поставщик вернул ошибку в потоке.");
    if (!Array.isArray(event?.choices)) return frame;
    const choice = event.choices.find((choice, index) => choice && (choice.index ?? index) === 0);
    if (!choice) return frame;
    this.finished ||= choice.finish_reason != null;
    const delta = choice.delta;
    if (!delta) return frame;
    if (typeof delta.content === "string") this.text += delta.content;
    this.reasoning ||= Boolean(delta.reasoning_content || delta.reasoning || delta.reasoning_details);
    this.tools ||= Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
    if (continuation && delta.role !== undefined) {
      delete delta.role;
      if (!Object.keys(delta).length && !choice.finish_reason && event.choices.length === 1 && !("usage" in event)) return "";
      return "data: " + JSON.stringify(event) + "\n\n";
    }
    return frame;
  }
}

export async function writeChunk(res: ServerResponse, chunk: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!res.write(chunk)) await once(res, "drain", { signal });
}

export async function* responseChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array, controller: AbortController, stallMs: number
) {
  yield first;
  for (;;) {
    const timer = setTimeout(() => controller.abort(), stallMs);
    const next = await reader.read().finally(() => clearTimeout(timer));
    if (next.done) return;
    yield next.value;
  }
}

export async function* sseFrames(chunks: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = "";
  let cursor = 0;
  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    const separator = /\r?\n\r?\n/g;
    separator.lastIndex = cursor;
    let start = 0;
    for (let match = separator.exec(pending); match; match = separator.exec(pending)) {
      yield pending.slice(start, separator.lastIndex);
      start = separator.lastIndex;
    }
    pending = pending.slice(start);
    if (pending.length > 4 * 1024 * 1024) throw new Error("Слишком длинное событие SSE.");
    cursor = Math.max(0, pending.length - 3);
  }
}

export async function errorPrefix(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const bytes = new Uint8Array(4096);
  let size = 0;
  try {
    while (size < bytes.length) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, bytes.length - size);
      bytes.set(chunk, size);
      size += chunk.length;
    }
  } catch { /* A truncated error can still carry a quota message. */ }
  finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder().decode(bytes.subarray(0, size));
}
