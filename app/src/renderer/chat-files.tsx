import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FileAction, FileChange, FileInfo, FilePreview } from "../shared/api";
import { fileExtension, type FileReference } from "../shared/file-links";
import { Icon } from "./icons";

export type ChatFiles = {
  directory: string;
  stat: (path: string) => Promise<FileInfo | null> | undefined;
  preview: (reference: FileReference) => void;
  onError: (error: unknown) => void;
};

const api = window.vsemkod;

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

function fileIcon(path: string, image = false) {
  if (image) return "image";
  return /^(?:tsx?|jsx?|html?|css|md|json|py|sh|cpp|c|go|rs)$/.test(fileExtension(path)) ? "code" : "file";
}

function perform(files: Pick<ChatFiles, "directory" | "onError">, path: string, action: FileAction) {
  void api.fileAction?.(files.directory, path, action).catch(files.onError);
}

export function FileChip({ files, reference, children }: { files: ChatFiles; reference: FileReference; children: ReactNode }) {
  const info = useFileInfo(files, reference.path);
  const [menu, setMenu] = useState(false);
  const control = useRef<HTMLSpanElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    first.current?.focus();
    const close = (event: PointerEvent) => { if (!control.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  if (!info) return children;
  const reveal = () => perform(files, reference.path, "reveal");
  function done(run: () => void) { setMenu(false); run(); chip.current?.focus(); }
  return <span className="file-chip-wrap" ref={control} onContextMenu={event => { event.preventDefault(); setMenu(true); }}
    onKeyDown={event => {
      if (event.key === "Escape" && menu) { event.stopPropagation(); event.preventDefault(); setMenu(false); chip.current?.focus(); }
    }}>
    <button ref={chip} type="button" className="file-chip" title={info.path} onClick={() => files.preview(reference)}>
      <Icon name={fileIcon(info.name, info.image)} /><span>{info.name}</span>
      {info.directory && <small className="subtle">{info.directory}</small>}
    </button>
    <button type="button" className="file-chip-more" aria-label={"Действия файла " + info.name} aria-expanded={menu} onClick={() => setMenu(value => !value)}>
      <Icon name="more" />
    </button>
    {menu && <span className="model-panel file-chip-menu">
      {info.canOpen && <button ref={first} type="button" className="model-option" onClick={() => done(() => perform(files, reference.path, "open"))}>Открыть в приложении</button>}
      <button ref={info.canOpen ? undefined : first} type="button" className="model-option" onClick={() => done(reveal)}>Показать в папке</button>
      <button type="button" className="model-option" onClick={() => done(() => void api.copyText(info.path).catch(files.onError))}>Копировать путь</button>
    </span>}
  </span>;
}

function ChangedFile({ change, files }: { change: FileChange; files: ChatFiles }) {
  const info = useFileInfo(files, change.file);
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let current = true;
    setImage(undefined);
    if (info?.image) void api.filePreview?.(files.directory, change.file)
      .then(preview => { if (current) setImage(preview.image); }).catch(() => {});
    return () => { current = false; };
  }, [info, files.directory, change.file]);
  const name = info?.name ?? change.file.split(/[\\/]/).at(-1) ?? change.file;
  const open = () => files.preview({ path: change.file });
  return <li className="turn-file">
    <div className="turn-file-heading" title={info?.path ?? change.file}>
      <Icon name={fileIcon(name, info?.image)} /><strong>{name}</strong>
      <span className="delta"><span className="add">+{change.additions}</span><span className="remove">−{change.deletions}</span></span>
    </div>
    {image && <button className="turn-file-image checkerboard" type="button" aria-label={"Просмотр " + name} onClick={open}><img src={image} alt={name} /></button>}
    {info && <div className="turn-file-actions">
      {info.canOpen && <button type="button" className="composer-control" onClick={open}>Открыть</button>}
      <button type="button" className="composer-control" onClick={() => perform(files, change.file, "reveal")}>Показать в папке</button>
      {info.html && <button type="button" className="composer-control" onClick={() => perform(files, change.file, "browser")}>Открыть в браузере</button>}
    </div>}
  </li>;
}

export function TurnFiles({ changes, files }: { changes: FileChange[]; files: ChatFiles }) {
  const [expanded, setExpanded] = useState(false);
  if (!changes.length || !api.fileStat) return null;
  const shown = expanded ? changes : changes.slice(0, 4);
  return <section className="turn-files" aria-label="Файлы">
    <h2>Файлы</h2><ul>{shown.map(change => <ChangedFile change={change} files={files} key={change.file} />)}</ul>
    {changes.length > 4 && <button type="button" aria-expanded={expanded} className="composer-control" onClick={() => setExpanded(value => !value)}>
      {expanded ? "Свернуть" : "Ещё " + (changes.length - 4)}
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
        .catch(error => { if (current) setState({ path, error: error instanceof Error ? error.message : String(error) }); });
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
