import type { ChatPart } from "../shared/api";

type UserPart = Extract<ChatPart, { kind: "user" | "text" }>;
type TurnEnd = Extract<ChatPart, { kind: "turn" }>;
type AgentPart = Exclude<ChatPart, TurnEnd>;

export type ChatStatus = "working" | "permission" | "question" | "error";
export const chatStatusLabel: Record<ChatStatus, string> = {
  working: "Агент работает", permission: "Ждёт разрешения", question: "Ждёт ответа", error: "Ошибка"
};

export function groupTurns(parts: ChatPart[]) {
  const turns: { user?: UserPart; agent: AgentPart[]; end?: TurnEnd }[] = [];
  for (const part of parts) {
    if (part.kind === "user") turns.push({ user: part, agent: [] });
    else {
      if (!turns.length) turns.push({ agent: [] });
      const current = turns.at(-1)!;
      if (part.kind === "turn") current.end = part;
      else current.agent.push(part);
    }
  }
  return turns;
}

export function turnContent(parts: AgentPart[], live: boolean, end?: TurnEnd) {
  const lastAction = parts.findLastIndex(part => part.kind === "tool" || part.kind === "note");
  const work = parts.filter((part, index) => part.kind !== "text" || index <= lastAction);
  const answer = parts.filter((part, index): part is UserPart => part.kind === "text" && index > lastAction);
  return { work, answer, actions: work.filter(part => part.kind === "tool").length, collapsed: !live,
    seconds: end?.seconds ?? work.reduce((total, part) => total + (part.kind === "reasoning" ? part.seconds ?? 0 : 0), 0) };
}

export function duration(seconds: number) {
  const total = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(total / 60);
  return (minutes ? minutes + " мин " : "") + total % 60 + " с";
}
