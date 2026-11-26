import type { BackgroundTask, Conversation } from "../shared/api";
import type { EngineAdapter } from "./engine/adapter";

type ShellSource = { kind: "shell"; shellId: string; jobId?: string; cursor: number };
type Source = ShellSource | { kind: "pty"; ptyId: string };
type Item = { task: BackgroundTask; client: EngineAdapter; source: Source };

function outputTail(value: string) {
  return value.slice(-256_000).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n").split("\n").slice(-2000).join("\n");
}

export class BackgroundTasks {
  private readonly items = new Map<string, Item>();
  private readonly agentSessions = new Set<string>();
  private readonly backgroundCalls = new Map<string, { sessionId: string; command: string; started: number }>();
  private refreshing = false;

  constructor(private readonly publish: (items: BackgroundTask[]) => void) {}
  list() { return [...this.items.values()].map(({ task }) => task).sort((a, b) => b.started - a.started); }
  running() { return this.list().filter(task => task.ended === undefined); }
  watch(sessionId: string) { this.agentSessions.add(sessionId); }
  unwatch(sessionId: string) { this.agentSessions.delete(sessionId); }
  called(id: string, sessionId: string, command: string) {
    this.backgroundCalls.set(id, { sessionId, command, started: Date.now() });
  }

  private shell(client: EngineAdapter, shellId: string, directory: string, command: string, started: number, sessionId?: string, jobId?: string) {
    const id = "shell:" + shellId;
    const known = this.items.get(id);
    if (known) {
      if (jobId && known.source.kind === "shell") known.source.jobId = jobId;
      return;
    }
    this.items.set(id, { client, source: { kind: "shell", shellId, cursor: 0, jobId },
      task: { id, directory, command, started, sessionId, output: "" } });
  }

  async start(client: EngineAdapter, directory: string, command: string, sessionId?: string) {
    const shell = await client.startBackground(directory, command);
    this.shell(client, shell.id, directory, command, shell.time.started, sessionId);
    this.publish(this.list());
  }

  async stop(id: string) {
    const item = this.items.get(id);
    if (!item || item.task.ended !== undefined) return;
    const { source, task, client } = item;
    if (source.kind === "pty") await client.removePersistentTask(source.ptyId);
    else await client.stopBackground(task.directory, source.shellId, source.jobId);
    task.ended = Date.now();
    this.publish(this.list());
  }

  async refresh(client: EngineAdapter, conversations: Map<string, Conversation>) {
    if (this.refreshing) return;
    this.refreshing = true;
    const before = JSON.stringify(this.list());
    try {
      if (this.agentSessions.size) {
        const jobs = await client.backgroundJobs().catch(() => []);
        for (const job of jobs) {
          if (job.kind !== "shell") continue;
          const chat = conversations.get(job.sessionID);
          if (chat) this.shell(client, job.shellID, chat.directory, job.command, job.time.started, job.sessionID, job.id);
        }
      }
      await Promise.allSettled([...this.backgroundCalls].map(async ([toolId, call]) => {
        const chat = conversations.get(call.sessionId);
        if (!chat || Date.now() - call.started > 20_000) { this.backgroundCalls.delete(toolId); return; }
        const shells = await client.shellTasks(chat.directory);
        const shell = shells.find(item => item.command === call.command && item.time.started >= call.started - 1000 &&
          (!item.metadata.sessionID || item.metadata.sessionID === call.sessionId) && !this.items.has("shell:" + item.id));
        if (!shell) return;
        this.shell(client, shell.id, chat.directory, shell.command, shell.time.started, call.sessionId);
        this.backgroundCalls.delete(toolId);
      }));
      const knownPtys = [...this.items.values()].flatMap(({ task, source }) =>
        source.kind === "pty" && task.ended === undefined && task.sessionId ? [task.sessionId] : []);
      await Promise.allSettled([...new Set([...this.agentSessions, ...knownPtys])].map(async sessionId => {
        const ptys = await client.persistentTasks(sessionId);
        for (const pty of ptys) {
          const id = "pty:" + pty.id;
          const item = this.items.get(id);
          if (item?.task.ended !== undefined) continue;
          const task = item?.task ?? { id, sessionId, directory: pty.cwd, command: [pty.command, ...pty.args].join(" "),
            started: Date.now(), output: "" };
          task.output = outputTail(await client.persistentOutput(pty.id).catch(() => task.output));
          if (task.ended !== undefined) continue;
          if (pty.status === "exited") { task.ended = Date.now(); task.exitCode = pty.exitCode; }
          this.items.set(id, { task, client, source: { kind: "pty", ptyId: pty.id } });
        }
        for (const { task, source } of this.items.values()) {
          if (source.kind === "pty" && task.sessionId === sessionId && task.ended === undefined && !ptys.some(pty => pty.id === source.ptyId)) {
            task.ended = Date.now();
          }
        }
      }));

      await Promise.allSettled([...this.items.values()].map(async ({ client: owner, task, source }) => {
        if (task.ended !== undefined) return;
        if (client !== owner) { task.ended = Date.now(); return; }
        if (source.kind !== "shell") return;
        const info = await client.backgroundInfo(task.directory, source.shellId);
        const data = await client.backgroundOutput(task.directory, source.shellId, source.cursor);
        if (task.ended !== undefined) return;
        source.cursor = data.cursor;
        if (data.output) task.output = outputTail(task.output + data.output);
        task.directory = info.cwd;
        if (info.status !== "running" && data.cursor >= data.size) {
          task.ended = info.time.completed ?? Date.now();
          task.exitCode = info.exit ?? (info.status === "timeout" ? 124 : undefined);
        }
      }));
      const completed = this.list().filter(task => task.ended !== undefined);
      for (const task of completed.slice(40)) this.items.delete(task.id);
    } finally {
      this.refreshing = false;
      if (before !== JSON.stringify(this.list())) this.publish(this.list());
    }
  }
}
