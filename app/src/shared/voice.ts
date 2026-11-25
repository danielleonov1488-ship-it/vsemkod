export const voiceModels = ["accurate", "fast"] as const;
export type VoiceModel = typeof voiceModels[number];
export type VoiceSilence = 0 | 10 | 30;

export const voiceDefaults = {
  voiceModel: "accurate", voiceLanguage: "auto", voiceSilence: 30, voiceDevice: "", voiceGroq: false
} as const;

// Whisper language codes, including Cantonese (large-v3 and large-v3-turbo).
export const voiceLanguages = ("af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu " +
  "ha haw he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn " +
  "no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo yue zh").split(" ");

export const voiceLabels: Record<VoiceModel, string> = { accurate: "Точная", fast: "Быстрая" };
export const voiceModelBytes: Record<VoiceModel, number> = { accurate: 574_041_195, fast: 147_951_465 };
export const vadBytes = 885_098;
export const voiceRate = 16_000;
export const voiceHop = 512;
export const voiceChunk = 2048;

export interface VoiceStatus {
  models: Record<VoiceModel, { installed: number; partial: number }>;
  vadInstalled: boolean;
  recommendFast: "memory" | "cpu" | null;
  groq: boolean;
  rtf?: number;
  download?: VoiceProgress;
}
export interface VoiceProgress {
  model: VoiceModel;
  received: number;
  total: number;
  phase: "download" | "verify" | "benchmark";
}
export type VoiceEvent =
  | { type: "progress"; progress: VoiceProgress }
  | { type: "status"; status: VoiceStatus }
  | { type: "partial" | "final"; id: string; phrase: number; text: string }
  | { type: "silence" | "done"; id: string }
  | { type: "error"; id: string; message: string };

export interface VoiceApi {
  status(): Promise<VoiceStatus>;
  download(model: VoiceModel, consent: boolean, vadOnly?: boolean): Promise<VoiceStatus>;
  pause(): Promise<void>;
  remove(model: VoiceModel): Promise<VoiceStatus>;
  start(id: string): Promise<void>;
  audio(id: string, pcm: ArrayBuffer): Promise<void>;
  stop(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  subscribe(listener: (event: VoiceEvent) => void): () => void;
}

export function mergeVoiceText(left: string, right: string): string {
  if (!left || !right || /\s$/.test(left) || /^(?:\s|[.,;:!?…。，、；：！？)\]}])/u.test(right) ||
      /[({\[«]$/u.test(left) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left) &&
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right)) return left + right;
  return left + " " + right;
}

export type VoiceDraft = { text: string; start: number; end: number; spoken: string;
  partial?: { phrase: number; text: string }; lastFinal: number };

export function updateVoiceDraft(draft: VoiceDraft, type: "partial" | "final", phrase: number, text: string): VoiceDraft {
  if (phrase <= draft.lastFinal) return draft;
  if (type === "partial") {
    if (draft.partial && phrase < draft.partial.phrase) return draft;
    return { ...draft, partial: { phrase, text: text.trim() } };
  }
  return { ...draft, spoken: mergeVoiceText(draft.spoken, text.trim()), lastFinal: phrase,
    partial: draft.partial && draft.partial.phrase > phrase ? draft.partial : undefined };
}

export function insertVoiceDraft(draft: VoiceDraft): { text: string; cursor: number } {
  if (!draft.spoken) return { text: draft.text, cursor: draft.start };
  const head = mergeVoiceText(draft.text.slice(0, draft.start), draft.spoken);
  return { text: mergeVoiceText(head, draft.text.slice(draft.end)), cursor: head.length };
}
