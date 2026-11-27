import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { Attachment, Preferences, ProjectTools } from "../shared/api";
import { builtInCommands, folderName, imageFile, suggestionAt, type AccessMode } from "../shared/workspace";
import { AccessPicker } from "./access-picker";
import { Icon } from "./icons";
import { useVoiceComposer } from "./voice-composer";

const api = window.vsemkod;
type Suggestion = { key: string; text: string; detail?: string; folder?: boolean };

export function Composer({ active, input, draft, change, directory, busy, canSend, attachments, remove, add, pick, choose,
  projects, switchProject, separateCopy, toggleSeparateCopy, access, accessMenu, selectAccess, cycle, submit, stop, selectCommand, tools, modelControls, vision, onError, preferences, updatePreferences }: {
  preferences?: Preferences; updatePreferences: (patch: Partial<Preferences>) => void;
  active: boolean; input: RefObject<HTMLTextAreaElement | null>; draft: string; change: (value: string) => void;
  directory: string; projects: string[]; switchProject: (path: string) => void; busy: boolean; canSend: boolean; attachments: Attachment[]; remove: (id: string) => void;
  add: (files: File[]) => void; pick: () => void; choose: () => void; access: AccessMode; accessMenu: number; selectAccess: (mode: AccessMode, confirmed?: boolean) => void; cycle: () => void;
  submit: () => void; stop: () => void; selectCommand: (name: string) => boolean;
  separateCopy?: boolean; toggleSeparateCopy: () => void;
  tools?: ProjectTools; modelControls: ReactNode; vision: boolean; onError: (text: string) => void;
}) {
  const voice = useVoiceComposer({ draft, input, change, preferences, update: updatePreferences,
    onError: error => onError(error instanceof Error ? error.message : String(error)) });
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const [paths, setPaths] = useState<Suggestion[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [menu, setMenu] = useState<"add" | "project">();
  const popupTrigger = useRef<HTMLButtonElement>(null);
  const [commands, setCommands] = useState(false);
  const token = voice.busy || dismissed ? undefined : commands ? { kind: "command" as const, query: "", start: 0, end: 0 }
    : suggestionAt(draft, cursor);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".composer-popup")) setMenu(undefined);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenu(undefined);
      popupTrigger.current?.focus();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); };
  }, [menu]);
  const search = token?.kind === "path" ? token.query : undefined;
  useEffect(() => {
    setPaths([]);
    if (search === undefined || !directory) return;
    let current = true;
    const timer = setTimeout(() => void api.findFiles(directory, search).then(items => {
      if (current) setPaths(items.map(item => ({ key: item.path, text: item.path, folder: item.type === "directory" })));
    }).catch(() => {}), 100);
    return () => { current = false; clearTimeout(timer); };
  }, [directory, search]);
  const suggestions: Suggestion[] = token?.kind === "command" ? [
    ...builtInCommands.map(item => ({ key: item.name, text: "/" + item.name, detail: item.description })),
    ...tools?.commands.filter(item => !builtInCommands.some(built => built.name === item.name))
      .map(item => ({ key: item.name, text: "/" + item.name, detail: item.description })) ?? [],
    ...tools?.skills.map(item => ({ key: "skill." + item.name, text: "/skill." + item.name, detail: item.description })) ?? []
  ].filter(item => item.key.toLowerCase().startsWith(token.query.toLowerCase())).slice(0, 10) : paths;
  const selected = suggestions[Math.min(index, suggestions.length - 1)];
  function pickSuggestion(item: Suggestion) {
    if (!token) return;
    setCommands(false);
    if (token.kind === "command" && selectCommand(item.key)) {
      setDismissed(true);
      return;
    }
    const path = item.key.replaceAll("\\", "/");
    const replacement = token.kind === "command" ? item.text : (/\s|[.,;:!?)\]}]$/.test(path) ? '@"' + path + '"' : "@" + path);
    change(draft.slice(0, token.start) + replacement + " " + draft.slice(token.end));
    setDismissed(true);
    const position = token.start + replacement.length + 1;
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position, position); });
  }
  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || voice.busy) return;
    if (event.shiftKey && event.key === "Tab") {
      event.preventDefault();
      cycle();
      return;
    }
    if (token && event.key === "Escape" && !busy) {
      event.preventDefault();
      setDismissed(true);
      return;
    }
    if (token && selected && !event.ctrlKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((Math.min(index, suggestions.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pickSuggestion(selected);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      setDismissed(true);
      setCommands(false);
      submit();
    }
  }
  function toggleMenu(next: "add" | "project", trigger: HTMLButtonElement) {
    popupTrigger.current = trigger;
    setDismissed(true);
    setCommands(false);
    setMenu(menu === next ? undefined : next);
  }

  function openSuggestions(kind: "path" | "command") {
    setMenu(undefined);
    setDismissed(false);
    setIndex(0);
    setCommands(kind === "command" && draft.length > 0);
    const start = input.current?.selectionStart ?? draft.length;
    const end = input.current?.selectionEnd ?? start;
    const prefix = draft.slice(0, start);
    const inserted = kind === "path" ? (/\S$/.test(prefix) ? " @" : "@") : draft ? "" : "/";
    if (inserted) change(prefix + inserted + draft.slice(end));
    const position = start + inserted.length;
    setCursor(position);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position, position); });
  }

  function receive(files: File[]) {
    const images = files.filter(file => file.type.startsWith("image/") || imageFile(file.name));
    if (!vision && images.length) onError("Выбранная модель не принимает изображения. Выберите модель с поддержкой изображений.");
    const supported = vision ? files : files.filter(file => !images.includes(file));
    if (supported.length) add(supported);
  }
  const context = <>
        <div className="composer-popup composer-project">
          <button className="composer-control folder-chip" type="button" title={directory || "Выбрать папку проекта"}
            aria-label={"Проект · " + (folderName(directory) || "Выбрать папку")} aria-expanded={menu === "project"} disabled={busy}
            onClick={event => toggleMenu("project", event.currentTarget)}><Icon name="folder" />
            <span>{folderName(directory) || "Папка проекта"}</span><Icon name="chevron" className="chevron" />
          </button>
          {menu === "project" && <div className="model-panel composer-popup-list" aria-label="Выбор проекта" role="region">
            {projects.map(path => <button className="model-option" key={path} type="button" title={path} aria-pressed={path === directory}
              onClick={() => { setMenu(undefined); switchProject(path); }}>
              <Icon name="folder" /><span className="project-option-name">{folderName(path)}</span>
              {path === directory && <Icon name="check" />}
            </button>)}
            <button className="model-option project-pick" type="button" onClick={() => { setMenu(undefined); choose(); }}>
              <Icon name="plus" />Выбрать папку…
            </button>
          </div>}
        </div>
        {separateCopy !== undefined && <button className="composer-control worktree-toggle" type="button"
          aria-pressed={separateCopy} disabled={busy} onClick={toggleSeparateCopy}
          title="Задача пойдёт в отдельной копии проекта: можно вести несколько задач параллельно и потом влить результат">
          <Icon name="branch" />Отдельная копия
        </button>}
        <AccessPicker value={access} confirmed={preferences?.fullAccessConfirmed} select={selectAccess} warningSignal={accessMenu} />
  </>;
  return <>{!active && <div className="composer-context" aria-label="Проект и доступ">{context}</div>}<form className={"composer" + (active ? "" : " composer--home") + (dragging ? " composer--dragging" : "")}
    onSubmit={event => { event.preventDefault(); if (!voice.busy) submit(); }} onDragEnter={event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault(); dragDepth.current++; setDragging(true);
    }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); receive(Array.from(event.dataTransfer.files)); }}>
    {token && suggestions.length > 0 && <div className="model-panel composer-menu" aria-label={token.kind === "command" ? "Список команд" : "Упоминания файлов"} role="listbox">
      {suggestions.map(item => <button type="button" key={item.key} role="option" aria-selected={selected === item} className="model-option"
        onMouseDown={event => event.preventDefault()} onClick={() => pickSuggestion(item)}>
        {token.kind === "path" && <Icon name={item.folder ? "folder" : "file"} />}
        <span className="model-copy"><span className="model-name">{item.text}</span>
          {item.detail && <span className="model-description">{item.detail}</span>}</span>
      </button>)}
    </div>}
    <textarea ref={input} className="composer-input" value={draft} readOnly={voice.busy} rows={1} aria-label="Сообщение агенту" maxLength={100_000}
      placeholder={active ? "Что сделать дальше?" : "Опиши задачу — агент сам напишет код"}
      onChange={event => { change(event.target.value); setCursor(event.target.selectionStart); setIndex(0); setDismissed(false); setCommands(false); }}
      onSelect={event => setCursor(event.currentTarget.selectionStart)}
      onKeyDown={keydown} onPaste={event => {
        const files = Array.from(event.clipboardData.files);
        if (files.length) { event.preventDefault(); receive(files); }
      }} />
    {voice.controls}
    {attachments.length > 0 && <ul className="attachments" aria-label="Прикреплённые файлы">
      {attachments.map(file => <li key={file.id}><button type="button" className="composer-control folder-chip" aria-label={"Убрать " + file.name}
        onClick={() => remove(file.id)}>{file.preview && <img className="attachment-preview" src={file.preview} alt="" />}
        <span>{file.name}</span><Icon name="close" /></button></li>)}
    </ul>}
    <div className="composer-toolbar">
      <div className="composer-controls">
        <div className="composer-popup">
          <button className="composer-control attach" type="button" aria-label="Добавить в сообщение" title="Добавить в сообщение"
            aria-expanded={menu === "add"} onClick={event => toggleMenu("add", event.currentTarget)}><Icon name="plus" /></button>
          {menu === "add" && <div className="model-panel composer-popup-list" aria-label="Добавить в сообщение" role="region">
            <button className="model-option" type="button" disabled={!directory} onClick={() => { setMenu(undefined); pick(); }}>
              <Icon name="paperclip" />Прикрепить файлы или картинки
            </button>
            <button className="model-option" type="button" disabled={!directory || voice.busy} onClick={() => openSuggestions("path")}>
              <Icon name="file" />Упомянуть файл (@)
            </button>
            <button className="model-option" type="button" disabled={voice.busy} onClick={() => openSuggestions("command")}>
              <Icon name="terminal" />Команды (/)
            </button>
          </div>}
        </div>
        {active && context}
      </div>
      <div className="composer-controls composer-controls--right">
        {modelControls}
        {busy && <button className="send stop-button" type="button" title="Стоп · Esc Esc" aria-label="Стоп" onClick={stop}><Icon name="stop" /></button>}
        {voice.button}
        {!busy && <button className="send" type="submit" title="Отправить"
          aria-label="Отправить" disabled={!canSend || voice.busy}><Icon name="send" /></button>}
      </div>
    </div>
  </form></>;
}
