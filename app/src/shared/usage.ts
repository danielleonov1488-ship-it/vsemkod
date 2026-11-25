import type { ReplySpeed } from "./api";

export function replySpeed(output: number, reasoning: number, start: number, first: number | undefined, end: number): ReplySpeed | undefined {
  if (first === undefined || ![output, reasoning, start, first, end].every(Number.isFinite) ||
    output < 0 || reasoning < 0 || first < start || end <= first || output + reasoning <= 0) return;
  return { tokensPerSecond: (output + reasoning) * 1000 / (end - first), firstTokenMs: first - start };
}

export function cachePercent(input: number, read: number | undefined): number | undefined {
  if (read === undefined || !Number.isFinite(input) || !Number.isFinite(read) || input < 0 || read < 0 || input + read === 0) return;
  return read / (input + read) * 100;
}

export function modelDisplayName(name: string, catalogName?: string): string {
  return (catalogName || name).trim().replace(/^NVIDIA:\s*/i, "").replace(/\s+\(free\)$/i, "").trim();
}
