import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export function WorktreeMenu({ branch, changed, disabled, onOpen, merge, openFolder, remove }: {
  branch: string; changed: number; disabled: boolean; onOpen: () => void;
  merge: () => void; openFolder: () => void; remove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const select = (action: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };

  return <div className="worktree-anchor" ref={anchor}>
    <button type="button" className="composer-control worktree-branch" ref={trigger}
      aria-label={"Действия копии · " + branch} aria-expanded={open} title={branch}
      onClick={() => { if (!open) onOpen(); setOpen(!open); }}>
      <Icon name="branch" />{branch.length > 24 ? branch.slice(0, 23) + "…" : branch}
    </button>
    {open && <div className="model-panel panel-popup worktree-menu" role="group" aria-label="Действия копии">
      <button type="button" className="model-option worktree-merge" disabled={disabled || changed === 0} onClick={() => select(merge)}>
        <span>Влить в основную папку</span>
        <small className="subtle">Изменено файлов: {changed}</small>
      </button>
      <button type="button" className="model-option" onClick={() => select(openFolder)}>Открыть папку копии</button>
      <hr />
      <button type="button" className="model-option danger-action" disabled={disabled} onClick={() => select(remove)}>Удалить копию…</button>
    </div>}
  </div>;
}
