
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

type Command =
  | { name: "help" | "version" | "tui" | "doctor" | "update" | "connections" }
  | { name: "run"; prompt: string; model?: string; json: boolean; dir?: string }
  | { name: "serve" | "web"; port: number; hostname: string; password?: string }
  | { name: "models"; all: boolean }
  | { name: "connect"; provider: string; url?: string; accountId?: string }
  | { name: "disconnect"; provider: string };

export function parseCliArgs(args: string[]): Command {
  if (!args.length) return { name: "tui" };
  const [name, ...rest] = args;
  if (name === "--help" || name === "-h" || name === "help") return { name: "help" };
  if ((name === "--version" || name === "-v") && !rest.length) return { name: "version" };

  const invalid = () => new Error("Неверные аргументы. См. vsemkod help.");
  const parse = <T extends ParseArgsOptionsConfig>(options: T) => {
    try {
      return parseArgs({ args: rest, options, allowPositionals: true, strict: true });
    } catch {
      throw invalid();
    }
  };

  switch (name) {
    case "run": {
      const { values, positionals } = parse({ model: { type: "string" }, json: { type: "boolean" }, dir: { type: "string" } });
      const prompt = positionals.join(" ");
      if (!prompt.trim() || values.model === "" || values.dir === "") throw invalid();
      return { name, prompt, model: values.model, json: values.json ?? false, dir: values.dir };
    }
    case "serve":
    case "web": {
      const { values, positionals } = parse({ port: { type: "string" }, hostname: { type: "string" }, password: { type: "string" } });
      const port = Number(values.port ?? "4096");
      const hostname = values.hostname ?? "127.0.0.1";
      if (positionals.length || values.port !== undefined && !/^\d+$/.test(values.port) ||
        !Number.isInteger(port) || port > 65535 || !hostname.trim() || values.password === "") throw invalid();
      return { name, port, hostname, password: values.password };
    }
    case "models": {
      const { values, positionals } = parse({ all: { type: "boolean" } });
      if (positionals.length) throw invalid();
      return { name, all: values.all ?? false };
    }
    case "connect": {
      const { values, positionals } = parse({ list: { type: "boolean" }, url: { type: "string" }, "account-id": { type: "string" } });
      if (values.list && !positionals.length && values.url === undefined && values["account-id"] === undefined) return { name: "connections" };
      if (!values.list && positionals.length === 1 && values.url !== "") return { name, provider: positionals[0], url: values.url,
        ...(values["account-id"] !== undefined ? { accountId: values["account-id"] } : {}) };
      throw invalid();
    }
    case "disconnect":
      if (rest.length === 1 && !rest[0].startsWith("-")) return { name, provider: rest[0] };
      throw invalid();
    case "doctor":
    case "update":
      if (!rest.length) return { name };
      throw invalid();
    default:
      throw new Error("Неизвестная команда. См. vsemkod help.");
  }
}
