<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, operationId, t } from './api.js';
  import type { TalkCapability, TalkFormat } from '../../shared/talk.js';
  import { inputDecibels, microphoneWav, TalkMicrophone } from './microphone.js';

  let { base, csrf }: { base: string; csrf: string } = $props();
  const panelId = $props.id();
  const preference = 'reolink-wui-talk-microphone';
  const testSeconds = 5;
  let format = $state<TalkFormat>();
  let lookupError = $state(''), notice = $state(''), settingsOpen = $state(false);
  let phase = $state<'idle' | 'startingTalk' | 'talking' | 'startingTest' | 'testing'>('idle');
  let inputs = $state<MediaDeviceInfo[]>([]), selected = $state(''), activeLabel = $state('');
  let listError = $state(''), db = $state(-60), sampleUrl = $state('');
  let testing = $derived(phase === 'startingTest' || phase === 'testing');
  let lookup: AbortController | undefined;
  let enumeration = 0, mounted = false;
  type Call = {
    kind: 'talk'; mic: TalkMicrophone; path: string; csrf: string;
    requested: boolean; pending: ArrayBuffer[]; sending: boolean; sequence: number; abort: AbortController
  };
  type MicTest = {
    kind: 'test'; mic: TalkMicrophone; rate: number; chunks: ArrayBuffer[]; samples: number; peak: number; timer?: ReturnType<typeof setTimeout>
  };
  let session: Call | MicTest | undefined;
  let pointer: number | undefined, key: string | undefined;

  async function check() {
    lookup?.abort();
    const request = new AbortController();
    lookup = request; lookupError = '';
    try {
      const result = await api<TalkCapability>({ path: base + '/talk', signal: request.signal });
      if (!request.signal.aborted) format = result.available ? result : undefined;
    } catch (e) { if (!request.signal.aborted) lookupError = errorText(e); }
  }

  async function listInputs() {
    const version = ++enumeration;
    if (!navigator.mediaDevices?.enumerateDevices) { listError = t('talk-unavailable-browser'); return; }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (version !== enumeration || !mounted) return;
      inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default');
      listError = '';
    } catch { if (version === enumeration && mounted) listError = t('talk-list-failed'); }
  }

  function discardSample() {
    if (sampleUrl) URL.revokeObjectURL(sampleUrl);
    sampleUrl = '';
  }

  function selectInput(id: string) {
    if (session?.kind === 'test') release();
    selected = id; activeLabel = ''; notice = ''; db = -60;
    discardSample();
    try { if (id) localStorage.setItem(preference, id); else localStorage.removeItem(preference); } catch {}
  }

  function toggleSettings() {
    settingsOpen = !settingsOpen;
    if (settingsOpen) void listInputs();
    else {
      if (session?.kind === 'test') release();
      discardSample();
      db = -60;
    }
  }

  function relinquish(call: Call) {
    return api({ path: call.path, csrf: call.csrf, method: 'DELETE', keepalive: true }).catch(e => {
      if (!session && mounted) notice = errorText(e);
    });
  }

  function release(keepSample = false) {
    const previous = session;
    session = undefined; pointer = undefined; key = undefined; phase = 'idle';
    if (!previous) return;
    previous.mic.close();
    if (previous.kind === 'test') {
      clearTimeout(previous.timer);
      db = keepSample ? previous.peak : -60;
      if (keepSample) {
        if (previous.samples) sampleUrl = URL.createObjectURL(microphoneWav(previous.chunks, previous.rate));
        else notice = t('talk-no-samples');
      }
    } else {
      previous.abort.abort();
      previous.pending.length = 0;
      if (previous.requested) void relinquish(previous);
    }
  }

  async function flush(call: Call) {
    if (call.sending) return;
    call.sending = true;
    try {
      while (session === call && call.pending.length) {
        const pcm = new Uint8Array(call.pending.shift()!);
        await api({ path: call.path, csrf: call.csrf, method: 'PUT',
          body: { sequence: call.sequence++, pcm: btoa(String.fromCharCode(...pcm)) },
          signal: AbortSignal.any([call.abort.signal, AbortSignal.timeout(4000)]) });
      }
    } catch (e) { if (session === call) { release(); notice = errorText(e); } }
    finally { call.sending = false; }
  }

  function collect(test: MicTest, data: ArrayBuffer) {
    const available = Math.min(data.byteLength / 2, test.rate * testSeconds - test.samples);
    db = inputDecibels(new Int16Array(data, 0, available));
    test.peak = Math.max(test.peak, db);
    test.chunks.push(available * 2 === data.byteLength ? data : data.slice(0, available * 2));
    test.samples += available;
    if (test.samples >= test.rate * testSeconds) release(true);
  }

  function microphoneError(e: unknown) {
    if (!(e instanceof DOMException)) return errorText(e);
    if (e.name === 'NotAllowedError') return t('talk-microphone-denied');
    if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return t('talk-input-missing');
    return t('talk-microphone-failed');
  }

  async function begin(kind: 'talk' | 'test') {
    if (session || !format) return;
    notice = ''; discardSample();
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
      notice = t('talk-unavailable-browser'); return;
    }
    let mic: TalkMicrophone;
    try { mic = new TalkMicrophone(); } catch { notice = t('talk-microphone-failed'); return; }
    const current: Call | MicTest = kind === 'test'
      ? { kind, mic, rate: format.sampleRate, chunks: [], samples: 0, peak: -60 }
      : { kind, mic, path: base + '/talk/' + operationId(), csrf, requested: false, pending: [], sending: false, sequence: 0, abort: new AbortController() };
    session = current;
    phase = kind === 'test' ? 'startingTest' : 'startingTalk';
    try {
      const label = await mic.open(selected);
      if (session !== current) return;
      activeLabel = label;
      if (settingsOpen) void listInputs();
      const lost = () => { if (session === current) { release(); notice = t('talk-microphone-failed'); } };
      if (current.kind === 'test') {
        phase = 'testing';
        current.timer = setTimeout(() => { if (session === current) release(true); }, (testSeconds + 1) * 1000);
        mic.read(format, data => { if (session === current) collect(current, data); }, lost);
      } else {
        current.requested = true;
        const accepted = await api<TalkFormat>({ path: current.path, csrf, method: 'POST', signal: AbortSignal.timeout(18_000) });
        // Release again if the start arrived after the operator let go.
        if (session !== current) { await relinquish(current); return; }
        phase = 'talking';
        mic.read(accepted, data => {
          if (session !== current) return;
          if (current.pending.length >= 3) { release(); notice = t('error-TALK_BUSY'); return; }
          current.pending.push(data); void flush(current);
        }, lost);
      }
    } catch (e) {
      if (session === current) { release(); notice = microphoneError(e); }
    }
  }

  onMount(() => {
    mounted = true;
    try { selected = localStorage.getItem(preference) || ''; } catch {}
    const devicesChanged = () => { if (settingsOpen) void listInputs(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', devicesChanged);
    void check();
    return () => {
      mounted = false; enumeration++; lookup?.abort();
      navigator.mediaDevices?.removeEventListener?.('devicechange', devicesChanged);
      release(); discardSample();
    };
  });
</script>

<svelte:window onblur={() => { if (session?.kind === 'talk') release(); }} onpagehide={() => release()} />
<svelte:document onvisibilitychange={() => { if (document.hidden) release(); }} />
{#if format}
  <div class="talk-controls">
    <button class="icon-button" type="button" aria-label={t('talk-settings')} title={t('talk-settings')}
      aria-expanded={settingsOpen} aria-controls={panelId} onclick={toggleSettings}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>
      </svg>
    </button>
    <button type="button" class="hold" class:active={phase === 'talking'} aria-pressed={phase === 'talking'} disabled={testing}
      onpointerdown={e => {
        if (!e.isPrimary || e.button !== 0 || key || pointer !== undefined) return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointer = e.pointerId; void begin('talk');
      }}
      onpointerup={e => { if (e.pointerId === pointer) release(); }} onpointercancel={e => { if (e.pointerId === pointer) release(); }}
      onlostpointercapture={e => { if (e.pointerId === pointer) release(); }}
      onkeydown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat && !key && pointer === undefined) { key = e.key; void begin('talk'); } } }}
      onkeyup={e => { if (key === e.key) { e.preventDefault(); release(); } }} onblur={() => { if (key) release(); }}
      oncontextmenu={e => e.preventDefault()}>{t('talk-hold')}</button>
    <span class="talk-feedback" role="status">{phase === 'talking' ? t('talk-live') : phase === 'startingTalk' || phase === 'startingTest' ? t('talk-request') : notice}</span>
  </div>
  {#if settingsOpen}
    <div id={panelId} class="talk-panel">
      <div class="talk-input-row">
        <label for={panelId + '-input'}>{t('talk-input')}</label>
        <select id={panelId + '-input'} value={selected} disabled={phase === 'talking' || phase === 'startingTalk'} onchange={e => selectInput(e.currentTarget.value)}>
          <option value="">{t('talk-input-default')}</option>
          {#if selected && !inputs.some(device => device.deviceId === selected)}<option value={selected}>{t('talk-saved-input')}</option>{/if}
          {#each inputs as device, index (device.deviceId)}
            <option value={device.deviceId}>{device.label || t('talk-input-number', { number: index + 1 })}</option>
          {/each}
        </select>
        <button type="button" disabled={phase === 'talking' || phase === 'startingTalk'}
          onclick={() => { if (testing) release(true); else void begin('test'); }}>{t(testing ? 'talk-stop-test' : 'talk-test')}</button>
      </div>
      {#if listError}<span role="status">{listError}</span>{/if}
      {#if testing || sampleUrl}
        <div class="row">
          <meter min="-60" max="0" value={db} aria-label={t('talk-level')}></meter>
          <span>{db <= -60 ? t('talk-silent') : db + ' dBFS'}</span>
        </div>
      {/if}
      {#if activeLabel}<span class="muted">{t('talk-active-input', { name: activeLabel })}</span>{/if}
      {#if sampleUrl}<audio src={sampleUrl} controls aria-label={t('talk-play-test')}></audio>{/if}
    </div>
  {/if}
{:else if lookupError}
  <div class="talk-controls"><button type="button" onclick={check}>{t('talk-retry')}</button><span class="talk-feedback" role="status">{lookupError}</span></div>
{/if}
<style>
  .talk-controls { grid-area: talk; justify-self: end; display: flex; align-items: center; gap: var(--space-2); position: relative; }
  .hold { touch-action: none; user-select: none; }
  .talk-feedback { position: absolute; z-index: 1; inset-inline-end: 0; bottom: calc(100% + .25rem); pointer-events: none; }
  .talk-feedback:not(:empty) {
    width: max-content; max-width: min(22rem, 80vw); padding: .25rem .5rem; border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-panel); color: var(--color-text);
  }
  .talk-panel { grid-column: 1 / -1; min-width: 0; display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
  .talk-input-row {
    display: grid; grid-template-columns: max-content minmax(0, 30rem) max-content;
    justify-content: start; align-items: center; gap: var(--space-2);
  }
  .talk-input-row select { width: 100%; min-width: 0; text-overflow: ellipsis; }
  @container (max-width: 26rem) {
    .talk-input-row { grid-template-columns: max-content minmax(0, 1fr) min-content; }
    .talk-input-row button { padding-inline: .5rem; white-space: normal; }
  }
  .talk-panel meter { width: min(7rem, 28vw); }
  .talk-panel audio { max-width: 100%; }
</style>
