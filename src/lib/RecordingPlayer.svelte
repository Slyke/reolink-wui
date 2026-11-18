<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { api, t, url } from './api.js';
  import { dismissOnBackdrop } from './dialog.js';
  import { recordingDuration, recordingKinds } from './recordings.js';
  import { recordingStages, type RecordingMetadata } from '../../shared/recordings.js';
  import { recordingTime, recordingVariant, type RecordingGroup } from '../../shared/recording-groups.js';

  let { metadataAvailable, camera, name, recording, recordings, startPosition = 0, onselect, onclose, onrenew }: {
    metadataAvailable: boolean; camera: string; name: string; recording: RecordingGroup; recordings: RecordingGroup[]; startPosition?: number;
    onselect: (recording: RecordingGroup) => void; onclose: () => void; onrenew: () => Promise<void>;
  } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;
  let title: HTMLHeadingElement;
  let video = $state<HTMLVideoElement>();
  let mode = $state<'next' | 'loop' | 'stop'>('stop');
  let stream = $state<'main' | 'sub'>('sub');
  const variant = $derived(recordingVariant({ group: recording, stream }));
  let metadata = $state<RecordingMetadata>();
  let showAllMetadata = $state(false);
  let metadataFailed = $state(false), currentTime = $state(0), videoWidth = $state(16), videoHeight = $state(9);
  const frame = $derived(metadata?.frames.findLast(frame => frame.offsetMs <= currentTime * 1000));
  const boxes = $derived(frame && currentTime * 1000 - frame.offsetMs <= 1000 ? frame.objects.filter(object => object.bounding_box?.coordinate_space === 'normalized_top_left') : []);
  $effect(() => {
    const clip = variant.id, currentCamera = camera, loaded = ready, available = metadataAvailable;
    untrack(() => { metadata = undefined; metadataFailed = false; });
    if (!loaded || !available) return;
    const controller = new AbortController();
    void api<RecordingMetadata>({ path: '/api/v1/cameras/' + currentCamera + '/recordings/' + clip + '/metadata', signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) metadata = value; })
      .catch(() => { if (!controller.signal.aborted) metadataFailed = true; });
    return () => controller.abort();
  });
  let seekTime = 0;
  let previousGroup: string | undefined;
  let source = $state(''), preparing = $state(true), ready = $state(false), retry = $state(0);
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
  const select = (item: RecordingGroup | undefined) => { if (item) onselect(item); };
  const saveMode = () => {
    try { localStorage.setItem('reolink-wui-recording-end-mode', mode); } catch { /* Storage can be unavailable. */ }
  };
  const changeStream = (event: Event) => {
    if (video && source) seekTime = recordingTime(variant.start) + video.currentTime * 1000;
    stream = (event.currentTarget as HTMLSelectElement).value as 'main' | 'sub';
  };
  const target = (camera: string, id: string) => url('/api/v1/cameras/' + camera + '/recordings/' + id + '/video');
  const get = (path: string, signal: AbortSignal) => fetch(path, {
    cache: 'no-store', headers: { range: 'bytes=0-31' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(130_000)])
  });

  $effect(() => {
    const group = recording.id, position = startPosition, clip = variant, currentCamera = camera, requestNumber = retry;
    void requestNumber;
    const controller = new AbortController();
    untrack(() => {
      if (previousGroup !== group) seekTime = recordingTime(recording.start) + position;
      previousGroup = group;
      source = ''; preparing = true; ready = false; failure = undefined; video?.pause();
    });
    const prepare = async () => {
      const path = target(currentCamera,clip.id);
      try {
        let response = await get(path,controller.signal);
        if (response.status === 404 && !controller.signal.aborted) {
          await response.body?.cancel();
          await onrenew();
          if (controller.signal.aborted) return;
          response = await get(path,controller.signal);
        }
        if (![200,206].includes(response.status) || response.headers.get('content-type')?.split(';')[0] !== 'video/mp4') {
          const body = await response.json().catch(() => ({}));
          const details = body.details ?? {};
          const stage = typeof details.playbackReason === 'string' && recordingStages.includes(details.playbackReason as typeof recordingStages[number]) ? details.playbackReason : undefined;
          if (!controller.signal.aborted) failure = { status: response.status, stage, correlationId: body.correlationId, bridgeCorrelationId: details.bridgeCorrelationId };
          return;
        }
        await response.body?.cancel();
        if (!controller.signal.aborted) source = path;
      } catch {
        if (!controller.signal.aborted) failure = { stage: 'preparation' };
      } finally { if (!controller.signal.aborted) preparing = false; }
    };
    void prepare();
    return () => controller.abort();
  });

  // Warming a neighbour cannot delay the recording the user selected.
  const warmed = new Map<string,number>();
  $effect(() => {
    const active = source, loaded = ready && !preparing && !failure, currentCamera = camera, quality = stream;
    const neighbours = [next,previous].filter((item): item is RecordingGroup => Boolean(item));
    if (!loaded || !active) return;
    const controller = new AbortController();
    const warm = async () => {
      for (const item of neighbours) {
        if (controller.signal.aborted) return;
        const path = target(currentCamera,recordingVariant({ group: item, stream: quality }).id);
        if ((warmed.get(path) ?? 0) > Date.now()) continue;
        try {
          const response = await get(path,controller.signal);
          if (response.ok) warmed.set(path,Date.now() + 60_000);
          await response.body?.cancel();
        } catch { /* Preloading must not interrupt the current recording. */ }
      }
    };
    void warm();
    return () => controller.abort();
  });
  const loadedMetadata = () => {
    if (video) { videoWidth = video.videoWidth || 16; videoHeight = video.videoHeight || 9; video.currentTime = Math.max(0,Math.min(video.duration || Infinity,(seekTime - recordingTime(variant.start)) / 1000)); }
  };
  onMount(() => {
    try {
      const saved = localStorage.getItem('reolink-wui-recording-end-mode');
      if (saved === 'next' || saved === 'loop' || saved === 'stop') mode = saved;
    } catch { /* Storage can be unavailable. */ }
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
    <div class="row between recording-controls">
      <div class="row">
        <button disabled={!previous} onclick={() => select(previous)}>{t('recording-previous')}</button>
        <button disabled={!next} onclick={() => select(next)}>{t('recording-next')}</button>
        <select class="recording-quality" aria-label={t('live-quality')} value={variant.stream} onchange={changeStream}>
          {#each recording.variants as item (item.stream)}<option value={item.stream}>{t(item.stream === 'main' ? 'primary' : 'secondary')}</option>{/each}
        </select>
      </div>
      <div class="recording-end-mode">
        <label for={id + '-end-mode'}>{t('recording-at-end')}</label>
        <select id={id + '-end-mode'} bind:value={mode} onchange={saveMode}>
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
      <div class="recording-picture">
      <video class="recording-video" controls autoplay playsinline preload="auto" bind:this={video} src={source}
        onloadedmetadata={loadedMetadata} onloadeddata={() => { ready = true; }}
        ontimeupdate={() => { currentTime = video?.currentTime ?? 0; }} onended={ended} onerror={() => { failure = {}; }}></video>
        {#if boxes.length}
          <svg class="recording-boxes" viewBox={'0 0 ' + videoWidth + ' ' + videoHeight} aria-label={t('event-bounds')}>
            {#each boxes as object}
              {@const box = object.bounding_box!}
              <rect x={Math.max(0,box.left) * videoWidth} y={Math.max(0,box.top) * videoHeight}
                width={Math.max(0,Math.min(1,box.right) - Math.max(0,box.left)) * videoWidth}
                height={Math.max(0,Math.min(1,box.bottom) - Math.max(0,box.top)) * videoHeight} />
            {/each}
          </svg>
        {/if}
      </div>
      {#if metadataFailed}<p class="notice">{t('recording-metadata-failed')}</p>
      {:else if metadata && !metadata.frames.some(frame => frame.objects.length)}<p class="muted">{t('recording-metadata-empty')}</p>
      {:else if !metadataAvailable}<p class="muted">{t('recording-metadata-unsupported')}</p>{/if}
      {#if metadata}
        <details><summary>{t('recording-metadata-json')}</summary>
          <p class="muted">{t('recording-metadata-samples', { count: metadata.frames.length })}</p>
          {#if metadata.truncated}<p class="notice">{t('recording-metadata-truncated')}</p>{/if}
          <pre>{JSON.stringify(frame ?? { objects: [] },null,2)}</pre>
          <details ontoggle={event => { showAllMetadata = event.currentTarget.open; }}><summary>{t('recording-metadata-all')}</summary>{#if showAllMetadata}<pre>{JSON.stringify(metadata,null,2)}</pre>{/if}</details>
        </details>
      {/if}
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
      <div><dt>{t('recording-start')}</dt><dd>{variant.start.replace('T',' ')}</dd></div>
      <div><dt>{t('recording-end')}</dt><dd>{variant.end.replace('T',' ')}</dd></div>
      <div><dt>{t('recording-duration')}</dt><dd>{recordingDuration({ recording: variant })}</dd></div>
      <div><dt>{t('event-type')}</dt><dd>{recordingKinds({ value: recording.kind })}</dd></div>
    </dl>
  </div>
</dialog>
