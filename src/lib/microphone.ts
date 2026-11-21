import type { TalkFormat } from '../../shared/talk.js';
import workletUrl from './talk-capture.worklet.js?url&no-inline';

export class TalkMicrophone {
  private audio = new AudioContext();
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private closed = false;

  async open(deviceId: string) {
    const input = navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId && { deviceId: { exact: deviceId } }), channelCount: 1, echoCancellation: true, noiseSuppression: true }
    }).then(stream => {
      if (this.closed) stream.getTracks().forEach(track => track.stop());
      else this.stream = stream;
    });
    await Promise.all([input, this.audio.resume(), this.audio.audioWorklet.addModule(workletUrl)]);
    return this.stream?.getAudioTracks()[0]?.label ?? '';
  }

  read(format: TalkFormat, onChunk: (data: ArrayBuffer) => void, onLost: () => void) {
    if (this.closed || !this.stream) return;
    const chunkSamples = format.blockSamples * (format.blockSamples / format.sampleRate <= 0.1 ? 2 : 1);
    this.capture = new AudioWorkletNode(this.audio, 'camera-talk-capture', {
      channelCount: 1, channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1,
      processorOptions: { targetRate: format.sampleRate, chunkSamples }
    });
    this.capture.onprocessorerror = onLost;
    this.capture.port.onmessage = ({ data }) => onChunk(data);
    for (const track of this.stream.getAudioTracks()) {
      if (track.readyState === 'ended') { onLost(); return; }
      track.addEventListener('ended', onLost, { once: true });
    }
    this.source = this.audio.createMediaStreamSource(this.stream);
    this.source.connect(this.capture);
    this.capture.connect(this.audio.destination);
  }

  close() {
    this.closed = true;
    this.capture?.port.close();
    this.capture?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    void this.audio.close().catch(() => {});
  }
}

export function inputDecibels(block: Int16Array) {
  let squares = 0;
  for (const sample of block) squares += (sample / 32768) ** 2;
  return Math.max(-60, Math.round(10 * Math.log10(squares / block.length)));
}

export function microphoneWav(chunks: ArrayBuffer[], sampleRate: number) {
  const bytes = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string) => new Uint8Array(header, offset, value.length).set(new TextEncoder().encode(value));
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}
