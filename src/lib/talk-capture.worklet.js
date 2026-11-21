// Convert mono microphone input into complete blocks at the camera's negotiated sample rate.
class TalkCapture extends AudioWorkletProcessor {
  constructor({processorOptions}) {
    super();
    this.ratio = sampleRate / processorOptions.targetRate;
    this.remaining = this.ratio;
    this.sum = 0;
    this.buffer = new Int16Array(processorOptions.chunkSamples);
    this.used = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      let width = 1;
      while (width > 1e-8) {
        const part = Math.min(width,this.remaining);
        this.sum += sample * part;
        this.remaining -= part;
        width -= part;
        if (this.remaining > 1e-8) continue;
        const value = Math.max(-1, Math.min(1,this.sum / this.ratio));
        this.buffer[this.used++] = Math.round(value * (value < 0 ? 32768 : 32767));
        this.sum = 0;
        this.remaining = this.ratio;
        if (this.used === this.buffer.length) {
          const complete = this.buffer;
          this.buffer = new Int16Array(complete.length);
          this.used = 0;
          this.port.postMessage(complete.buffer,[complete.buffer]);
        }
      }
    }
    // Outputs are left silent; the operator never hears a local microphone loop.
    return true;
  }
}
registerProcessor('camera-talk-capture',TalkCapture);
