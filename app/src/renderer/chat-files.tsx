import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FileAction, FileChange, FileInfo, FilePreview } from "../shared/api";
import { fileExtension, type FileReference } from "../shared/file-links";
import { projectFileUrl } from "../shared/browser";
import { Icon } from "./icons";

export type ChatFiles = {
  directory: string;
  stat: (path: string) => Promise<FileInfo | null> | undefined;
  preview: (reference: FileReference) => void;
  onError: (error: unknown) => void;
  openBrowser?: (url: string) => void;
};

const api = window.vsemkod;
const revealLabel = /Mac/i.test(navigator.platform) ? "Показать в Finder" : /Win/i.test(navigator.platform) ? "Показать в проводнике" : "Показать в папке";

function useFileInfo(files: ChatFiles, path: string) {
  const [info, setInfo] = useState<FileInfo | null>();
  useEffect(() => {
    let current = true;
    setInfo(undefined);
    void files.stat(path)?.then(value => { if (current) setInfo(value); }).catch(() => {});
    return () => { current = false; };
  }, [path, files.stat]);
  return info;
}

function useImage(files: ChatFiles, path: string, info: FileInfo | null | undefined) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let current = true;
    setImage(undefined);
    if (info?.image) void api.filePreview?.(files.directory, path)
      .then(preview => { if (current) setImage(preview.image); }).catch(() => {});
    return () => { current = false; };
  }, [info, files.directory, path]);
  return image;
}

export function fileIcon(path: string, image = false) {
  if (image) return "image";
  return /^(?:tsx?|jsx?|html?|css|md|json|py|sh|cpp|c|go|rs)$/.test(fileExtension(path)) ? "code" : "file";
}

function perform(files: Pick<ChatFiles, "directory" | "onError">, path: string, action: FileAction) {
  void api.fileAction?.(files.directory, path, action).catch(files.onError);
}

type MenuState = { reference: FileReference; info: FileInfo; x: number; y: number; origin: HTMLElement };

