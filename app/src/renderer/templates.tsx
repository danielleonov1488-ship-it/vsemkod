import { useEffect, useRef, useState } from "react";
import { templateFolderName, type ProjectTemplate } from "../shared/templates";
import { readableError } from "./connections";
import { Icon } from "./icons";
import { WindowControls } from "./window-controls";

/** Короткий диалог: название папки нового проекта из шаблона. */
export function TemplateDialog({ template, defaultFolder, close, start }: {
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
