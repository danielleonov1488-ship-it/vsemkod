import { useEffect, useRef, useState, type RefObject } from "react";
import type { Preferences } from "../shared/api";
import { insertVoiceDraft, updateVoiceDraft, voiceDefaults, type VoiceDraft, type VoiceModel } from "../shared/voice";
import { Icon } from "./icons";
import { captureVoice, type Capture } from "./voice-audio";
import { DownloadProgress, SlowVoiceModel, useVoiceModels, voiceApi, VoiceConsent } from "./voice-model-ui";

type Phase = "idle" | "starting" | "recording" | "stopping";
type Recording = { id: string; controller: AbortController; text: VoiceDraft; capture?: Capture; stopRequested?: boolean };
type Props = { draft: string; change: (text: string) => void; input: RefObject<HTMLTextAreaElement | null>;
  preferences?: Preferences; update: (patch: Partial<Preferences>) => void; onError: (error: unknown) => void };

export function useVoiceComposer(props: Props) {
  const current = useRef(props);
  current.current = props;
  const phase = useRef<Phase>("idle");
  const [view, setView] = useState<Phase>("idle");
  const [consent, setConsent] = useState<{ model: VoiceModel; vadOnly: boolean }>();
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const [partial, setPartial] = useState("");
  const [started, setStarted] = useState<number>();
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [webHint, setWebHint] = useState(false);
  const recording = useRef<Recording>(undefined);
  const { status, refresh, download } = useVoiceModels(voiceApi, props.onError);
  const settings = { ...voiceDefaults, ...props.preferences };

  function show(next: Phase) {
    phase.current = next;
    setView(next);
  }

  function restoreCursor(position: number, end = position) {
    const input = current.current.input.current;
    requestAnimationFrame(() => {
      if (input && current.current.input.current === input && input.isConnected) {
        input.focus();
        input.setSelectionRange(position, end);
      }
    });
  }

  function clear(job: Recording, revert = false, focus = true) {
    if (recording.current !== job) return;
    recording.current = undefined;
    job.controller.abort();
    if (revert) current.current.change(job.text.text);
    setPartial("");
    setStarted(undefined);
    setLevel(0);
    show("idle");
    if (focus) {
      if (revert || !job.text.spoken) restoreCursor(job.text.start, job.text.end);
      else restoreCursor(insertVoiceDraft(job.text).cursor);
    }
  }

  function cancel(job: Recording) {
    clear(job, true);
    void voiceApi?.cancel(job.id).catch(() => {});
  }

  function fail(job: Recording, error: unknown) {
    if (recording.current !== job) return;
    clear(job);
    void voiceApi?.cancel(job.id).catch(() => {});
    current.current.onError(error);
  }

  async function stop() {
    const job = recording.current;
    if (!job || !voiceApi || job.stopRequested) return;
    job.stopRequested = true;
    if (!job.capture) {
      // Permission or engine initialization may still be pending.
      clear(job);
      void voiceApi.cancel(job.id).catch(() => {});
      return;
    }
    show("stopping");
    try {
      await job.capture.finish();
      if (recording.current === job) await voiceApi.stop(job.id);
    } catch (error) { fail(job, error); }
  }

  async function begin() {
    if (!voiceApi) { setWebHint(true); return; }
    const api = voiceApi;
    if (recording.current || consentRef.current) return;
    const { input, draft, preferences } = current.current;
    const voice = { ...voiceDefaults, ...preferences };
    const start = input.current?.selectionStart ?? draft.length;
    const end = input.current?.selectionEnd ?? start;
    const job: Recording = { id: crypto.randomUUID(), controller: new AbortController(),
      text: { text: draft, start, end, spoken: "", lastFinal: 0 } };
    recording.current = job;
    show("starting");
    try {
      const state = await refresh();
      if (recording.current !== job || !state) return;
      if (state.download) { clear(job, false, false); return; }
      const cloud = voice.voiceGroq && state.groq;
      if (!state.vadInstalled || (!cloud && !state.models[voice.voiceModel].installed)) {
        clear(job, false, false);
        setConsent({ model: voice.voiceModel, vadOnly: cloud });
        return;
      }
      await voiceApi.start(job.id);
      if (recording.current !== job) return;
      job.capture = await captureVoice(voice.voiceDevice, job.controller.signal, (pcm, level) => {
        if (recording.current !== job) return;
        setLevel(level);
        void api.audio(job.id, pcm).catch(error => fail(job, error));
      }, () => void stop());
      if (recording.current !== job) return;
      setSeconds(0);
      setStarted(performance.now());
      show("recording");
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        fail(job, new Error("Разрешите доступ к микрофону в системных настройках."));
      } else if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "OverconstrainedError")) {
        fail(job, new Error("Микрофон недоступен. Выберите другое устройство в настройках."));
      } else fail(job, error);
    }
  }

  function toggle() {
    if (phase.current === "idle") void begin();
    else if (phase.current !== "stopping") void stop();
  }

  useEffect(() => {
    if (started === undefined || view !== "recording") return;
    const timer = setInterval(() => setSeconds(Math.floor((performance.now() - started) / 1000)), 200);
    return () => clearInterval(timer);
  }, [started, view]);

  // Hotkeys and IPC read the current session through refs.
  useEffect(() => {
    if (!voiceApi) return;
    const api = voiceApi;
    const unsubscribe = api.subscribe(event => {
      const job = recording.current;
      if (!job || !("id" in event) || event.id !== job.id) return;
      if (event.type === "partial" || event.type === "final") {
        job.text = updateVoiceDraft(job.text, event.type, event.phrase, event.text);
        setPartial(job.text.partial?.text ?? "");
        if (event.type === "final") {
          const result = insertVoiceDraft(job.text);
          current.current.change(result.text);
          const field = current.current.input.current;
          if (field) requestAnimationFrame(() => {
            if (recording.current === job) field.setSelectionRange(result.cursor, result.cursor);
          });
        }
      }
      if (event.type === "silence") void stop();
      if (event.type === "done") clear(job);
      if (event.type === "error") fail(job, new Error(event.message));
    });
    let gesture: { timer?: ReturnType<typeof setTimeout>; held: boolean; started: boolean } | undefined;
    const finishGesture = (toggleOnTap: boolean) => {
      if (!gesture) return;
      clearTimeout(gesture.timer);
      if (gesture.started) void stop();
      if (!gesture.held && toggleOnTap) toggle();
      gesture = undefined;
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape" && (recording.current || consentRef.current)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (recording.current) void stop();
        else setConsent(undefined);
        return;
      }
      if (event.code !== "Space" || !event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      if (event.repeat || gesture) return;
      gesture = { held: false, started: false };
      gesture.timer = setTimeout(() => {
        if (!gesture) return;
        gesture.held = true;
        if (phase.current === "idle" && !consentRef.current) {
          gesture.started = true;
          void begin();
        }
      }, 250);
    };
    const keyup = (event: KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== "Control") || !gesture) return;
      event.preventDefault();
      finishGesture(true);
    };
    const blur = () => finishGesture(false);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", blur);
    return () => {
      unsubscribe();
      clearTimeout(gesture?.timer);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", blur);
      const job = recording.current;
      if (job) {
        recording.current = undefined;
        job.controller.abort();
        void api.cancel(job.id).catch(() => {});
      }
    };
  }, [refresh]);

  const controls = <>
    {webHint && <div className="voice-consent" role="status">Голосовой ввод работает в приложении.</div>}
    {consent && status && !status.download && <VoiceConsent {...consent} status={status} close={() => {
      setConsent(undefined);
      current.current.input.current?.focus();
    }} confirm={model => {
      setConsent(undefined);
      if (model !== settings.voiceModel) props.update({ voiceModel: model });
      void download(model, consent.vadOnly);
    }} />}
    {status?.download && <DownloadProgress progress={status.download} pause={() => void voiceApi?.pause().catch(props.onError)} />}
    {status?.rtf !== undefined && status.rtf > 0.8 && settings.voiceModel === "accurate" && !settings.voiceGroq &&
      view === "idle" && !status.download && !consent && <SlowVoiceModel rtf={status.rtf} onSwitch={() => {
        props.update({ voiceModel: "fast" });
        if (!status.models.fast.installed) setConsent({ model: "fast", vadOnly: false });
      }} />}
    {partial && <div className="voice-partial" aria-label="Промежуточный текст">{partial}</div>}
    {view !== "idle" && <div className="voice-recording" role="group" aria-label="Голосовая запись">
      {view === "recording" ? <>
        <span className="voice-wave" aria-hidden="true">
          {[.45, .7, .92, 1, .78, .56, .36].map((factor, index) =>
            <i key={index} style={{ height: Math.max(3, Math.min(22, level * 130 * factor)) }} />)}
        </span>
        <time aria-label="Длительность">{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</time>
      </> : <span className="subtle" role="status">{view === "starting" ? "Подготовка микрофона…" : "Распознаём последние фразы…"}</span>}
      {view === "recording" && <button type="button" className="composer-control voice-stop" onClick={() => void stop()}><Icon name="stop" />Стоп</button>}
      <button type="button" className="composer-control" onClick={() => { if (recording.current) cancel(recording.current); }}>Отмена</button>
    </div>}
  </>;

  const button = <button type="button" className="composer-control attach voice-mic" title="Голосовой ввод · Ctrl+Space"
    aria-label="Голосовой ввод" aria-pressed={view !== "idle"} disabled={view === "stopping" || !!status?.download}
    onMouseDown={event => event.preventDefault()} onClick={toggle}><Icon name="mic" /></button>;
  return { controls, button, busy: view !== "idle" };
}
