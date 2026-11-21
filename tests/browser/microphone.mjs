// These inputs are created inside Chromium so talkback tests never record a host microphone.
export async function installMicrophones(page) {
  await page.evaluate(() => {
    const devices = navigator.mediaDevices;
    const inputs = ['USB input', 'Headset input'].map((label, index) => ({
      kind: 'audioinput', label, deviceId: 'test-input-' + index
    }));
    const createUrl = URL.createObjectURL.bind(URL);
    window.testCreateUrl = URL.createObjectURL;
    URL.createObjectURL = blob => {
      if (blob.type === 'audio/wav') window.testMicWav = blob;
      return createUrl(blob);
    };
    window.testMicIds = [];
    window.testMicTracks = [];
    Object.defineProperty(devices, 'enumerateDevices', { configurable: true, value: async () => inputs });
    Object.defineProperty(devices, 'getUserMedia', { configurable: true, value: async constraints => {
      const selected = constraints.audio.deviceId?.exact;
      window.testMicIds.push(selected);
      const context = new AudioContext();
      const output = context.createMediaStreamDestination();
      const oscillator = context.createOscillator(), volume = context.createGain();
      oscillator.frequency.value = 440;
      volume.gain.value = selected === 'test-input-1' ? 0.35 : 0;
      oscillator.connect(volume).connect(output);
      oscillator.start();
      await context.resume();
      const track = output.stream.getAudioTracks()[0];
      window.testMicTracks.push(track);
      const stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillator.stop(); void context.close(); };
      return output.stream;
    } });
  });
}

export function toneFrequency(bytes, rate) {
  const periods = [];
  let previousCrossing = -1, squares = 0, previous = 0;
  const count = bytes.length / 2;
  for (let i = 0; i < count; i++) {
    const sample = bytes.readInt16LE(i * 2);
    if (previous < 0 && sample >= 0) {
      if (previousCrossing >= 0) periods.push(i - previousCrossing);
      previousCrossing = i;
    }
    squares += sample * sample;
    previous = sample;
  }
  if (periods.length < 8 || Math.sqrt(squares / count) < 1000) return 0;
  // Independent Web Audio contexts can insert silent quanta as the input starts.
  // Use consistent complete cycles to measure the pitch of the audible signal.
  periods.sort((a, b) => a - b);
  const median = periods[Math.floor(periods.length / 2)];
  const stable = periods.filter(period => Math.abs(period - median) <= 1);
  return stable.length >= periods.length * 0.75 ? rate * stable.length / stable.reduce((sum, period) => sum + period, 0) : 0;
}
