import { useEffect, useRef, useState } from "react";
import type { Conversation } from "../shared/api";
import { projectTemplates, type ProjectTemplate } from "../shared/templates";
import { folderName } from "../shared/workspace";
import { Icon } from "./icons";
import { TemplateDialog } from "./templates";

const relative = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
function ago(time: number) {
  const minutes = Math.round((time - Date.now()) / 60_000);
  if (minutes > -60) return relative.format(Math.min(-1, minutes), "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relative.format(hours, "hour");
  const days = Math.round(hours / 24);
  return days > -7 ? relative.format(days, "day") : new Date(time).toLocaleDateString("ru", { day: "numeric", month: "short" });
}

const examples = [
  "Сделай лендинг для кофейни с формой заявки",
  "Найди и исправь ошибки в проекте",
  "Объясни, как устроен этот код"
];

/**
 * Пустой экран нового чата: одна фраза с названием проекта, недавние чаты этого проекта
 * и «Начать с шаблона». Поле ввода стоит внизу — там же, где в чате.
 */
export function HomeStart({ logo, directory, projects, sessions, selectProject, chooseProject, open, example, startTemplate, defaultFolder }: {
  logo: string; directory: string; projects: string[]; sessions: Conversation[];
  selectProject: (path: string) => void; chooseProject: () => void; open: (chat: Conversation) => void;
  example: (text: string) => void; startTemplate: (template: ProjectTemplate, name: string) => Promise<void>; defaultFolder?: string;
}) {
  const [menu, setMenu] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [template, setTemplate] = useState<ProjectTemplate>();
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);
  const recent = sessions.filter(chat => chat.directory === directory && !chat.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const name = folderName(directory);

  return <div className="home-start">
    <img className="home-mark" src={logo} width="26" height="26" alt="" />
    <h1>{name ? <>Над чем поработаем в <span className="home-project-anchor" ref={anchor}>
      <button type="button" className="home-project" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)}>{name}</button>
      {menu && <div className="model-panel home-project-menu" role="menu" aria-label="Проект">
        {projects.map(path => <button key={path} type="button" role="menuitemradio" aria-checked={path === directory} className="model-option" title={path}
          onClick={() => { setMenu(false); if (path !== directory) selectProject(path); }}>
          <Icon name="folder" /><span className="project-option-name">{folderName(path)}</span>{path === directory && <Icon name="check" />}
        </button>)}
        <button type="button" role="menuitem" className="model-option project-pick" onClick={() => { setMenu(false); chooseProject(); }}>
          <Icon name="plus" />Выбрать папку…
        </button>
      </div>}
    </span>?</> : "Выберите папку проекта"}</h1>
    {!name && <button type="button" className="composer-control home-choose" onClick={chooseProject}><Icon name="folder" />Выбрать папку</button>}

    {name && <div className="home-list">
      <p className="home-list-title">{recent.length ? "Недавние" : "Например"}</p>
      {recent.length ? recent.map(chat => <button key={chat.id} type="button" className="home-row" onClick={() => open(chat)}>
        <span className="home-row-title">{chat.title}</span><span className="home-row-meta">{ago(chat.updatedAt)}</span>
      </button>) : examples.map(text => <button key={text} type="button" className="home-row" onClick={() => example(text)}>
        <span className="home-row-title">{text}</span>
      </button>)}
      {window.vsemkod.createFromTemplate && <>
        <button type="button" className="home-row home-row--more" aria-expanded={templates} onClick={() => setTemplates(value => !value)}>
          <span className="home-row-title">Начать новый проект с шаблона</span><Icon name="chevron" className="chevron" />
        </button>
        {templates && <div className="home-templates">
          {projectTemplates.map(item => <button key={item.id} type="button" className="home-row home-row--template" onClick={() => setTemplate(item)}>
            <span className="home-row-title">{item.title}</span><span className="home-row-meta">{item.description}</span>
          </button>)}
        </div>}
      </>}
    </div>}
    {template && <TemplateDialog template={template} defaultFolder={defaultFolder} close={() => setTemplate(undefined)} start={startTemplate} />}
  </div>;
}
