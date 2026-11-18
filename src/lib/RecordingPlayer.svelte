<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { t, url } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';
  import { recordingDuration, recordingKinds } from './recordings.js';
  import { recordingStages, type Recording } from '../../shared/recordings.js';

  let { camera, name, recording, recordings, onselect, onclose, onrenew }: {
    camera: string; name: string; recording: Recording; recordings: Recording[];
    onselect: (recording: Recording) => void; onclose: () => void; onrenew: () => Promise<void>;
  } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;
  let title: HTMLHeadingElement;
  let video = $state<HTMLVideoElement>();
  let mode = $state<'next' | 'loop' | 'stop'>('stop');
  let source = $state(''), preparing = $state(true), retry = $state(0);
  let failure = $state<{ status?: number; stage?: string; correlationId?: string; bridgeCorrelationId?: string }>();
  const index = $derived(recordings.findIndex(item => item.id === recording.id));
  const previous = $derived(index > 0 ? recordings[index - 1] : undefined);
  const next = $derived(index >= 0 ? recordings[index + 1] : undefined);
  const errorMessage = $derived(failure?.status === 404 ? t('recording-reference-unavailable')
    : failure?.stage ? t('recording-failure-' + failure.stage) : t('recording-playback-failed'));
  const ended = () => {
    if (mode === 'next' && next) onselect(next);
    else if (mode === 'loop' && video) { video.currentTime = 0; void video.play().catch(() => {}); }
  };
  const select = (item: Recording | undefined) => { if (item) onselect(item); };

  $effect(() => {
    const id = recording.id, currentCamera = camera, requestNumber = retry;
    void requestNumber;
    const controller = new AbortController();
    untrack(() => { source = ''; preparing = true; failure = undefined; video?.pause(); });
    const prepare = async () => {
      const target = url('/api/v1/cameras/' + currentCamera + '/recordings/' + id + '/video');
      const get = () => fetch(target, {
        cache: 'no-store', headers: { range: 'bytes=0-31' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)])
      });
      try {
        let response = await get();
        if (response.status === 404 && !controller.signal.aborted) {
          await response.body?.cancel();
          await onrenew();
          if (controller.signal.aborted) return;
          response = await get();
        }
        if (![200,206].includes(response.status) || response.headers.get('content-type')?.split(';')[0] !== 'video/mp4') {
          const body = await response.json().catch(() => ({}));
          const details = body.details ?? {};
          const stage = typeof details.playbackReason === 'string' && recordingStages.includes(details.playbackReason as typeof recordingStages[number]) ? details.playbackReason : undefined;
          if (!controller.signal.aborted) failure = { status: response.status, stage, correlationId: body.correlationId, bridgeCorrelationId: details.bridgeCorrelationId };
          return;
        }
        await response.body?.cancel();
        if (!controller.signal.aborted) source = target;
      } catch {
        if (!controller.signal.aborted) failure = { stage: 'preparation' };
      } finally { if (!controller.signal.aborted) preparing = false; }
    };
    void prepare();
    return () => controller.abort();
  });
  onMount(() => {
    dialog.showModal();
    title.focus();
    return () => dialog.close();
  });
  onDestroy(() => video?.pause());
</script>

<dialog class="media-dialog recording-dialog" bind:this={dialog} use:dismissOnBackdrop onclose={onclose} aria-labelledby="recording-playback-title">
  <div class="stack">
    <div class="row between panel-title">
      <h2 id="recording-playback-title" bind:this={title} tabindex="-1">{t('recording-playback')} · {name}</h2>
      <button onclick={() => dialog.close()}>{t('close')}</button>
    </div>
    <div class="row between">
      <div class="row">
        <button disabled={!previous} onclick={() => select(previous)}>{t('recording-previous')}</button>
        <button disabled={!next} onclick={() => select(next)}>{t('recording-next')}</button>
      </div>
      <div class="recording-end-mode">
        <label for={id + '-end-mode'}>{t('recording-at-end')}</label>
        <select id={id + '-end-mode'} bind:value={mode}>
          <option value="stop">{t('recording-mode-stop')}</option>
          <option value="next">{t('recording-mode-next')}</option>
          <option value="loop">{t('recording-mode-loop')}</option>
        </select>
      </div>
    </div>
    {#if preparing}
      <div class="recording-stage" role="status">{t('recording-preparing')}</div>
    {:else if source && !failure}
      <!-- svelte-ignore a11y_media_has_caption (Camera recordings do not contain caption tracks.) -->
      <video class="recording-video" controls autoplay playsinline preload="auto" bind:this={video} src={source}
        onended={ended} onerror={() => { failure = {}; }}></video>
    {/if}
    {#if failure}
      <div class="stack notice" role="alert">
        <p class="error">{errorMessage}</p>
        <div class="row"><button onclick={() => { retry++; }}>{t('recording-retry')}</button></div>
        {#if failure.status || failure.correlationId || failure.bridgeCorrelationId}
          <details><summary>{t('recording-failure-details')}</summary><pre>{JSON.stringify(failure,null,2)}</pre></details>
        {/if}
      </div>
    {/if}
    <dl class="recording-facts">
      <div><dt>{t('recording-start')}</dt><dd>{recording.start.replace('T',' ')}</dd></div>
      <div><dt>{t('recording-end')}</dt><dd>{recording.end.replace('T',' ')}</dd></div>
      <div><dt>{t('recording-duration')}</dt><dd>{recordingDuration({ recording })}</dd></div>
      <div><dt>{t('event-type')}</dt><dd>{recordingKinds({ value: recording.kind })}</dd></div>
    </dl>
  </div>
</dialog>
