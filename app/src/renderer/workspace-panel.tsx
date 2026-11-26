import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ChatPart, FileChange, ProjectEntry } from "../shared/api";
import { Delta, Diff } from "./chat";
import type { FileReference } from "../shared/file-links";
import { Preview } from "./chat-files";
import { Icon } from "./icons";

const api = window.vsemkod;
export const panelTabs = [{ id: "changes", title: "Изменения" }, { id: "files", title: "Файлы" }, { id: "terminal", title: "Терминал" }, { id: "preview", title: "Просмотр" }] as const;
export type PanelTab = typeof panelTabs[number]["id"];

function Files({ directory, path, select, onError }: {
  directory: string; path?: string; select: (path: string) => void; onError: (error: unknown) => void;
}) {
  const [entries, setEntries] = useState<ProjectEntry[]>();
  const [open, setOpen] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    void api.listFiles(directory, path).then(items => {
      if (current) setEntries(items.sort((a, b) => a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1));
    }).catch(error => { if (current) { setEntries([]); onError(error); } });
    return () => { current = false; };
  }, [directory, path, onError]);
  if (!entries) return <p className="subtle panel-empty">Загружаем файлы…</p>;
  if (!entries.length && !path) return <p className="subtle panel-empty">В папке пока нет файлов.</p>;
  return <ul className="file-tree">{entries.map(entry => {
    const folder = entry.type === "directory";
    const expanded = open.includes(entry.path);
    return <li key={entry.path}>
      <button className="sidebar-row tree-row" type="button" aria-expanded={folder ? expanded : undefined} title={entry.path}
        onClick={() => folder ? setOpen(items => expanded ? items.filter(item => item !== entry.path) : [...items, entry.path]) : select(entry.path)}>
        <Icon name={folder ? "folder" : "file"} /><span>{entry.path.split(/[\\/]/).at(-1)}</span>
        {folder && <Icon name="chevron" />}
      </button>
      {folder && expanded && <Files directory={directory} path={entry.path} select={select} onError={onError} />}
    </li>;
  })}</ul>;
}

