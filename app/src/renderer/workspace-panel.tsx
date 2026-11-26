import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { BackgroundTask, ChatPart, FileChange, ProjectEntry } from "../shared/api";
import { Delta, Diff } from "./chat";
import type { FileReference } from "../shared/file-links";
import { Preview, useFileMenu, type ChatFiles } from "./chat-files";
import { Icon } from "./icons";
import { BrowserPanel } from "./browser-panel";
import { findLocalUrls, projectFileUrl } from "../shared/browser";
import { panelTabs, type PanelTab } from "../shared/panels";
import { BackgroundTasks } from "./background-tasks";

const api = window.vsemkod;

function Files({ directory, path, select, onError, files }: {
  directory: string; path?: string; select: (path: string) => void; onError: (error: unknown) => void; files: ChatFiles;
}) {
  const menu = useFileMenu(files);
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
  return <><ul className="file-tree">{entries.map(entry => {
    const folder = entry.type === "directory";
    const expanded = open.includes(entry.path);
    return <li key={entry.path}>
      <button className="sidebar-row tree-row" type="button" aria-expanded={folder ? expanded : undefined} title={entry.path}
        onClick={() => folder ? setOpen(items => expanded ? items.filter(item => item !== entry.path) : [...items, entry.path]) : select(entry.path)}
        onContextMenu={folder ? undefined : event => menu.open(event, { path: entry.path })}>
        <Icon name={folder ? "folder" : "file"} /><span>{entry.path.split(/[\\/]/).at(-1)}</span>
        {folder && <Icon name="chevron" />}
      </button>
      {folder && expanded && <Files directory={directory} path={entry.path} select={select} onError={onError} files={files} />}
    </li>;
  })}</ul>{menu.menu}</>;
}

function LocalLinks({ urls, open }: { urls: string[]; open: (url: string) => void }) {
  return urls.length > 0 && <div className="terminal-links">{urls.map(url => <div key={url}>
    <code title={url}>{url}</code><button type="button" className="local-open" onClick={() => open(url)}>Открыть в приложении</button>
  </div>)}</div>;
}

