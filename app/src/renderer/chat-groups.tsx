import { useEffect, useState } from "react";
import type { ChatAction, Conversation } from "../shared/api";
import { Icon } from "./icons";

export function ChatGroups({ sessions, query, active, disabled, start, open, perform }: {
  sessions: Conversation[]; query: string; active?: string; disabled: boolean; start: (directory: string) => void;
  open: (chat: Conversation) => void; perform: (chat: Conversation, action: ChatAction) => Promise<void>;
}) {
  const [menu, setMenu] = useState("");
  const [renaming, setRenaming] = useState("");
  const [title, setTitle] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const filtered = sessions.filter(item => item.title.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  const groups = new Map<string, Conversation[]>();
  const ordered = (values: Conversation[]) => [...values].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  for (const chat of ordered(filtered.filter(item => !item.archived))) {
    groups.set(chat.directory, [...groups.get(chat.directory) ?? [], chat]);
  }
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".chat-menu,.chat-more")) setMenu("");
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(""); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);

  function row(chat: Conversation) {
    const action = (value: ChatAction) => {
      setMenu("");
      void perform(chat, value);
    };
    return <li key={chat.id} className="chat-sidebar-item" onContextMenu={event => {
      event.preventDefault(); if (!disabled) setMenu(chat.id);
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
          title={chat.title} disabled={disabled} onClick={() => open(chat)}>
          {chat.pinned && <span className="pinned-mark" aria-hidden="true" title="Закреплён" /> }<span>{chat.title}</span>
        </button>
        <button type="button" className="composer-control chat-more" aria-label={"Действия чата " + chat.title} aria-expanded={menu === chat.id}
          disabled={disabled} onClick={() => setMenu(value => value === chat.id ? "" : chat.id)}><Icon name="more" /></button>
      </>}
      {menu === chat.id && <div className="chat-menu model-panel">
        <button type="button" className="model-option" onClick={() => { setMenu(""); setRenaming(chat.id); setTitle(chat.title); }}>Переименовать</button>
        <button type="button" className="model-option" onClick={() => action({ type: "pin", value: !chat.pinned })}>{chat.pinned ? "Открепить" : "Закрепить"}</button>
        <button type="button" className="model-option" onClick={() => action({ type: "fork" })}>Форк</button>
        <button type="button" className="model-option" onClick={() => action({ type: "archive", value: !chat.archived })}>
          {chat.archived ? "Вернуть из архива" : "Архивировать"}
        </button>
        <button type="button" className="model-option danger-action" onClick={() => {
          if (window.confirm("Удалить чат «" + chat.title + "»?")) action({ type: "delete" });
        }}>Удалить</button>
      </div>}
    </li>;
  }
  const archived = ordered(filtered.filter(chat => chat.archived));
  return <nav className="recent chat-groups" aria-label="Чаты по проектам">
    {[...groups].map(([directory, chats]) => {
      const expanded = !collapsed.includes(directory);
      return <section className="chat-group" key={directory}>
        <header><button type="button" className="sidebar-row group-name" aria-expanded={expanded} title={directory} onClick={() =>
          setCollapsed(value => expanded ? value.filter(path => path !== directory) : [...value, directory])}>
          <Icon name="chevron" /><span>{directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory}</span>
        </button><button type="button" className="composer-control attach group-new" aria-label="Новый чат в этой папке" title="Новый чат в этой папке"
          disabled={disabled} onClick={() => start(directory)}><Icon name="plus" /></button></header>
        {expanded && <ul>{chats.map(row)}</ul>}
      </section>;
    })}
    {query && !filtered.length && <p className="subtle sidebar-empty">Чаты не найдены.</p>}
    <details className="chat-archive" open={query && archived.length ? true : undefined}>
      <summary className="sidebar-row"><Icon name="chevron" />Архив{archived.length > 0 && <span> · {archived.length}</span>}</summary>
      {archived.length ? <ul>{archived.map(row)}</ul> : <p className="subtle sidebar-empty">Архив пуст.</p>}
    </details>
  </nav>;
}
