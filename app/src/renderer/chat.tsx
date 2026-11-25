import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatPart, FileChange, Permission, PermissionDecision, Question, QuestionAnswer } from "../shared/api";
import { Icon } from "./icons";

function external(event: React.MouseEvent<HTMLAnchorElement>, href?: string) {
  event.preventDefault();
  if (href && /^https?:\/\//i.test(href)) void window.vsemkod.openExternal(href).catch(() => {});
}

export function Diff({ change }: { change: FileChange }) {
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

export function Delta({ change }: { change: FileChange }) {
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
    {(part.diffs ?? [part.diff]).map(change => <Diff change={change} key={change.file} />)}
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

function QuestionCard({ question, answer }: { question: Question; answer: (answer?: QuestionAnswer) => Promise<void> }) {
  const [values, setValues] = useState<QuestionAnswer>(() => Object.fromEntries(question.fields.flatMap(field =>
    "default" in field && field.default !== undefined ? [[field.key, field.default]] : [])));
  const [custom, setCustom] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const set = (key: string, value: QuestionAnswer[string]) => setValues(current => ({ ...current, [key]: value }));
  async function reply(value?: QuestionAnswer) {
    setPending(true);
    setError("");
    try { await answer(value); }
    catch { setError("Не удалось отправить ответ."); }
    finally { setPending(false); }
  }
  return <form className="approval question" onSubmit={event => { event.preventDefault(); void reply(values); }}>
    <h2>{question.title}</h2>
    {question.fields.filter(field => !("hidden" in field && field.hidden)).map(field => {
      const title = field.title ?? field.key;
      const current = values[field.key];
      if (field.type === "external") return <button type="button" className="text-link" key={field.key}
        onClick={() => void window.vsemkod.openExternal(field.url).catch(() => setError("Не удалось открыть ссылку."))}>{title}</button>;
      const free = custom.includes(field.key);
      const options = "options" in field ? field.options : undefined;
      return <fieldset className="question-field" key={field.key}><legend>{title}</legend>
        {field.description && <p className="subtle">{field.description}</p>}
        {options?.map(option => {
          const checked = field.type === "multiselect" ? Array.isArray(current) && current.includes(option.value) : current === option.value && !free;
          return <label className="question-option" key={option.value}><input type={field.type === "multiselect" ? "checkbox" : "radio"}
            name={field.key} checked={checked} required={field.type !== "multiselect" && field.required && !free}
            onChange={event => {
              if (field.type === "multiselect") {
                const selected = Array.isArray(current) ? current : [];
                set(field.key, event.target.checked ? [...selected, option.value] : selected.filter(value => value !== option.value));
              } else { setCustom(list => list.filter(key => key !== field.key)); set(field.key, option.value); }
            }} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>;
        })}
        {options?.length && "custom" in field && field.custom !== false ? <button className="composer-control" type="button" onClick={() => {
          setCustom(list => list.includes(field.key) ? list.filter(key => key !== field.key) : [...list, field.key]);
        }}>Свой ответ</button> : null}
        {(free || !options?.length) && (field.type === "boolean"
          ? <label className="question-option"><input type="checkbox" checked={current === true} onChange={event => set(field.key, event.target.checked)} />Да</label>
          : <input className="field-control" type={field.type === "number" || field.type === "integer" ? "number" : "text"}
            step={field.type === "integer" ? 1 : "any"} aria-label="Свой ответ" placeholder="Свой ответ" required={field.required}
            value={field.type === "multiselect" ? (Array.isArray(current) ? current.filter(v => !options?.some(o => o.value === v)).join(", ") : "") : (typeof current === "string" || typeof current === "number" ? current : "")}
            onChange={event => {
              const input = event.target;
              if (field.type === "multiselect") set(field.key, [...(Array.isArray(current) ? current.filter(v => options?.some(o => o.value === v)) : []), input.value].filter(Boolean));
              else if (field.type === "integer" || field.type === "number") set(field.key, input.value === "" ? "" : input.valueAsNumber);
              else set(field.key, input.value);
            }} />)}
      </fieldset>;
    })}
    <div className="approval-actions">
      <button type="submit" className="small-button" disabled={pending}>Ответить</button>
      <button type="button" className="composer-control" disabled={pending} onClick={() => void reply()}>Пропустить</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </form>;
}

export function Chat({ title, parts, permissions, questions, changeCount, busy, answer, answerQuestion, children, panel, openPanel,
  copy, edit, revert, retry, reverted, executePlan }: {
  title: string; parts: ChatPart[]; permissions: Permission[]; questions: Question[]; changeCount: number;
  busy: boolean; answer: (id: string, decision: PermissionDecision) => Promise<void>;
  answerQuestion: (id: string, answer?: QuestionAnswer) => Promise<void>; children: ReactNode;
  panel: boolean; openPanel: () => void; copy: (text: string) => void;
  edit: (part: UserPart) => void; revert: (id?: string) => void; retry: (part: UserPart) => void;
  reverted: boolean; executePlan?: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    if (atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [parts, permissions, questions]);

  const messages: { user?: UserPart; agent: ChatPart[] }[] = [];
  for (const part of parts) {
    if (part.kind === "user") messages.push({ user: part, agent: [] });
    else {
      if (!messages.length) messages.push({ agent: [] });
      messages.at(-1)?.agent.push(part);
    }
  }
  const lastTodo = parts.findLast(part => part.kind === "tool" && part.todos !== undefined);
  const todos = lastTodo?.kind === "tool" ? lastTodo.todos ?? [] : [];
  return <main className="workspace">
    <header className="chat-header">
      <h1>{title}</h1>
      <button className="changes" type="button" aria-expanded={panel} aria-label="Правая панель" onClick={openPanel}>
        <Icon name="panel" /><span>{changeCount ? "Изменения " + changeCount : "Панель"}</span>
      </button>
    </header>
    <div ref={scroll} className="chat-scroll" onScroll={event => {
      const element = event.currentTarget;
      atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    }}>
      <section className="chat-thread" aria-label="Диалог с агентом">
        {messages.map(({ user, agent }, index) => {
          const last = index === messages.length - 1;
          const response = agent.flatMap(part => part.kind === "text" ? [part.text] : []).join("\n\n");
          return <div className="turn" key={user?.id ?? index}>
            {user && <div className="user-turn">
              <div className="user-message" aria-label="Сообщение пользователя">{user.text}
                {user.files?.length ? <span className="message-files">{user.files.join(" · ")}</span> : null}
              </div>
              {!user.id.startsWith("local:") && <div className="message-actions">
                <button type="button" className="composer-control" onClick={() => copy(user.text)}>Копировать</button>
                {last && <button type="button" className="composer-control" disabled={busy} onClick={() => edit(user)}>Изменить и отправить заново</button>}
                <button type="button" className="composer-control" disabled={busy} onClick={() => revert(user.id)}>Откатить сюда</button>
              </div>}
            </div>}
            {agent.length > 0 && <article className="agent-message" aria-label="Ответ агента">
              {agent.map(part => {
                if (part.kind === "tool") return part.tool === "todowrite" ? null : <Action key={part.id} part={part} />;
                if (part.kind === "reasoning") return <details key={part.id} className="reasoning">
                  <summary>{part.seconds ? "Думал " + Math.round(part.seconds) + " с" : "Рассуждения"}</summary>
                  <p>{part.text}</p>
                </details>;
                if (part.kind === "note") return <p className="subtle context-note" key={part.id}>{part.text}</p>;
                return <div key={part.id} className="agent-text"><Markdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]} components={{
                  a: ({ href, children }) => <a className="text-link" href={href} onClick={event => external(event, href)}>{children}</a>
                }}>{part.text}</Markdown></div>;
              })}
              {response && (!busy || !last) && <div className="message-actions">
                <button type="button" className="composer-control" onClick={() => copy(response)}>Копировать</button>
                {user && <button type="button" className="composer-control" disabled={busy} onClick={() => retry(user)}>Повторить</button>}
              </div>}
            </article>}
          </div>;
        })}
        {!busy && executePlan && messages.at(-1)?.agent.some(part => part.kind === "text") && <section className="approval plan-card">
          <span>План готов</span><button type="button" className="small-button" onClick={executePlan}>Выполнить план</button>
        </section>}
        {reverted && <div className="approval plan-card"><span>Чат откачен</span><button className="composer-control" type="button"
          disabled={busy} onClick={() => revert()}>Вернуть</button></div>}
        {permissions.map(permission => <Approval permission={permission} answer={answer} key={permission.id} />)}
        {questions.map(question => <QuestionCard question={question} answer={value => answerQuestion(question.id, value)} key={question.id} />)}
        {busy && permissions.length === 0 && questions.length === 0 && <p className="working" role="status"><span className="status-dot" /> Агент работает</p>}
      </section>
    </div>
    <div className="compose-area">
      {todos.length > 0 && <details className="todo-card" open>
        <summary>Задачи агента <span className="subtle">{todos.filter(item => item.status === "completed").length}/{todos.length}</span></summary>
        <ul>{todos.map((item, index) => <li className={"todo-" + item.status} key={index}>
          {item.status === "completed" ? <Icon name="check" /> : <span className="todo-mark" />}{item.content}
        </li>)}</ul>
      </details>}
      {children}
    </div>
  </main>;
}

type UserPart = Extract<ChatPart, { kind: "user" | "text" }>;
