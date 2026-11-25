import { useEffect, useState } from "react";
import type { Preferences } from "../shared/api";
import { voiceDefaults, voiceLabels, voiceLanguages, voiceModelBytes, voiceModels, type VoiceModel, type VoiceSilence } from "../shared/voice";
import { PreferenceSwitch } from "./connections";
import { DownloadProgress, megabytes, SlowVoiceModel, useVoiceModels, voiceApi, VoiceConsent } from "./voice-model-ui";

const languageNames = new Intl.DisplayNames("ru", { type: "language" });
const languages = voiceLanguages.map(code => [code, languageNames.of(code === "jw" ? "jv" : code) ?? code] as const)
  .sort((a, b) => a[1].localeCompare(b[1], "ru"));

export function VoiceSettings({ prefs, update, onError, connected }: { prefs: Preferences;
  update: (patch: Partial<Preferences>) => void; onError: (error: unknown) => void; connected: boolean }) {
  const { status, download, setStatus } = useVoiceModels(voiceApi, onError);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [consent, setConsent] = useState<VoiceModel>();
  const [deleting, setDeleting] = useState(false);
  const voice = { ...voiceDefaults, ...prefs };
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let active = true;
    const refresh = () => void media.enumerateDevices().then(items => {
      if (active) setDevices(items.filter(item => item.kind === "audioinput" && item.deviceId && item.deviceId !== "default"));
    }).catch(() => {});
    refresh();
    media.addEventListener("devicechange", refresh);
    return () => { active = false; media.removeEventListener("devicechange", refresh); };
  }, []);

  if (!voiceApi) return <p className="subtle settings-detail">Голосовой ввод работает в приложении.</p>;
  const api = voiceApi;
  const groqAvailable = status?.groq ?? connected;
  return <section className="settings-group">
    <h2>Распознавание</h2>
    <label className="settings-row"><span>Модель по умолчанию</span>
      <select className="field-control" value={voice.voiceModel} onChange={event => update({ voiceModel: event.target.value as VoiceModel })}>
        {voiceModels.map(model => <option key={model} value={model}>{voiceLabels[model]}</option>)}
      </select>
    </label>
    {voiceModels.map(model => {
      const file = status?.models[model];
      return <div className="settings-row" key={model}>
        <span>{voiceLabels[model]} <small className="subtle">{file?.installed ? megabytes(file.installed) + " на диске" :
          file?.partial ? megabytes(file.partial) + " загружено из " + megabytes(voiceModelBytes[model]) : megabytes(voiceModelBytes[model])}</small></span>
        <div className="voice-actions">
          {!file?.installed && <button type="button" className="composer-control" disabled={!status || !!status.download || deleting}
            aria-label={(file?.partial ? "Продолжить загрузку модели «" : "Загрузить модель «") + voiceLabels[model] + "»"}
            onClick={() => setConsent(model)}>{file?.partial ? "Продолжить" : "Загрузить"}</button>}
          {!!(file?.installed || file?.partial) && <button type="button" className="composer-control danger-action" disabled={!!status?.download || deleting}
            aria-label={"Удалить модель «" + voiceLabels[model] + "»"} onClick={() => {
              setDeleting(true);
              void api.remove(model).then(setStatus).catch(onError).finally(() => setDeleting(false));
            }}>Удалить</button>}
        </div>
      </div>;
    })}
    {consent && status && !status.download && <VoiceConsent model={consent} status={status} vadOnly={false}
      close={() => setConsent(undefined)} confirm={model => {
        if (model !== consent && voice.voiceModel === consent) update({ voiceModel: model });
        setConsent(undefined);
        void download(model);
      }} />}
    {status?.download && <DownloadProgress progress={status.download} pause={() => void api.pause().catch(onError)} />}
    {status?.rtf !== undefined && status.rtf > 0.8 && voice.voiceModel === "accurate" &&
      <SlowVoiceModel rtf={status.rtf} onSwitch={() => update({ voiceModel: "fast" })} />}
    <label className="settings-row"><span>Язык</span>
      <select className="field-control" value={voice.voiceLanguage} onChange={event => update({ voiceLanguage: event.target.value })}>
        <option value="auto">Авто</option>
        {languages.map(([code, text]) => <option key={code} value={code}>{text}</option>)}
      </select>
    </label>
    <label className="settings-row"><span>Автостоп по тишине</span>
      <select className="field-control" value={voice.voiceSilence} onChange={event => update({ voiceSilence: Number(event.target.value) as VoiceSilence })}>
        <option value="0">Выкл</option><option value="10">10 с</option><option value="30">30 с</option>
      </select>
    </label>
    <label className="settings-row"><span>Микрофон</span>
      <select className="field-control" value={voice.voiceDevice} onChange={event => update({ voiceDevice: event.target.value })}>
        <option value="">Системный по умолчанию</option>
        {voice.voiceDevice && !devices.some(device => device.deviceId === voice.voiceDevice) &&
          <option value={voice.voiceDevice}>Выбранный микрофон недоступен</option>}
        {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || "Микрофон " + (index + 1)}</option>)}
      </select>
    </label>
    {!devices.length && <p className="subtle settings-detail">Другие устройства появятся после первого разрешения на доступ к микрофону.</p>}
    {groqAvailable && <PreferenceSwitch title="Облачное распознавание через мой ключ Groq"
      detail="Фразы отправляются в Groq и распознаются моделью whisper-large-v3-turbo."
      value={voice.voiceGroq} toggle={voiceGroq => update({ voiceGroq })} />}
  </section>;
}
