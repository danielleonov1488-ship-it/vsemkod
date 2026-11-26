import { useRef, useState } from "react";
import type { Attachment, ChatEvent, ChatHistory, ChatPart, FileChange, Permission, Question, ReplySpeed, TurnOptions, Usage } from "../shared/api";
import type { ChatStatus } from "./turns";
import type { AccessMode } from "../shared/workspace";

export type PendingTurn = { text: string; modelId: string; files: Attachment[]; options: TurnOptions };
export type ChatView = {
  parts: ChatPart[]; changes: FileChange[]; permissions: Permission[]; questions: Question[];
  loaded?: boolean; loading?: boolean; reverted?: boolean; planReady?: boolean;
  draft: string; files: Attachment[]; replayId?: string; access?: AccessMode; model?: string; variant: string;
  usage?: Usage; speed?: ReplySpeed; liveSpeed?: ReplySpeed; cache?: number; provider?: string; routedModel?: string;
  progress?: { started: number; since: number | null };
  failure?: { message: string; turn: PendingTurn };
};

export const emptyView: ChatView = { parts: [], changes: [], permissions: [], questions: [], draft: "", files: [], variant: "" };

export function useChatViews() {
  const [views, setViews] = useState<Record<string, ChatView>>({});
  const current = useRef(views);
  const [running, setRunning] = useState<Record<string, ChatStatus>>({});
  const statuses = useRef(running);

  function update(id: string, apply: (view: ChatView) => Partial<ChatView>) {
    const before = current.current[id] ?? emptyView;
    current.current = { ...current.current, [id]: { ...before, ...apply(before) } };
    setViews(current.current);
  }

  function reset(id: string, values?: Partial<ChatView>) {
    current.current = { ...current.current, [id]: { ...emptyView, ...values } };
    setViews(current.current);
  }

  function status(id: string, next?: ChatStatus) {
    if (statuses.current[id] === next) return;
    const state = { ...statuses.current };
    if (next) state[id] = next;
    else delete state[id];
    statuses.current = state;
    setRunning(state);
  }
  return { views, current, update, reset, running, statuses, status };
}

export function isRunning(status?: ChatStatus) {
  return status === "working" || status === "queued" || status === "permission" || status === "question";
}

function replacePart(parts: ChatPart[], part: ChatPart) {
  const index = parts.findIndex(item => item.id === part.id);
  return index < 0 ? [...parts, part] : parts.map((item, position) => position === index ? part : item);
}

function replaceById<T extends { id: string }>(items: T[], item: T) {
  return [...items.filter(previous => previous.id !== item.id), item];
}

export function applyHistory(history: ChatHistory): Partial<ChatView> {
  return { parts: history.parts, changes: history.changes, reverted: !!history.reverted, usage: history.usage, ...(history.speed && { speed: history.speed }), loaded: true };
}

export function applyChatEvent(view: ChatView, event: ChatEvent): Partial<ChatView> {
  switch (event.type) {
    case "part":
      return { parts: replacePart(view.parts, event.part) };
    case "delta": {
      const kind = event.kind ?? "text";
      const part = view.parts.find(part => part.id === event.partId);
      return { parts: replacePart(view.parts, { id: event.partId, kind, text: (part?.kind === kind ? part.text : "") + event.delta }) };
    }
    case "turn-status": {
      const started = Date.now();
      return { progress: event.status === "working" ? { started, since: started } : undefined };
    }
    case "model-wait":
      return { progress: view.progress && { ...view.progress, since: event.since } };
    case "permission":
      return { permissions: replaceById(view.permissions, event.permission) };
    case "permission-resolved":
      return { permissions: view.permissions.filter(item => item.id !== event.id) };
    case "question":
      return { questions: replaceById(view.questions, event.question) };
    case "question-resolved":
      return { questions: view.questions.filter(item => item.id !== event.id) };
    case "usage":
      return { usage: event.usage, speed: event.speed ?? view.speed,
        cache: event.nativeCachePercent === undefined ? view.cache : event.nativeCachePercent ?? undefined };
    case "reply-speed":
      return event.live ? { liveSpeed: event.speed } : { speed: event.speed, liveSpeed: undefined };
    case "reply-cache":
      return { cache: event.cachePercent };
    case "route":
      return { provider: event.providerId, routedModel: event.modelId };
  }
}
