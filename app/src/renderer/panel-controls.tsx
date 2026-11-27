import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FileChange, McpEntry } from "../shared/api";
import type { FileReference } from "../shared/file-links";
import { panelTabs, type PanelTab } from "../shared/panels";
import { folderName } from "../shared/workspace";
import { fileIcon } from "./chat-files";
import { Ring } from "./composer-status";
import { Icon } from "./icons";

const api = window.vsemkod;
export const macShortcuts = /Mac/i.test(navigator.platform);
export type PanelMenuAnchor = "header" | "tabs";

export function PanelMenu({ select, changes, running }: { select: (tab: PanelTab) => void; changes: FileChange[]; running: number }) {
  const additions = changes.reduce((sum, file) => sum + file.additions, 0);
  const deletions = changes.reduce((sum, file) => sum + file.deletions, 0);
  return <div className="model-panel panel-popup panel-picker" role="group" aria-label="Доступные панели">
    {panelTabs.filter(tab => tab.id !== "preview").map(tab => <button type="button" key={tab.id} className="model-option panel-pick"
      data-divider={tab.id === "side" || undefined} onClick={() => select(tab.id)}>
      <Icon name={tab.icon} /><span>{tab.title}</span>
      {tab.id === "changes" && changes.length > 0 && <small className="subtle">+{additions} −{deletions}</small>}
      {tab.id === "tasks" && running > 0 && <small className="subtle">Выполняется: {running}</small>}
      {"key" in tab && <kbd className="subtle">{macShortcuts ? "Cmd" : "Ctrl"}+{tab.shift && "Shift+"}{tab.key}</kbd>}
    </button>)}
  </div>;
}

export function HeaderTools({ leading, summary, panelMenu, showSummary, showPanels, children }: {
  leading?: ReactNode;
  summary: boolean; panelMenu: boolean; showSummary: () => void; showPanels: () => void; children: ReactNode;
}) {
  return <div className="chat-header-tools" data-panel-anchor>
    {leading}
    <button type="button" className="panel-icon-button" aria-label="Сводка" aria-expanded={summary} data-tip="Сводка" onClick={showSummary}><Icon name="summary" /></button>
    <button type="button" className="panel-icon-button" aria-label="Панели" aria-expanded={panelMenu} data-tip="Панели" onClick={showPanels}><Icon name="panel" /></button>
    {children}
  </div>;
}

export function Summary({ directory, percent, changes, running, openContext, openSettings, openPreview, openTasks, onError }: {
  directory: string; percent: number; changes: FileChange[]; running: number; openContext: () => void;
  openSettings: () => void; openPreview: (file: FileReference) => void; openTasks: () => void; onError: (error: unknown) => void;
}) {
  const [branch, setBranch] = useState<string | null>();
  const [servers, setServers] = useState<McpEntry[]>([]);
  const [showServers, setShowServers] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [reconnecting, setReconnecting] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!directory) return;
    void api.projectBranch?.(directory).then(value => { if (alive.current) setBranch(value); }).catch(() => {});
    void api.mcpList(directory).then(value => { if (alive.current) setServers(value); }).catch(() => {});
    return () => { alive.current = false; };
  }, [directory]);

  const files = changes.filter(change => change.status !== "deleted");
  return <div className="model-panel panel-popup session-summary" role="group" aria-label="Сводка сессии">
    <section>
      <h2>Среда</h2>
      <span>Этот компьютер</span>
      {directory && <button type="button" className="summary-project" title={directory} disabled={!api.projectOpen}
        onClick={() => void api.projectOpen?.(directory).catch(onError)}>
        <Icon name="folder" /><span>{folderName(directory)}<small className="subtle">{directory}</small></span>
      </button>}
      {branch !== undefined && <span className="subtle summary-branch">{branch ? <><Icon name="changes" /> {branch}</> : "Не git-репозиторий"}</span>}
      {running > 0 && <button type="button" className="text-link" onClick={openTasks}>Выполняется: {running}</button>}
    </section>
    <section><button type="button" className="summary-line" onClick={openContext}>
      <strong>Контекст ›</strong><span className="subtle summary-percent"><Ring percent={percent} />{percent} %</span>
    </button></section>
    <section>
      <h2>Коннекторы</h2>
      {servers.slice(0, showServers ? undefined : 3).map(server => <div className="summary-line" key={server.name}>
        <span><Icon name="provider" />{server.name}</span>
        {server.status === "connected" ? <small className="subtle">Подключён</small> : server.status === "disabled" ?
          <small className="subtle">Выключен</small> : server.status === "pending" ? <small className="subtle">Подключаем…</small> :
          <button type="button" className="summary-reconnect" title={server.error} disabled={!!reconnecting}
            onClick={() => {
              setReconnecting(server.name);
              void api.mcpChange(directory, server.name, "check").then(list => { if (alive.current) setServers(list); })
                .catch(onError).finally(() => { if (alive.current) setReconnecting(undefined); });
            }}>{reconnecting === server.name ? "Подключаем…" : "Ошибка — Переподключить"}</button>}
      </div>)}
      {servers.length > 3 && !showServers && <button type="button" className="text-link" onClick={() => setShowServers(true)}>Показать ещё</button>}
      <button type="button" className="text-link" onClick={openSettings}>Настроить</button>
    </section>
    <section>
      <h2>Результаты</h2>
      {!files.length && <span className="subtle">Пока ничего</span>}
      {files.slice(0, showFiles ? undefined : 5).map(({ file }) => <button type="button" className="summary-file" key={file}
        title={file} onClick={() => openPreview({ path: file })}><Icon name={fileIcon(file, /\.(?:png|jpe?g|gif|webp|svg)$/i.test(file))} /><span>{folderName(file)}</span></button>)}
      {files.length > 5 && !showFiles && <button type="button" className="text-link" onClick={() => setShowFiles(true)}>Ещё {files.length - 5}</button>}
    </section>
  </div>;
}
