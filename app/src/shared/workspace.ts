export const accessModes = ["read", "ask", "edit", "full"] as const;
export type AccessMode = typeof accessModes[number];
export const accessLabels: Record<AccessMode, string> = {
  read: "Только чтение", ask: "Спрашивать", edit: "Авто-правки", full: "Полный доступ"
};

export const builtInCommands = [
  { name: "new", description: "Новый чат" },
  { name: "compact", description: "Сжать контекст" },
  { name: "plan", description: "Перейти в режим «Только чтение»" },
  { name: "model", description: "Выбрать модель" },
  { name: "export", description: "Экспортировать чат в Markdown" }
];

export function slashCommand(text: string) {
  const match = /^\/([\p{L}\p{N}_.-]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  return match && { name: match[1], args: match[2] ?? "" };
}

export function suggestionAt(text: string, cursor: number) {
  const prefix = text.slice(0, cursor);
  const command = /^\/([\p{L}\p{N}_.-]*)$/u.exec(prefix);
  if (command) return { kind: "command" as const, query: command[1], start: 0, end: cursor };
  const mention = /(?:^|\s)@(?:"([^"\r\n]*)|([^\s"]*))$/.exec(prefix);
  if (mention) return { kind: "path" as const, query: mention[1] ?? mention[2], start: cursor - mention[0].trimStart().length, end: cursor };
}

export function pathMentions(text: string) {
  return Array.from(text.matchAll(/(?:^|(?<=\s))@(?:"([^"\r\n]+)"|([^\s"]+))/g)).flatMap(match => {
    const path = match[1] ?? (match[2] === "." ? "." : match[2].replace(/[.,;:!?)\]}]+$/, ""));
    if (!path) return [];
    const notation = match[1] ? match[0] : "@" + path;
    return [{ path, start: match.index, end: match.index + notation.length, text: notation }];
  });
}

export function enqueue<T>(queue: readonly T[], item: T, front = false): T[] {
  return front ? [item, ...queue] : [...queue, item];
}

export function dequeue<T>(queue: readonly T[]): [T | undefined, T[]] {
  return [queue[0], queue.slice(1)];
}

export function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function imageFile(name: string) {
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif|tiff?|ico|jxl|heif)$/i.test(name);
}
