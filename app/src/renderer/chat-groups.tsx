import { useEffect, useState } from "react";
import type { ChatAction, Conversation } from "../shared/api";
import { isRunning } from "./chat-state";
import { Icon } from "./icons";
import { chatStatusLabel, type ChatStatus } from "./turns";
import { folderName } from "../shared/workspace";

export function ChatGroups({ sessions, projects, selectedProject, query, active, running, expand, addProject, selectProject, start,
  openProject, removeProject, open, perform, tasks }: {
  sessions: Conversation[]; projects: string[]; selectedProject: string; query: string; active?: string;
  tasks?: string[];
  running: Record<string, ChatStatus>; expand?: { directory: string };
  addProject: () => void; selectProject: (directory: string) => void; start: (directory: string) => void;
  openProject?: (directory: string) => void; removeProject?: (directory: string) => void;
  open: (chat: Conversation) => void; perform: (chat: Conversation, action: ChatAction) => Promise<void>;
}) {
  const [menu, setMenu] = useState("");
  const openFolderLabel = navigator.platform.startsWith("Mac") ? "Открыть в Finder" :
    navigator.platform.startsWith("Linux") ? "Открыть в Files" : "Открыть в проводнике";
  const [renaming, setRenaming] = useState("");
  const [title, setTitle] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => { if (expand) setCollapsed(value => value.filter(path => path !== expand.directory)); }, [expand]);
  const filtered = sessions.filter(item => projects.includes(item.worktree?.origin ?? item.directory) && item.title.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  const groups = new Map<string, Conversation[]>(query.trim() ? [] : projects.map(path => [path, []]));
  const ordered = (values: Conversation[]) => [...values].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  for (const chat of ordered(filtered.filter(item => !item.archived))) {
    const directory = chat.worktree?.origin ?? chat.directory;
    groups.set(directory, [...groups.get(directory) ?? [], chat]);
  }
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".chat-menu,.chat-more,.project-more")) setMenu("");
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(""); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);

  function row(chat: Conversation) {
    const state = running[chat.id];
    const blocked = isRunning(state);
    const action = (value: ChatAction) => {
      setMenu("");
      void perform(chat, value);
    };
    return <li key={chat.id} className="chat-sidebar-item" onContextMenu={event => {
      event.preventDefault(); setMenu(chat.id);
    }}>
      {renaming === chat.id ? <form className="rename-chat" onSubmit={event => {
        event.preventDefault();
        if (title.trim()) { setRenaming(""); action({ type: "rename", title: title.trim() }); }
      }}>
        <input className="field-control" value={title} autoFocus maxLength={120} aria-label="Название чата"
          onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setRenaming(""); }} />
        <button className="composer-control attach" type="submit" aria-label="Сохранить название"><Icon name="check" /></button>
      </form> : <>
        <button className="sidebar-row conversation" type="button" aria-current={active === chat.id ? "page" : undefined}
          title={chat.worktree ? chat.worktree.branch : chat.title} onClick={() => open(chat)}>
          {chat.pinned && <span className="pinned-mark" aria-hidden="true" title="Закреплён" />}
          {chat.worktree && <Icon name="branch" className="conversation-branch" />}
          <span>{chat.title}</span>
          {state && <span className="chat-status-dot" data-status={state} role="img" aria-label={chatStatusLabel[state]} title={chatStatusLabel[state]} />}
        </button>
        <button type="button" className="composer-control chat-more" aria-label={"Действия чата " + chat.title} aria-expanded={menu === chat.id}
          onClick={() => setMenu(value => value === chat.id ? "" : chat.id)}><Icon name="more" /></button>
      </>}
      {menu === chat.id && <div className="chat-menu model-panel">
        <button type="button" className="model-option" onClick={() => { setMenu(""); setRenaming(chat.id); setTitle(chat.title); }}>Переименовать</button>
        <button type="button" className="model-option" onClick={() => action({ type: "pin", value: !chat.pinned })}>{chat.pinned ? "Открепить" : "Закрепить"}</button>
        <button type="button" className="model-option" onClick={() => action({ type: "fork" })}>Форк</button>
        {!chat.archived && tasks?.includes(chat.id) && <p className="archive-task-warning">В чате работают фоновые задачи.</p>}
        <button type="button" className="model-option" disabled={blocked} title={blocked ? "Сначала остановите агента" : undefined} onClick={() => action({ type: "archive", value: !chat.archived })}>
          {chat.archived ? "Вернуть из архива" : "Архивировать"}
        </button>
        <button type="button" className="model-option danger-action" disabled={blocked} title={blocked ? "Сначала остановите агента" : undefined} onClick={() => {
          if (window.confirm("Удалить чат «" + chat.title + "»?")) action({ type: "delete" });
        }}>Удалить</button>
      </div>}
    </li>;
  }
  const archived = ordered(filtered.filter(chat => chat.archived));
  return <div className="project-sidebar">
    <header className="projects-heading"><h2>Проекты</h2>
      <button type="button" className="composer-control attach" aria-label="Добавить проект" title="Добавить проект"
        onClick={addProject}><Icon name="plus" /></button>
    </header>
    <nav className="recent chat-groups" aria-label="Чаты по проектам">
    {[...groups].map(([directory, chats]) => {
      const expanded = !collapsed.includes(directory);
      const name = folderName(directory);
      const projectMenu = "project:" + directory;
      const blocked = sessions.some(chat => (chat.worktree?.origin ?? chat.directory) === directory && isRunning(running[chat.id]));
      const create = () => {
        setMenu("");
        setCollapsed(value => value.filter(path => path !== directory));
        start(directory);
      };
      return <section className="chat-group" key={directory}>
        <header data-selected={selectedProject === directory || undefined}>
          <button type="button" className="sidebar-row group-name" aria-current={selectedProject === directory ? "true" : undefined}
            aria-expanded={expanded} title={directory} onClick={() => {
              selectProject(directory);
              setCollapsed(value => expanded ? [...value, directory] : value.filter(path => path !== directory));
            }}><Icon name="chevron" className="project-chevron" /><Icon name="folder" /><span>{name}</span></button>
          <div className="project-actions">
            <button type="button" className="composer-control attach group-new" aria-label={"Новый чат в " + name}
              title={"Новый чат в " + name} onClick={create}><Icon name="plus" /></button>
            <button type="button" className="composer-control attach project-more" aria-label={"Действия проекта " + name}
              aria-expanded={menu === projectMenu} onClick={() => setMenu(value => value === projectMenu ? "" : projectMenu)}><Icon name="more" /></button>
          </div>
          {menu === projectMenu && <div className="chat-menu model-panel">
            <button type="button" className="model-option" onClick={create}>Новый чат</button>
            {openProject && <button type="button" className="model-option" onClick={() => { setMenu(""); openProject(directory); }}>{openFolderLabel}</button>}
            {removeProject && <button type="button" className="model-option" disabled={blocked} title={blocked ? "Сначала остановите агента" : undefined}
              onClick={() => { setMenu(""); removeProject(directory); }}>Убрать из списка</button>}
          </div>}
        </header>
        {expanded && (chats.length ? <ul>{chats.map(row)}</ul> : <p className="subtle project-empty">Нет чатов</p>)}
      </section>;
    })}
    {query && !filtered.length && <p className="subtle sidebar-empty">Чаты не найдены.</p>}
    <details className="chat-archive" open={query && archived.length ? true : undefined}>
      <summary className="sidebar-row"><Icon name="chevron" />Архив{archived.length > 0 && <span> · {archived.length}</span>}</summary>
      {archived.length ? <ul>{archived.map(row)}</ul> : <p className="subtle sidebar-empty">Архив пуст.</p>}
    </details>
    </nav>
  </div>;
}