function ProjectTerminal({ directory, theme, parts }: { directory: string; theme: string; parts: ChatPart[] }) {
  const host = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const terminal = useRef<Terminal>(null);
  const [view, setView] = useState<"shell" | "agent">("shell");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const colors = () => {
    const style = getComputedStyle(document.documentElement);
    return { background: style.getPropertyValue("--code-surface").trim(), foreground: style.getPropertyValue("--text").trim(),
      cursor: style.getPropertyValue("--mint").trim(), selectionBackground: style.getPropertyValue("--mint-hover").trim() };
  };
  useEffect(() => {
    if (!host.current || !measure.current) return;
    const element = host.current;
    const ruler = measure.current;
    const id = crypto.randomUUID();
    const instance = new Terminal({ fontSize: 12, fontFamily: "Consolas, monospace", scrollback: 1000, cursorBlink: true, theme: colors() });
    terminal.current = instance;
    instance.open(element);
    let current = true;
    let opened = false;
    const data = api.onTerminal(event => {
      if (event.id !== id || !current) return;
      if (event.text) instance.write(event.text);
      if (event.closed) { opened = false; setStatus("Терминал завершён."); }
    });
    const input = instance.onData(value => { if (opened) void api.terminalInput(id, value).catch(() => {}); });
    const resize = () => {
      const size = ruler.getBoundingClientRect();
      if (!element.clientWidth || !size.width) return;
      const cols = Math.max(2, Math.min(400, Math.floor((element.clientWidth - 14) / (size.width / 10))));
      const rows = Math.max(2, Math.min(200, Math.floor(element.clientHeight / size.height)));
      instance.resize(cols, rows);
      if (opened) void api.terminalResize(id, cols, rows).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    setStatus("Подключаем терминал…");
    const opening = api.openTerminal(directory, id).then(() => {
      if (!current) return;
      opened = true;
      setStatus("");
      resize();
    }).catch(() => { if (current) setStatus("Не удалось подключить терминал."); });
    return () => {
      current = false; observer.disconnect(); input.dispose(); data(); instance.dispose(); terminal.current = null;
      void opening.then(() => api.closeTerminal(id)).catch(() => {});
    };
  }, [directory, revision]);
  useEffect(() => { if (terminal.current) terminal.current.options.theme = colors(); }, [theme]);
  const commands = parts.filter(part => part.kind === "tool" && ["shell", "bash"].includes(part.tool));
  return <div className="terminal-panel">
    <div className="terminal-tabs" role="group" aria-label="Вывод терминала">
      <button className="composer-control" type="button" aria-pressed={view === "shell"} onClick={() => setView("shell")}>Оболочка</button>
      <button className="composer-control" type="button" aria-pressed={view === "agent"} onClick={() => setView("agent")}>Команды агента</button>
    </div>
    <div className="terminal-surface" hidden={view !== "shell"}>
      <div ref={host} className="terminal-host" aria-label="Терминал проекта" />
      <span ref={measure} className="terminal-measure" aria-hidden="true">MMMMMMMMMM</span>
    </div>
    {view === "shell" && status && <p className="subtle panel-empty">{status} {status !== "Подключаем терминал…" &&
      <button className="text-link" type="button" onClick={() => setRevision(value => value + 1)}>Открыть снова</button>}</p>}
    {view === "agent" && <div className="terminal-history">{commands.length ? commands.map(part => part.kind === "tool" &&
      <pre className="diff" key={part.id}>{part.target}{part.output ? "\n" + part.output : ""}</pre>)
      : <p className="subtle panel-empty">Агент ещё не запускал команды.</p>}</div>}
  </div>;
}

export function WorkspacePanel({ directory, tab, setTab, visible, width, resize, close, parts, changes, revert, busy, theme, onError, preview, openPreview }: {
  preview?: FileReference; openPreview: (ref: FileReference) => void;
  directory: string; tab: PanelTab; setTab: (tab: PanelTab) => void; visible: boolean; width: number;
  resize: (width: number, final?: boolean) => void; close: () => void; parts: ChatPart[]; changes: FileChange[];
  revert: (file: string) => void; busy: boolean; theme: string; onError: (error: unknown) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [content, setContent] = useState<string>();
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [fileError, setFileError] = useState("");
  useEffect(() => { if (visible && tab === "terminal") setTerminalStarted(true); }, [visible, tab]);
  useEffect(() => {
    setContent(undefined);
    setFileError("");
    if (!selected) return;
    let current = true;
    void api.readFile(directory, selected).then(value => { if (current) setContent(value); })
      .catch(error => { if (current) { setFileError("Не удалось открыть файл для текстового просмотра."); onError(error); } });
    return () => { current = false; };
  }, [directory, selected, onError]);
  return <aside className="workspace-panel" aria-label="Правая панель" hidden={!visible} style={{ width }}>
    <div className="panel-resize" role="separator" aria-label="Ширина правой панели" aria-orientation="vertical" tabIndex={0}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? 20 : -20), true);
      }} onPointerDown={event => {
        event.preventDefault();
        const handle = event.currentTarget;
        const start = event.clientX;
        const base = handle.parentElement?.getBoundingClientRect().width ?? width;
        let final = base;
        handle.setPointerCapture(event.pointerId);
        handle.onpointermove = move => { final = base + start - move.clientX; resize(final); };
        const end = () => { handle.onpointermove = null; handle.onlostpointercapture = null; resize(final, true); };
        handle.onlostpointercapture = end;
      }} />
    <header className="panel-heading">
      <div className="panel-tabs" role="group" aria-label="Вкладки панели">{panelTabs.filter(item => item.id !== "preview" || api.filePreview).map(item =>
        <button className="composer-control" type="button" key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.title}</button>
      )}</div>
      <button className="composer-control attach" aria-label="Закрыть панель" type="button" onClick={close}><Icon name="close" /></button>
    </header>
    {tab === "changes" && <section className="panel-body">
      {changes.length ? changes.map(change => <details className="diff-toggle panel-diff" key={change.file}>
        <summary className="action"><Icon name="file" /><code>{change.file}</code><Delta change={change} /><Icon name="chevron" className="diff-chevron" /></summary>
        <Diff change={change} />
        <button type="button" className="composer-control" disabled={busy} onClick={() => revert(change.file)}>Отменить изменения файла</button>
      </details>) : <p className="subtle panel-empty">В этом чате пока нет изменений.</p>}
    </section>}
    {tab === "files" && <section className="panel-body"><Files key={directory} directory={directory} select={path => api.filePreview ? openPreview({ path }) : setSelected(path)} onError={onError} />
      {selected && <details className="file-preview" open key={selected}><summary>{selected}</summary><pre>{fileError || content || (!fileError && content === "" ? "Пустой файл" : "Открываем файл…")}</pre></details>}
    </section>}
    {tab === "preview" && <Preview directory={directory} reference={preview} onError={onError} />}
    {terminalStarted && <section className="panel-body panel-body--terminal" hidden={tab !== "terminal"}>
      <ProjectTerminal key={directory} directory={directory} parts={parts} theme={theme} />
    </section>}
  </aside>;
}