/** Меню файла: по правой кнопке открывается у курсора, по кнопке «⋯» — под ней. */
function FileMenu({ state, files, close }: { state: MenuState; files: ChatFiles; close: (restoreFocus: boolean) => void }) {
  const { reference, info, x, y } = state;
  const box = useRef<HTMLDivElement>(null);
  const closing = useRef(close);
  closing.current = close;
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const menu = box.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, innerWidth - width - 8)),
      top: y + height > innerHeight - 8 ? Math.max(8, y - height) : y
    });
  }, [x, y]);
  // Пока меню скрыто для замера, фокус в него не ставится — переводим фокус после показа.
  useEffect(() => { if (position) box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true }); }, [position]);
  useEffect(() => {
    const outside = (event: Event) => { if (!box.current?.contains(event.target as Node)) closing.current(false); };
    const dismiss = () => closing.current(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closing.current(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, []);
  const items: { label: string; run: () => void; group?: boolean }[] = [
    { label: "Открыть в панели", run: () => files.preview(reference) },
    ...info.canOpen ? [{ label: "Открыть в приложении", run: () => perform(files, reference.path, "open") }] : [],
    ...(info.html || info.svg) && files.openBrowser
      ? [{ label: "Открыть в браузере приложения", run: () => files.openBrowser?.(projectFileUrl(info.path)) }] : [],
    ...info.html && info.canOpen ? [{ label: "Открыть во внешнем браузере", run: () => perform(files, reference.path, "browser") }] : [],
    { label: revealLabel, run: () => perform(files, reference.path, "reveal"), group: true },
    { label: "Копировать путь", run: () => void api.copyText(info.path).catch(files.onError) }
  ];
  return <div ref={box} className="model-panel file-menu" role="menu" aria-label={"Действия файла " + info.name}
    style={position ?? { left: x, top: y, visibility: "hidden" }}
    onClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); close(true); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    {items.map(item => <Fragment key={item.label}>
      {item.group && <hr className="file-menu-separator" />}
      <button type="button" role="menuitem" className="model-option" onClick={() => { close(true); item.run(); }}>{item.label}</button>
    </Fragment>)}
  </div>;
}

export function useFileMenu(files: ChatFiles) {
  const [state, setState] = useState<MenuState>();
  function open(event: MouseEvent<HTMLElement>, reference: FileReference, info?: FileInfo | null) {
    if (!api.fileStat) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = event.currentTarget;
    const rect = origin.getBoundingClientRect();
    const pointer = event.type === "contextmenu" && (event.clientX > 0 || event.clientY > 0);
    const x = pointer ? event.clientX : rect.left;
    const y = pointer ? event.clientY : rect.bottom + 4;
    const show = (value: FileInfo | null | undefined) => { if (value) setState({ reference, info: value, x, y, origin }); };
    if (info) show(info);
    else void files.stat(reference.path)?.then(show).catch(() => {});
  }
  function close(restoreFocus: boolean) {
    if (restoreFocus) state?.origin.focus({ preventScroll: true });
    setState(undefined);
  }
  return { open, active: Boolean(state), menu: state ? createPortal(<FileMenu state={state} files={files} close={close} />, document.body) : null };
}

export function FileChip({ files, reference, children }: { files: ChatFiles; reference: FileReference; children: ReactNode }) {
  const info = useFileInfo(files, reference.path);
  const menu = useFileMenu(files);
  if (!info) return children;
  return <span className="file-chip-wrap" onContextMenu={event => menu.open(event, reference, info)}>
    <button type="button" className="file-chip" title={info.path} onClick={() => files.preview(reference)}>
      <Icon name={fileIcon(info.name, info.image)} /><span>{info.name}</span>
      {info.directory && <small className="subtle">{info.directory}</small>}
    </button>
    <button type="button" className="file-chip-more" aria-label={"Действия файла " + info.name} aria-haspopup="menu" aria-expanded={menu.active}
      onClick={event => menu.open(event, reference, info)}>
      <Icon name="more" />
    </button>
    {menu.menu}
  </span>;
}

/** Ссылка агента на файл проекта: открывает просмотр в панели, по правой кнопке — меню файла. */
export function FileLink({ files, reference, children }: { files: ChatFiles; reference: FileReference; children: ReactNode }) {
  const info = useFileInfo(files, reference.path);
  const menu = useFileMenu(files);
  return <>
    <a className="text-link file-link" href={info ? projectFileUrl(info.path) : "#"} title={info?.path ?? reference.path}
      onClick={event => { event.preventDefault(); files.preview(reference); }}
      onContextMenu={event => menu.open(event, reference, info)}>{children}</a>
    {menu.menu}
  </>;
}

/** Картинка из проекта прямо в ответе: ![подпись](путь). Картинки из интернета в чате не загружаются. */
export function LocalImage({ files, reference, alt }: { files: ChatFiles; reference: FileReference; alt?: string }) {
  const info = useFileInfo(files, reference.path);
  const image = useImage(files, reference.path, info);
  const menu = useFileMenu(files);
  if (info === undefined) return null;
  const name = info?.name ?? reference.path.split(/[\\/]/).at(-1) ?? reference.path;
  if (!info?.image) return <FileLink files={files} reference={reference}>{alt || name}</FileLink>;
  return <>
    <button type="button" className="inline-image checkerboard" aria-label={"Просмотр " + name} title={info.path}
      onClick={() => files.preview(reference)} onContextMenu={event => menu.open(event, reference, info)}>
      {image ? <img src={image} alt={alt || name} /> : <span className="subtle">{alt || name}</span>}
    </button>
    {menu.menu}
  </>;
}

function ChangedFile({ path, line, change, files }: { path: string; line?: number; change?: FileChange; files: ChatFiles }) {
  const info = useFileInfo(files, path);
  const image = useImage(files, path, info);
  const menu = useFileMenu(files);
  if (!change && !info) return null;
  const name = info?.name ?? path.split(/[\\/]/).at(-1) ?? path;
  const open = () => files.preview({ path, line });
  return <li className="turn-file" onContextMenu={event => menu.open(event, { path, line }, info)}>
    <div className="turn-file-heading" title={info?.path ?? path}>
      <Icon name={fileIcon(name, info?.image)} /><strong>{name}</strong>
      {change && <span className="delta"><span className="add">+{change.additions}</span><span className="remove">−{change.deletions}</span></span>}
    </div>
    {image && <button className="turn-file-image checkerboard" type="button" aria-label={"Просмотр " + name} onClick={open}><img src={image} alt={name} /></button>}
    {info && <div className="turn-file-actions">
      {info.canOpen && <button type="button" className="composer-control" onClick={open}>Открыть</button>}
      <button type="button" className="composer-control" onClick={() => perform(files, path, "reveal")}>Показать в папке</button>
      {info.html && <>
        {files.openBrowser && <button type="button" className="small-button" onClick={() => files.openBrowser?.(projectFileUrl(info.path))}>Открыть в браузере приложения</button>}
        <button type="button" className="composer-control" onClick={() => perform(files, path, "browser")}>{files.openBrowser ? "Во внешнем" : "Открыть в браузере"}</button>
      </>}
      <button type="button" className="composer-control turn-file-more" aria-label={"Действия файла " + name} aria-haspopup="menu" aria-expanded={menu.active}
        onClick={event => menu.open(event, { path, line }, info)}><Icon name="more" /></button>
    </div>}
    {menu.menu}
  </li>;
}

function samePath(a: string, b: string) {
  const left = a.replaceAll("\\", "/").toLowerCase();
  const right = b.replaceAll("\\", "/").toLowerCase();
  return left === right || left.endsWith("/" + right) || right.endsWith("/" + left);
}

/** Карточки файлов под ответом: изменённые агентом и те, на которые он сослался в тексте. */
export function TurnFiles({ changes, linked = [], files }: { changes: FileChange[]; linked?: FileReference[]; files: ChatFiles }) {
  const [expanded, setExpanded] = useState(false);
  if (!api.fileStat) return null;
  const items = [
    ...changes.map(change => ({ path: change.file, line: undefined, change })),
    ...linked.filter(link => !changes.some(change => samePath(change.file, link.path))).map(link => ({ ...link, change: undefined }))
  ];
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, 4);
  return <section className="turn-files" aria-label="Файлы">
    <h2>Файлы</h2><ul>{shown.map(item => <ChangedFile {...item} files={files} key={item.path} />)}</ul>
    {items.length > 4 && <button type="button" aria-expanded={expanded} className="composer-control" onClick={() => setExpanded(value => !value)}>
      {expanded ? "Свернуть" : "Ещё " + (items.length - 4)}
    </button>}
  </section>;
}

