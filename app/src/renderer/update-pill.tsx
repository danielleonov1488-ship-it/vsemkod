import { useEffect, useState } from "react";
import type { UpdateProgress, UpdateReady } from "../shared/api";
import { Icon } from "./icons";
import "./panels.css";


/**
 * Постоянный индикатор обновления в правом нижнем углу.
 * «×» сворачивает его в кружок с мятной точкой; после перезапуска приложения плашка снова полная.
 */
export function UpdatePill({ ready, downloading, busy, apply, applyAfterReply }: {
  ready?: UpdateReady; downloading?: UpdateProgress; busy: boolean;
  apply: () => void; applyAfterReply: () => void;
}) {
  const [folded, setFolded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const version = ready?.version ?? downloading?.version;
  useEffect(() => { setConfirm(false); }, [version]);
  if (!ready && !downloading) return null;

  const restart = () => {
    if (ready?.action === "restart" && busy) { setConfirm(value => !value); return; }
    apply();
  };
  const label = ready ? ready.action === "download" ? "Вышла версия " + ready.version : "Обновление " + ready.version + " готово"
    : "Загружается обновление " + downloading!.version + "…";

  if (folded) return <button type="button" className="update-pill update-pill--folded"
    title={ready ? label + (ready.action === "download" ? " — нажмите, чтобы открыть" : " — нажмите, чтобы перезапустить") : label}
    aria-label={label} onClick={() => setFolded(false)}>
    <span className="update-dot" aria-hidden="true" />
  </button>;

  const percent = downloading?.percent;
  return <>
    {confirm && <div className="update-confirm" role="dialog" aria-label="Перезапуск во время ответа">
      <span>Агент ещё работает. Перезапустить после ответа?</span>
      <div>
        <button type="button" className="small-button" onClick={() => { setConfirm(false); applyAfterReply(); }}>После ответа</button>
        <button type="button" className="composer-control" onClick={() => { setConfirm(false); apply(); }}>Сейчас</button>
      </div>
    </div>}
    <div className="update-pill" role="status" aria-live="polite">
      {ready ? <span className="update-dot" aria-hidden="true" />
        : <svg className={"update-ring" + (percent === undefined ? " update-ring--spin" : "")} viewBox="0 0 16 16" aria-hidden="true">
          <circle className="track" cx="8" cy="8" r="6" />
          <circle className="value" cx="8" cy="8" r="6" strokeDasharray={37.7}
            strokeDashoffset={percent === undefined ? 28 : 37.7 * (1 - Math.min(100, Math.max(0, percent)) / 100)} />
        </svg>}
      <span>{label}</span>
      {ready && <button type="button" className="small-button" onClick={restart}>{ready.action === "download" ? "Скачать" : "Перезапустить"}</button>}
      <button type="button" className="update-close" aria-label="Свернуть" title="Свернуть" onClick={() => { setConfirm(false); setFolded(true); }}><Icon name="close" /></button>
    </div>
  </>;
}
