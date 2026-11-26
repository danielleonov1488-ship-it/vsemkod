import { useEffect, useRef, useState } from "react";
import type { UpdateProgress, UpdateReady } from "../shared/api";
import "./panels.css";

/**
 * Обновление в боковой панели, над «Сообществом»: пока качается — кольцо с процентом,
 * когда готово — мятная точка «Обновить до X». Обновление ставится и само, когда агент ничего не делает.
 */
export function UpdateRow({ ready, downloading, busy, apply, applyAfterReply }: {
  ready?: UpdateReady; downloading?: UpdateProgress; busy: boolean;
  apply: () => void; applyAfterReply: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const version = ready?.version ?? downloading?.version;
  useEffect(() => { setConfirm(false); }, [version]);
  useEffect(() => {
    if (!confirm) return;
    const dismiss = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setConfirm(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setConfirm(false); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [confirm]);
  if (!ready && !downloading) return null;

  if (!ready) {
    const percent = downloading!.percent;
    return <div className="sidebar-row update-row" role="status" aria-live="polite"
      title="Обновление скачивается в фоне и установится само, когда агент ничего не делает">
      <svg className={"update-ring" + (percent === undefined ? " update-ring--spin" : "")} viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r="6" />
        <circle className="value" cx="8" cy="8" r="6" strokeDasharray={37.7}
          strokeDashoffset={percent === undefined ? 28 : 37.7 * (1 - Math.min(100, Math.max(0, percent)) / 100)} />
      </svg>
      <span className="update-row-label">Загружается {downloading!.version}</span>
      {percent !== undefined && <span className="update-row-meta">{Math.floor(percent)}%</span>}
    </div>;
  }

  const download = ready.action === "download";
  return <div className="update-row-wrap" ref={wrap}>
    {confirm && <div className="update-confirm" role="dialog" aria-label="Перезапуск во время ответа">
      <span>Агент ещё работает. Перезапустить после ответа?</span>
      <div>
        <button type="button" className="small-button" autoFocus onClick={() => { setConfirm(false); applyAfterReply(); }}>После ответа</button>
        <button type="button" className="composer-control" onClick={() => { setConfirm(false); apply(); }}>Сейчас</button>
      </div>
    </div>}
    <button type="button" className="sidebar-row update-row update-row--ready" aria-expanded={download ? undefined : confirm}
      title={download ? "Откроется страница загрузки новой версии" : "Перезапустить vsemkod и установить " + ready.version}
      onClick={() => { if (!download && busy) setConfirm(value => !value); else apply(); }}>
      <span className="update-dot-slot" aria-hidden="true"><span className="update-dot" /></span>
      <span className="update-row-label">{download ? "Скачать" : "Обновить до"} {ready.version}</span>
    </button>
  </div>;
}
