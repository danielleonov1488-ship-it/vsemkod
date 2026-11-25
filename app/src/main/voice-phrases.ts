import { voiceHop, voiceRate, type VoiceSilence } from "../shared/voice";

const speechStart = 3;
const speechMinimum = 5;
const padding = 8;
const pause = 18;
const phraseLimit = Math.floor(18 * voiceRate / voiceHop);

function joinFrames(frames: Int16Array[]): Int16Array<ArrayBuffer> {
  const pcm = new Int16Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.length;
  }
  return pcm;
}

export class VoicePhrases {
  private recent: Int16Array[] = [];
  private phrase: Int16Array[] = [];
  private streak = 0;
  private speech = 0;
  private quiet = 0;
  private silentSamples = 0;
  private active = false;

  constructor(private readonly silence: VoiceSilence, private readonly final: (pcm: Int16Array<ArrayBuffer>) => void) {}

  // One probability per Silero hop. The last hop can be shorter at stop.
  push(frame: Int16Array, probability: number) {
    const voiced = probability >= (this.active ? 0.35 : 0.50);
    this.silentSamples = voiced ? 0 : this.silentSamples + frame.length;
    if (!this.active) {
      this.recent.push(frame);
      if (this.recent.length > padding + speechStart) this.recent.shift();
      this.streak = voiced ? this.streak + 1 : 0;
      if (this.streak === speechStart) {
        this.phrase = this.recent;
        this.recent = [];
        this.active = true;
        this.speech = speechStart;
      }
    } else {
      this.phrase.push(frame);
      this.quiet = voiced ? 0 : this.quiet + 1;
      if (voiced) this.speech++;
      if (this.quiet >= pause || this.phrase.length >= phraseLimit) {
        const continuing = this.quiet < pause;
        this.finish();
        this.active = continuing;
      }
    }
    return this.silence > 0 && this.silentSamples >= this.silence * voiceRate;
  }

  preview(minSamples: number) {
    if (this.speech < speechMinimum || this.phrase.length * voiceHop < minSamples) return;
    return joinFrames(this.phrase);
  }

  finish() {
    if (this.speech >= speechMinimum) {
      this.final(joinFrames(this.phrase.slice(0, this.phrase.length - Math.max(0, this.quiet - padding))));
    }
    this.phrase = [];
    this.recent = [];
    this.streak = this.quiet = this.speech = 0;
    this.active = false;
  }
}
