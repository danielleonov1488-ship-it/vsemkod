class VoiceCapture extends AudioWorkletProcessor {
  buffer = new Int16Array(2048);
  offset = 0;
  square = 0;
  stopped = false;

  constructor() {
    super();
    this.port.onmessage = () => {
      if (this.offset) this.send();
      this.stopped = true;
      this.port.postMessage({ done: true });
    };
  }

  send() {
    const pcm = this.offset === this.buffer.length ? this.buffer : this.buffer.slice(0, this.offset);
    this.port.postMessage({ pcm: pcm.buffer, level: Math.sqrt(this.square / this.offset) }, [pcm.buffer]);
    this.buffer = new Int16Array(2048);
    this.offset = this.square = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    for (const sample of mono) {
      const amplitude = Math.max(-1, Math.min(1, sample));
      this.square += amplitude * amplitude;
      this.buffer[this.offset++] = Math.round(amplitude * 32767);
      if (this.offset === this.buffer.length) this.send();
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCapture);
