import { useEffect, useRef, useState } from "react";
import { projectTemplates, templateFolderName, type ProjectTemplate } from "../shared/templates";
import { readableError } from "./connections";
import { Icon } from "./icons";
import { WindowControls } from "./window-controls";

/** «Начать новый проект» на домашнем экране: карточки шаблонов и короткий диалог с названием папки. */
export function TemplateGallery({ defaultFolder, start }: {
  defaultFolder?: string; start: (template: ProjectTemplate, name: string) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<ProjectTemplate>();
  if (!window.vsemkod.createFromTemplate) return null;
  return <section className="templates" aria-labelledby="templates-title">
    <h2 id="templates-title">Или начните новый проект</h2>
    <div className="template-grid">
      {projectTemplates.map(template => <button type="button" className="template-card" key={template.id} onClick={() => setChosen(template)}>
        <span className="template-icon" aria-hidden="true"><Icon name={template.icon} /></span>
        <span className="template-copy"><strong>{template.title}</strong><span>{template.description}</span></span>
      </button>)}
    </div>
    {chosen && <TemplateDialog template={chosen} defaultFolder={defaultFolder} close={() => setChosen(undefined)} start={start} />}
  </section>;
}

function TemplateDialog({ template, defaultFolder, close, start }: {
  template: ProjectTemplate; defaultFolder?: string; close: () => void; start: (template: ProjectTemplate, name: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(template.folder);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => restore?.focus();
  }, []);
  const folder = templateFolderName(name);
  return <dialog ref={dialog} className="connect-dialog template-dialog" aria-labelledby="template-title"
    onCancel={event => { event.preventDefault(); if (!working) close(); }}>
    <WindowControls floating />
    <button className="composer-control attach dialog-close" type="button" title="Закрыть" aria-label="Закрыть" disabled={working} onClick={close}><Icon name="close" /></button>
    <span className="template-icon template-icon--large" aria-hidden="true"><Icon name={template.icon} /></span>
    <h1 id="template-title">Новый проект: {template.title.toLowerCase()}</h1>
    <p className="connect-intro">{template.prompt
      ? "Создам папку с правилами для агента и сразу отправлю ему первую задачу. Её можно будет поправить в чате."
      : "Создам пустую папку проекта и открою в ней чат."}</p>
    <form className="provider-actions" onSubmit={event => {
      event.preventDefault();
      if (working || !name.trim()) return;
      setWorking(true);
      setError("");
      void start(template, name.trim()).then(close).catch(failure => { setError(readableError(failure)); setWorking(false); });
    }}>
      <label className="manual-field">Название папки<input value={name} required maxLength={80} autoFocus spellCheck={false}
        onChange={event => setName(event.target.value)} disabled={working} /></label>
      {defaultFolder && <p className="settings-hint template-path" title={defaultFolder}>Папка появится здесь: {defaultFolder.replace(/[\\/]+$/, "")}{defaultFolder.includes("\\") ? "\\" : "/"}{folder}</p>}
      <button className="small-button connect-submit" type="submit" disabled={working || !name.trim()}>{working ? "Создаём…" : template.prompt ? "Создать и начать" : "Создать"}</button>
      {error && <p className="connect-feedback connect-error" role="alert">{error}</p>}
    </form>
  </dialog>;
}
