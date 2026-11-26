import { useEffect, useRef, useState } from "react";
import type { BackgroundTask } from "../shared/api";
import { findLocalUrls } from "../shared/browser";
import { Icon } from "./icons";

export function BackgroundTasks({ tasks, openBrowser, onError }: {
  tasks: BackgroundTask[]; openBrowser: (url: string) => void; onError: (error: unknown) => void;
}) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!tasks.length) return <p className="subtle panel-empty">Фоновых задач пока нет.</p>;
  return <ul className="task-list">{tasks.map(task => <Task key={task.id} task={task} clock={clock} openBrowser={openBrowser} onError={onError} />)}</ul>;
}

function Task({ task, clock, openBrowser, onError }: {
  task: BackgroundTask; clock: number; openBrowser: (url: string) => void; onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [open, task.output]);
  const url = findLocalUrls(task.output)[0];
  const seconds = Math.max(0, Math.floor(((task.ended ?? clock) - task.started) / 1000));
  const time = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  return <li className="task-card">
    <button type="button" className="task-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="terminal" /><span title={task.command}>{task.command.length > 60 ? task.command.slice(0, 59) + "…" : task.command}</span><Icon name="chevron" />
    </button>
    <span className="subtle task-directory" title={task.directory}>{task.directory}</span>
    <div className="task-status"><span className="subtle">{time}</span>
      <span data-task-status={task.ended === undefined ? "running" : task.exitCode ? "error" : "finished"}>
        {task.ended === undefined ? "Работает" : task.exitCode === undefined ? "Остановлен" :
          (task.exitCode === 0 ? "Завершён" : "Упал") + " · код " + task.exitCode}</span></div>
    {open && <pre ref={output} className="diff task-output">{task.output || "Вывода пока нет."}</pre>}
    <div className="task-actions">
      {task.ended === undefined && <button type="button" className="composer-control" disabled={stopping} onClick={() => {
        if (!confirm) { setConfirm(true); timer.current = setTimeout(() => setConfirm(false), 3000); return; }
        clearTimeout(timer.current);
        setConfirm(false);
        setStopping(true);
        void window.vsemkod.stopTask?.(task.id).catch(onError).finally(() => setStopping(false));
      }}>{confirm ? "Точно остановить?" : "Остановить"}</button>}
      {url && <button type="button" className="composer-control" onClick={() => openBrowser(url)}>Открыть в браузере</button>}
    </div>
  </li>;
}
