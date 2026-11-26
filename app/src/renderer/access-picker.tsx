import { useEffect, useRef, useState } from "react";
import type { AccessMode } from "../shared/workspace";
import { accessLabels } from "../shared/workspace";
import { Icon } from "./icons";

const accessOptions = [
  { mode: "read", icon: "eye", description: "Читает файлы и отвечает. Ничего не меняет и не запускает" },
  { mode: "ask", icon: "shield", description: "Спросит перед каждой правкой и командой" },
  { mode: "edit", icon: "pencil", description: "Сам правит файлы проекта. Команды — с вашего разрешения" },
  { mode: "full", icon: "bolt", description: "Правит и запускает команды без вопросов, в том числе за пределами проекта" }
] as const;

export function AccessPicker({ value, confirmed, select, warningSignal = 0, settings = false }: {
  value: AccessMode; confirmed?: boolean; select: (mode: AccessMode, confirm?: boolean) => void;
  warningSignal?: number; settings?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [warning, setWarning] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const warningButton = useRef<HTMLButtonElement>(null);
  const lastSignal = useRef(warningSignal);
  const selected = accessOptions.find(option => option.mode === value)!;

  function close(focus = true) {
    setOpen(false);
    setWarning(false);
    if (focus) trigger.current?.focus();
  }

  useEffect(() => {
    if (lastSignal.current !== warningSignal) {
      lastSignal.current = warningSignal;
      setOpen(true);
      setWarning(true);
      setKeyboard(true);
    }
  }, [warningSignal]);
  useEffect(() => {
    if (open && warning && keyboard) warningButton.current?.focus();
  }, [open, warning, keyboard]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!host.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return <div className={"access-picker" + (settings ? " access-picker--settings" : "")} ref={host} onKeyDown={event => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button type="button" ref={trigger} className={"composer-control folder-chip access-chip" + (value === "full" ? " danger-action" : "")}
      aria-expanded={open} aria-label={settings ? "Режим доступа по умолчанию · " + accessLabels[value] : undefined}
      onClick={() => { setKeyboard(false); if (open) close(); else setOpen(true); }}>
      <Icon name={selected.icon} /><span>{accessLabels[value]}</span><Icon name="chevron" className="chevron" />
    </button>
    {open && <div className="model-panel access-menu" aria-label="Режим доступа" role="region">
      {accessOptions.map(({ mode, icon, description }) => <div key={mode}>
        <button type="button" className={"model-option access-option" + (mode === "full" ? " danger-action" : "")}
          data-mode={mode} aria-pressed={mode === value} aria-expanded={mode === "full" && !confirmed ? warning : undefined}
          onClick={event => {
            if (mode === "full" && !confirmed) { setKeyboard(event.detail === 0); setWarning(true); }
            else { select(mode); close(); }
          }}>
          <Icon name={icon} />
          <span className="model-copy"><span className="model-name">{accessLabels[mode]}</span><span className="model-description">{description}</span></span>
          {mode === value && <Icon name="check" className="access-check" />}
        </button>
        {mode === "full" && warning && <div className="access-warning">
          <p>Агент сможет удалять файлы и выполнять любые команды без подтверждения. Включайте только в проекте, которому доверяете, и с сохранённой копией (git)</p>
          <div>
            <button ref={warningButton} className="composer-control access-enable" type="button"
              onClick={() => { select("full", true); close(); }}>Включить</button>
            <button className="composer-control" type="button" onClick={() => {
              setWarning(false); host.current?.querySelector<HTMLButtonElement>(".access-option.danger-action")?.focus();
            }}>Отмена</button>
          </div>
        </div>}
      </div>)}
      <p className="subtle access-shortcut">Shift+Tab — следующий режим</p>
    </div>}
  </div>;
}
