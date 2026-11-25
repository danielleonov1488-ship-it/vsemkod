import { useCallback, useEffect, useState } from "react";
import { vadBytes, voiceLabels, voiceModelBytes, type VoiceApi, type VoiceModel, type VoiceProgress, type VoiceStatus } from "../shared/voice";

export const voiceApi = window.vsemkod.voice;
export const megabytes = (bytes: number) => Math.round(bytes / 1_000_000).toLocaleString("ru") + " МБ";

export function useVoiceModels(api: VoiceApi | undefined, onError: (error: unknown) => void) {
  const [status, setStatus] = useState<VoiceStatus>();
  const refresh = useCallback(async () => {
    const next = await api?.status();
    if (next) setStatus(next);
    return next;
  }, [api]);
  useEffect(() => {
    void refresh().catch(() => {});
    return api?.subscribe(event => {
      if (event.type === "status") setStatus(event.status);
      if (event.type === "progress") setStatus(current => current && { ...current, download: event.progress });
    });
  }, [api, refresh]);
  async function download(model: VoiceModel, vadOnly = false) {
    if (!api) return;
    try {
      // Surface the initial state before the first progress event.
      setStatus(current => current && { ...current, download: { model, received: 0, total: (vadOnly ? 0 : voiceModelBytes[model]) + vadBytes, phase: "download" } });
      setStatus(await api.download(model, true, vadOnly));
    } catch (error) {
      onError(error);
      await refresh().catch(() => {});
    }
  }
  return { status, refresh, download, setStatus };
}

export function DownloadProgress({ progress, pause }: { progress: VoiceProgress; pause: () => void }) {
  const { model, received, total, phase } = progress;
  return <div className="voice-progress">
    <div className="voice-progress-copy" role="status">
      {phase === "benchmark" ? "Измеряем скорость Точной модели…" : phase === "verify" ? "Проверяем контрольную сумму…" :
        "Загружаем · " + megabytes(received) + " из " + megabytes(total)}
    </div>
    <progress value={received} max={total} aria-label={"Загрузка · " + voiceLabels[model]} />
    <button type="button" className="composer-control" onClick={pause}>{phase === "benchmark" ? "Пропустить" : "Приостановить"}</button>
  </div>;
}

export function VoiceConsent({ model, status, vadOnly, close, confirm }: { model: VoiceModel; status: VoiceStatus; vadOnly: boolean;
  close: () => void; confirm: (model: VoiceModel) => void }) {
  const recommendation = !vadOnly && model === "accurate" && !status.models.accurate.installed ? status.recommendFast : null;
  const total = (vadOnly ? 0 : voiceModelBytes[model]) + (status.vadInstalled ? 0 : vadBytes);
  return <div className="voice-consent" role="group" aria-label="Согласие на загрузку">
    <strong>{vadOnly ? "Загрузить Silero VAD?" : "Загрузить модель «" + voiceLabels[model] + "»?"}</strong>
    <span>{vadOnly ? "Детектор речи для разделения фраз" : "После загрузки модель работает без интернета"} · {total ? Math.ceil(total / 1_000_000) + " МБ" : "файлы уже на диске"}</span>
    {recommendation && <span>{recommendation === "memory" ? "На компьютере меньше 8 ГБ оперативной памяти." :
      "У процессора мало потоков и нет обнаруженного ускорения."} Рекомендуем Быструю.</span>}
    <div className="voice-actions">
      {recommendation && <button type="button" className="small-button" onClick={() => confirm("fast")}>
        Загрузить Быструю · {megabytes(voiceModelBytes.fast + (status.vadInstalled ? 0 : vadBytes))}
      </button>}
      <button type="button" className={recommendation ? "composer-control" : "small-button"} onClick={() => confirm(model)}>
        {recommendation ? "Загрузить Точную" : "Загрузить"}
      </button>
      <button type="button" className="composer-control" onClick={close}>Отмена</button>
    </div>
  </div>;
}

export function SlowVoiceModel({ rtf, onSwitch }: { rtf: number; onSwitch: () => void }) {
  return <div className="voice-consent">
    <span>Точная модель на этом компьютере работает медленно. Переключиться на Быструю?</span>
    <button type="button" className="small-button" title={"RTF " + rtf.toFixed(2)} onClick={onSwitch}>Переключиться на Быструю</button>
  </div>;
}
