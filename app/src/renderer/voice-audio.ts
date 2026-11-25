import { voiceRate } from "../shared/voice";
import workletUrl from "./voice-capture.js?url&no-inline";

export type Capture = { finish(): Promise<void>; close(): void };

export async function captureVoice(device: string, signal: AbortSignal, receive: (pcm: ArrayBuffer, level: number) => void,
  disconnected: () => void): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Микрофон недоступен в этой среде.");
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: device ? { exact: device } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false
  });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let resolveFlush: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    worklet?.port.close();
    worklet?.disconnect();
    source?.disconnect();
    for (const track of media.getTracks()) track.stop();
    if (context) void context.close().catch(() => {});
    resolveFlush?.();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    context = new AudioContext({ sampleRate: voiceRate });
    await context.audioWorklet.addModule(workletUrl);
    signal.throwIfAborted();
    source = context.createMediaStreamSource(media);
    worklet = new AudioWorkletNode(context, "voice-capture", { channelCount: 1, channelCountMode: "explicit" });
    worklet.port.onmessage = ({ data }) => {
      if (data.done) resolveFlush?.();
      else receive(data.pcm, data.level);
    };
    source.connect(worklet);
    worklet.connect(context.destination);
    await context.resume();
    signal.throwIfAborted();
    for (const track of media.getAudioTracks()) track.addEventListener("ended", disconnected, { once: true });
    return {
      async finish() {
        if (closed) return;
        const flushed = new Promise<void>(resolve => { resolveFlush = resolve; });
        worklet?.port.postMessage("flush");
        const timer = setTimeout(() => resolveFlush?.(), 400);
        await flushed;
        clearTimeout(timer);
        close();
      },
      close
    };
  } catch (error) {
    close();
    throw error;
  }
}
