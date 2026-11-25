import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatPart, FileChange, Permission, PermissionDecision } from "../shared/api";
import { Icon } from "./icons";

function external(event: React.MouseEvent<HTMLAnchorElement>, href?: string) {
  event.preventDefault();
  if (href && /^https?:\/\//i.test(href)) void window.vsemkod.openExternal(href).catch(() => {});
}

function Diff({ change }: { change: FileChange }) {
  return <pre className="diff" aria-label={"Изменения в " + change.file}>
    {change.patch.split("\n").filter(line => line.trimEnd() !== "\\ No newline at end of file" &&
      !/^(Index:|===|--- |\+\+\+ )/.test(line)).slice(0, 1500).map((line, index) => {
      const sign = line[0];
      const tone = sign === "+" ? "add" : sign === "-" ? "remove" : "";
      return <span key={index} className={"diff-line" + (tone ? " diff-line--" + tone : "")}>
        <span className="diff-sign">{tone === "remove" ? "−" : tone === "add" ? "+" : " "}</span>{tone || sign === " " ? line.slice(1) : line}
      </span>;
    })}
  </pre>;
}

function Delta({ change }: { change: FileChange }) {
  return <span className="delta">
    {change.additions > 0 && <span className="add">+{change.additions}</span>}
    {change.deletions > 0 && <span className="remove">−{change.deletions}</span>}
  </span>;
}

function Action({ part }: { part: Extract<ChatPart, { kind: "tool" }> }) {
  const write = ["edit", "patch", "write", "apply_patch", "multiedit"].includes(part.tool);
  const command = ["shell", "bash"].includes(part.tool);
  const reading = ["read", "glob", "grep", "list"].includes(part.tool);
  const label = part.status === "error" ? "Действие не выполнено"
    : part.status === "running" ? (write ? "Готовит изменения" : command ? "Готовит команду" : reading ? "Читает" : "Выполняет")
    : write ? (part.diff?.status === "added" || part.output?.startsWith("Created file") ? "Создал" : part.diff?.status === "deleted" ? "Удалил" : "Изменил")
    : command ? "Запустил" : part.tool === "read" ? "Прочитал" : reading ? "Проверил" : "Выполнил";
  const content = <>
    <Icon name={write ? "file" : command ? "terminal" : "read"} />
    <span className="action-label">{label} <code>{part.target || (!write && !command && !reading ? part.tool : "")}</code>
      {part.diff && <Delta change={part.diff} />}
    </span>
  </>;
  if (part.diff) return <details className="diff-toggle">
    <summary className="action">{content}<Icon name="chevron" className="diff-chevron" /></summary>
    <Diff change={part.diff} />
  </details>;
  if (part.output && (command || part.status === "error")) return <details className="diff-toggle">
    <summary className="action">{content}<Icon name="chevron" className="diff-chevron" /></summary>
    <pre className="diff tool-output">{part.output}</pre>
  </details>;
  return <div className="action">{content}</div>;
}

function Approval({ permission, answer }: { permission: Permission; answer: (id: string, decision: PermissionDecision) => Promise<void> }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState(false);
  const title = permission.action === "edit" ? "Разрешить изменение файлов?"
    : permission.action === "shell" ? "Разрешить запуск команды?" : "Разрешить действие?";
  const decisions: [PermissionDecision, string][] = [
    ["once", "Разрешить"], ["always", "Разрешить всегда в этом чате"], ["reject", "Запретить"]
  ];
  return <section className="approval" aria-label="Запрос разрешения">
    <h2><Icon name="lock" />{title}</h2>
    {permission.resources.length > 0 && <pre>{permission.resources.join("\n")}</pre>}
    <div className="approval-actions">{decisions.map(([decision, label]) =>
      <button className={decision === "once" ? "small-button" : "composer-control"} key={decision} type="button" disabled={waiting} onClick={() => {
        setWaiting(true);
        void answer(permission.id, decision).catch(() => { setWaiting(false); setError(true); });
      }}>{label}</button>)}</div>
    {error && <p role="alert">Не удалось сохранить решение. Попробуйте ещё раз.</p>}
  </section>;
}

export function Chat({ title, parts, permissions, changes, busy, answer, children }: {
  title: string; parts: ChatPart[]; permissions: Permission[]; changes: FileChange[];
  busy: boolean; answer: (id: string, decision: PermissionDecision) => Promise<void>; children: ReactNode;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    if (atBottom.current && scroll.current && !showChanges) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [parts, permissions, showChanges]);

  const messages: { user?: Extract<ChatPart, { kind: "user" | "text" }>; agent: ChatPart[] }[] = [];
  for (const part of parts) {
    if (part.kind === "user") messages.push({ user: part, agent: [] });
    else {
      if (!messages.length) messages.push({ agent: [] });
      messages.at(-1)?.agent.push(part);
    }
  }
  return <main className="workspace">
    <header className="chat-header">
      <h1>{title}</h1>
      {changes.length > 0 && <button className="changes" type="button" aria-expanded={showChanges} onClick={() => setShowChanges(value => !value)}>
        <Icon name="changes" /><span>Изменения {changes.length}</span>
      </button>}
    </header>
    <div ref={scroll} className="chat-scroll" onScroll={event => {
      const element = event.currentTarget;
      atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    }}>
      {showChanges ? <section className="chat-thread changes-list" aria-label="Изменения в файлах">
        {changes.map(change => <details key={change.file} open className="diff-toggle">
          <summary className="action"><Icon name="file" /><code>{change.file}</code><Delta change={change} /><Icon name="chevron" className="diff-chevron" /></summary>
          <Diff change={change} />
        </details>)}
      </section> : <section className="chat-thread" aria-label="Диалог с агентом">
        {messages.map(({ user, agent }, index) => <div className="turn" key={user?.id ?? index}>
          {user && <div className="user-message" aria-label="Сообщение пользователя">
            {user.text}{user.files?.length ? <span className="message-files">{user.files.join(" · ")}</span> : null}
          </div>}
          {agent.length > 0 && <article className="agent-message" aria-label="Ответ агента">
            {agent.map(part => part.kind === "tool" ? <Action key={part.id} part={part} /> : <div key={part.id} className="agent-text">
              <Markdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]} components={{
                a: ({ href, children }) => <a className="text-link" href={href} onClick={event => external(event, href)}>{children}</a>
              }}>{part.text}</Markdown>
            </div>)}
          </article>}
        </div>)}
        {permissions.map(permission => <Approval permission={permission} answer={answer} key={permission.id} />)}
        {busy && permissions.length === 0 && <p className="working" role="status"><span className="status-dot" /> Агент работает</p>}
      </section>}
    </div>
    <div className="compose-area">{children}</div>
  </main>;
}