export function Preview({ directory, reference, onError }: {
  directory: string; reference?: FileReference; onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<{ path: string; value?: FilePreview; error?: string }>();
  const [source, setSource] = useState(false);
  const target = useRef<HTMLElement>(null);
  const path = reference?.path;
  const line = reference?.line;
  useEffect(() => {
    let current = true;
    setSource(false);
    if (path) {
      if (!api.filePreview) setState({ path, error: "Просмотр недоступен в демо." });
      else void api.filePreview(directory, path)
        .then(value => { if (current) { setState({ path, value }); setSource(!!line && value.info.svg); } })
        .catch(error => { if (current) setState({ path, error: error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(error) }); });
    }
    return () => { current = false; };
  }, [directory, path, reference]);
  const result = state?.path === path ? state : undefined;
  const preview = result?.value;
  useEffect(() => { target.current?.scrollIntoView({ block: "center" }); }, [preview, line, source]);
  if (!path) return <p className="subtle panel-empty">Выберите файл для просмотра.</p>;
  const info = preview?.info;
  return <section className="panel-body stage-g-preview" aria-label="Просмотр файла">
    <div className="preview-head">
      <strong title={info?.path}>{info?.relativePath ?? path}</strong>
      {info && <div className="turn-file-actions">
        {info.canOpen && <button type="button" className="composer-control" onClick={() => perform({ directory, onError }, path, "open")}>Открыть в приложении</button>}
        <button type="button" className="composer-control" onClick={() => perform({ directory, onError }, path, "reveal")}>Показать в папке</button>
        {info.svg && <button type="button" className="composer-control" aria-pressed={source} onClick={() => setSource(value => !value)}>Код</button>}
      </div>}
    </div>
    {result?.error && <p className="subtle panel-empty" role="status">{result.error}</p>}
    {!result && <p className="subtle panel-empty">Открываем файл…</p>}
    {preview?.image && !source && <div className="preview-image checkerboard"><img src={preview.image} alt={info?.name} /></div>}
    {preview && (!preview.image || source) && <>
      {preview.truncated && <p className="subtle">Первые 512 КБ файла</p>}
      {preview.text ? <pre className="preview-code">{preview.text.split(/\r?\n/).map((text, index) =>
        <span key={index} className="preview-line" data-current={index + 1 === line || undefined} ref={index + 1 === line ? target : undefined}>
          <span className="preview-line-number" aria-hidden="true">{index + 1}</span><code>{text || " "}</code>
        </span>)}</pre> : <p className="subtle">Пустой файл</p>}
    </>}
  </section>;
}
