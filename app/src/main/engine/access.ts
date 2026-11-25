import type { AccessMode } from "../../shared/workspace";

export function sessionAccess(mode: AccessMode, webSearch = false) {
  const rule = (action: string, effect: "allow" | "ask" | "deny", resource = "*") => ({ action, resource, effect });
  const readonly = mode === "read";
  const permissions = mode === "full" ? [rule("*", "allow")] : [
    rule("*", readonly ? "deny" : "ask"),
    ...["read", "glob", "grep", "list", "question", "skill", "todowrite", "todoread"].map(action => rule(action, "allow")),
    rule("edit", readonly ? "deny" : mode === "edit" ? "allow" : "ask"),
    ...(mode === "edit" ? [rule("edit", "deny", "../*")] : []),
    rule("shell", readonly ? "deny" : "ask"),
    rule("external_directory", "deny")
  ];
  return { agent: readonly ? "plan" : "build", permissions: [...permissions, rule("websearch", webSearch ? "allow" : "deny")] };
}
