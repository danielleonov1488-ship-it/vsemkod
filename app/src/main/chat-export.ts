import type { ChatPart } from "../shared/api";

function codeBlock(text: string, language = "") {
  const size = Math.max(2, ...Array.from(text.matchAll(/`+/g), run => run[0].length)) + 1;
  const fence = "`".repeat(size);
  return fence + language + "\n" + text + "\n" + fence;
}

export function chatMarkdown(title: string, parts: ChatPart[]) {
  const lines = ["# " + title.replace(/\s+/g, " ").trim()];
  let speaker = "";
  for (const part of parts) {
    const next = part.kind === "user" ? "Вы" : "Агент";
    if (next !== speaker) lines.push("## " + next);
    speaker = next;
    if (part.kind === "tool") {
      lines.push("**" + part.tool + "** " + part.target);
      const changes = part.diffs?.length ? part.diffs : part.diff ? [part.diff] : [];
      if (changes.length) lines.push(...changes.map(change => codeBlock(change.patch, "diff")));
      else if (part.output) lines.push(codeBlock(part.output));
    } else if (part.kind === "user" || part.kind === "text") {
      lines.push(part.text);
      if (part.files?.length) lines.push("Файлы: " + part.files.join(", "));
    } else if (part.kind === "note") lines.push(part.text);
  }
  return lines.join("\n\n") + "\n";
}