function ProjectTerminal({ directory, theme, parts, openBrowser, sessionId }: {
  directory: string; theme: string; parts: ChatPart[]; openBrowser: (url: string) => void; sessionId?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const terminal = useRef<Terminal>(null);
  const [view, setView] = useState<"shell" | "agent">("shell");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const [urls, setUrls] = useState<string[]>([]);
  const [taskCommand, setTaskCommand] = useState<string>();
  const [taskError, setTaskError] = useState("");
  const [startingTask, setStartingTask] = useState(false);
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
    let previousOutput = "";
    const data = api.onTerminal(event => {
      if (event.id !== id || !current) return;
      if (event.text) {
        instance.write(event.text);
        previousOutput = (previousOutput + event.text).slice(-8192);
        const found = findLocalUrls(previousOutput);
        if (found.length) setUrls(list => [...new Set([...list, ...found])].slice(-8));
      }
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
      {view === "shell" && api.startTask && <button className="composer-control terminal-background" type="button" aria-expanded={taskCommand !== undefined}
        onClick={() => { setTaskError(""); setTaskCommand(value => value === undefined ? "" : undefined); }}>Запустить в фоне</button>}
    </div>
    {view === "shell" && taskCommand !== undefined && <form className="terminal-task-form" onSubmit={event => {
      event.preventDefault();
      if (!taskCommand.trim() || startingTask) return;
      setStartingTask(true);
      setTaskError("");
      void api.startTask?.(directory, taskCommand, sessionId).then(() => setTaskCommand(undefined))
        .catch(error => setTaskError(error.message)).finally(() => setStartingTask(false));
    }}>
      <input className="field-control" aria-label="Команда фоновой задачи" value={taskCommand} autoFocus
        onChange={event => setTaskCommand(event.target.value)} placeholder="npm run dev" />
      <button type="submit" className="small-button" disabled={!taskCommand.trim() || startingTask}>Запустить</button>
      {taskError && <p className="connect-error" role="alert">{taskError}</p>}
    </form>}
    <div className="terminal-surface" hidden={view !== "shell"}>
      <div ref={host} className="terminal-host" aria-label="Терминал проекта" />
      <span ref={measure} className="terminal-measure" aria-hidden="true">MMMMMMMMMM</span>
    </div>
    {view === "shell" && status && <p className="subtle panel-empty">{status} {status !== "Подключаем терминал…" &&
      <button className="text-link" type="button" onClick={() => setRevision(value => value + 1)}>Открыть снова</button>}</p>}
    {view === "shell" && <LocalLinks urls={urls} open={openBrowser} />}
    {view === "agent" && <div className="terminal-history">{commands.length ? commands.map(part => part.kind === "tool" &&
      <div key={part.id}><pre className="diff">{part.target}{part.output ? "\n" + part.output : ""}</pre>
        <LocalLinks urls={findLocalUrls(part.output ?? "")} open={openBrowser} /></div>)
      : <p className="subtle panel-empty">Агент ещё не запускал команды.</p>}</div>}
  </div>;
}

export function WorkspacePanel({ directory, tab, tabs, setTab, closeTab, menuOpen, toggleMenu, menu, visible, width, resize, close, parts, changes,
  revert, busy, theme, onError, preview, openPreview, insertDraft, notify, notifyDownload, browserRequest, openBrowser, tasks, side, sessionId }: {
  tabs: PanelTab[]; closeTab: (tab: PanelTab) => void; menuOpen: boolean; toggleMenu: () => void; menu: ReactNode;
  browserRequest?: { url: string }; openBrowser: (url: string) => void; tasks: BackgroundTask[]; side: ReactNode; sessionId?: string;
  preview?: FileReference; openPreview: (ref: FileReference) => void;
  insertDraft: (text: string) => void; notify: (text: string) => void; notifyDownload: (name: string, path: string) => void;
  directory: string; tab?: PanelTab; setTab: (tab: PanelTab) => void; visible: boolean; width: number;
  resize: (width: number, final?: boolean) => void; close: () => void; parts: ChatPart[]; changes: FileChange[];
  revert: (file: string) => void; busy: boolean; theme: string; onError: (error: unknown) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [content, setContent] = useState<string>();
  const tabList = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = tabList.current;
    const active = list?.querySelector(".panel-tab[data-active]");
    if (!visible || !list || !active) return;
    const bounds = list.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.right > bounds.right) list.scrollLeft += item.right - bounds.right;
    else if (item.left < bounds.left) list.scrollLeft += item.left - bounds.left;
  }, [tab, tabs, visible]);
  // Когда вкладки не помещаются, неактивные сворачиваются до иконки, чтобы ни одна не обрезалась.
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const list = tabList.current;
    if (!list || !visible) return;
    const check = () => {
      const was = list.dataset.compact;
      delete list.dataset.compact;
      const overflow = list.scrollWidth > list.clientWidth + 1;
      if (was !== undefined) list.dataset.compact = was;
      setCompact(overflow);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(list.parentElement ?? list);
    return () => observer.disconnect();
  }, [tabs, visible]);
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [fileError, setFileError] = useState("");
  useEffect(() => { if (visible && tab === "terminal") setTerminalStarted(true); }, [visible, tab]);

  const browserKey = "vsemkod-browser:" + directory;
  const quickLinks = useMemo(() => findLocalUrls([
    ...parts.map(part => part.kind === "text" ? part.text : part.kind === "tool" ? part.output ?? "" : ""),
    ...tasks.map(task => task.output)
  ].join("\n")), [parts, tasks]);
  const projectIndex = projectFileUrl(directory.replace(/[\\/]+$/, "") + "/index.html");
  const [hasIndex, setHasIndex] = useState(false);
  useEffect(() => {
    let current = true;
    if (!api.fileStat) return;
    void api.fileStat(directory, "index.html").then(info => { if (current) setHasIndex(Boolean(info)); }, () => {});
    return () => { current = false; };
  }, [directory, changes]);
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
      <div className="panel-tabs" ref={tabList} role="tablist" aria-label="Вкладки панели" data-compact={compact || undefined}>{tabs.map(id => {
        const item = panelTabs.find(value => value.id === id)!;
        return <div className="panel-tab" data-active={tab === id || undefined} key={id}>
          <button type="button" role="tab" aria-selected={tab === id} aria-label={item.title} title={compact && tab !== id ? item.title : undefined}
            onClick={() => setTab(id)}><Icon name={item.icon} /><span className="panel-tab-title">{item.title}</span></button>
          <button type="button" className="panel-tab-close" aria-label={"Закрыть вкладку «" + item.title + "»"} onClick={() => closeTab(id)}><Icon name="close" /></button>
        </div>;
      })}</div>
      <div className="panel-add" data-panel-anchor>
        <button className="panel-icon-button" type="button" aria-label="Добавить вкладку" aria-expanded={menuOpen} data-tip="Добавить вкладку" onClick={toggleMenu}><Icon name="plus" /></button>
        {menuOpen && menu}
      </div>
      <button className="composer-control attach" aria-label="Закрыть панель" type="button" onClick={close}><Icon name="close" /></button>
    </header>
    {tab === "changes" && <section className="panel-body">
      {changes.length ? changes.map(change => <details className="diff-toggle panel-diff" key={change.file}>
        <summary className="action"><Icon name="file" /><code>{change.file}</code><Delta change={change} /><Icon name="chevron" className="diff-chevron" /></summary>
        <Diff change={change} />
        <button type="button" className="composer-control" disabled={busy} onClick={() => revert(change.file)}>Отменить изменения файла</button>
      </details>) : <p className="subtle panel-empty">В этом чате пока нет изменений.</p>}
    </section>}
    {tab === "files" && <section className="panel-body"><Files key={directory} directory={directory} select={path => api.filePreview ? openPreview({ path }) : setSelected(path)} onError={onError}
      files={{ directory, stat: path => api.fileStat?.(directory, path), preview: openPreview, onError, openBrowser }} />
      {selected && <details className="file-preview" open key={selected}><summary>{selected}</summary><pre>{fileError || content || (!fileError && content === "" ? "Пустой файл" : "Открываем файл…")}</pre></details>}
    </section>}
    {tab === "preview" && <Preview directory={directory} reference={preview} onError={onError} />}
    {tabs.includes("browser") && <section className="panel-body panel-body--browser" hidden={tab !== "browser"}>
      <BrowserPanel api={api.browser} directory={directory} active={visible && tab === "browser"} quickLinks={quickLinks}
        projectIndex={hasIndex ? projectIndex : undefined} initialUrl={localStorage.getItem(browserKey) ?? undefined}
        request={browserRequest} onUrl={url => localStorage.setItem(browserKey, url)} onSendErrors={insertDraft} onNotice={notify} onDownload={notifyDownload} />
    </section>}
    {terminalStarted && <section className="panel-body panel-body--terminal" hidden={tab !== "terminal"}>
      <ProjectTerminal key={directory} directory={directory} parts={parts} theme={theme} openBrowser={openBrowser} sessionId={sessionId} />
    </section>}
    {tab === "tasks" && <section className="panel-body"><BackgroundTasks tasks={tasks} openBrowser={openBrowser} onError={onError} /></section>}
    {tabs.includes("side") && <div className="panel-body panel-body--side" hidden={tab !== "side"}>{side}</div>}
  </aside>;
}
