
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { writeJson } from "../main/storage";

export async function engineEnvironment(data: string) {
  const home = join(data, "opencode");
  const temporary = join(home, "tmp");
  await Promise.all([mkdir(join(home, "home"), { recursive: true }), mkdir(temporary, { recursive: true })]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "SHELL", "TERM", "COLORTERM",
    "LANG", "LC_ALL", "LC_CTYPE", "CI", "NO_COLOR", "FORCE_COLOR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, {
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    OPENCODE_PURE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_TEST_HOME: join(home, "home"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_TELEMETRY: "true",
    OPENCODE_DISABLE_FREE_MODELS: "true",
    DO_NOT_TRACK: "1"
  });
  return { env, temporary, configDirectory: join(home, "config", "opencode") };
}

export async function withEngineConfig<T>(env: NodeJS.ProcessEnv, temporary: string, config: object, run: () => Promise<T>) {
  const directory = await mkdtemp(join(temporary, "config-"));
  try {
    env.OPENCODE_CONFIG = join(directory, "opencode.json");
    await writeJson(env.OPENCODE_CONFIG, config);
    return await run();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForChild(child: ChildProcess, requestStop: () => void) {
  let status: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function stop(code: number) {
    if (status !== undefined) { child.kill("SIGKILL"); return; }
    status = code;
    requestStop();
    timer = setTimeout(() => child.kill("SIGKILL"), 4_000);
    timer.unref();
  }
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    return status ?? code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  } catch {
    throw new Error("Не удалось запустить OpenCode. Проверьте бинарник и рабочую папку.");
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

export function runEngine(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, interactive: boolean) {
  const child = spawn(executable, args, { cwd, env, stdio: interactive ? "inherit" : ["ignore", "inherit", "inherit"] });
  return waitForChild(child, () => child.kill("SIGTERM"));
}

export async function serveEngine(executable: string, cwd: string, env: NodeJS.ProcessEnv,
  hostname: string, port: number, web: boolean) {
  // In OpenCode 2.4.1, serve provides both HTTP APIs and the web UI. --stdio
  // ties its lifetime to this process and removes the password from tool environments.
  const child = spawn(executable, ["serve", "--stdio", "--hostname", hostname, "--port", String(port)], {
    cwd, env, stdio: ["pipe", "pipe", "inherit"]
  });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const listening = /^\{"url":"(https?:\/\/[^"]+)"\}$/.exec(line);
    if (!listening) return;
    const url = listening[1].replace("://0.0.0.0", "://127.0.0.1").replace("://[::]", "://[::1]");
    console.log((web ? "Откройте в браузере " : "Сервер доступен по адресу ") + url);
  });
  try {
    return await waitForChild(child, () => child.stdin.end());
  } finally {
    lines.close();
    child.stdin.destroy();
  }
}
