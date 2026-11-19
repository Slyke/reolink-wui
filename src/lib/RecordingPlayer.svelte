<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { api, t, url } from './api.js';
  import { frameDetails, frameIndex, RecordingIndexError, recordingFrameTimes, recordingJson } from './recording-frames.js';
  import { dismissOnBackdrop } from './dialog.js';
  import { recordingDuration, recordingKinds } from './recordings.js';
  import { recordingStages, type RecordingMetadata } from '../../shared/recordings.js';
  import { recordingTime, recordingVariant, type RecordingGroup } from '../../shared/recording-groups.js';

  let { canExport, metadataAvailable, camera, name, recording, recordings, startPosition = 0, stream, onstream, onselect, onclose, onrenew }: {
    canExport: boolean; metadataAvailable: boolean; camera: string; name: string; recording: RecordingGroup; recordings: RecordingGroup[]; startPosition?: number;
    stream: 'main' | 'sub'; onstream: (stream: 'main' | 'sub') => void;
    onselect: (recording: RecordingGroup) => void; onclose: () => void; onrenew: () => Promise<void>;
  } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;
  let title: HTMLHeadingElement;
  let video = $state<HTMLVideoElement>();
  let mode = $state<'next' | 'loop' | 'stop'>('stop');
  const variant = $derived(recordingVariant({ group: recording, stream }));
  let metadata = $state<RecordingMetadata>();
  let jsonOpen = $state(false), compactVideo = $state(false), copyStatus = $state('');
  let jsonScope = $state<'frame'|'all'>('frame'), jsonPage = $state(0);
  const pageSize = 64;
  let times = $state.raw<number[]>([]), indexError = $state(''), indexRetry = $state(0);
  let metadataFailed = $state(false), currentTime = $state(0), videoWidth = $state(16), videoHeight = $state(9);
  const indexOfFrame = $derived(frameIndex(times,currentTime));
  const frame = $derived(frameDetails(indexOfFrame,times[indexOfFrame] ?? currentTime,metadata));
  const boxes = $derived(frame.objects?.filter(object => object.bounding_box?.coordinate_space === 'normalized_top_left') ?? []);
  const steps = [{ value: 10, unit: 'seconds' }, { value: 5, unit: 'seconds' }, { value: 1, unit: 'seconds' },
    { value: 10, unit: 'frames' }, { value: 1, unit: 'frames' }] as const;
  let step = $state(0);
  const stepBy = (direction: -1 | 1) => {
    if (!video || !ready || !Number.isFinite(video.duration)) return;
    const { unit, value } = steps[step];
    let position = video.currentTime + direction * value;
    if (unit === 'frames') {
      if (!times.length) return;
      video.pause();
      const index = Math.max(0, Math.min(times.length - 1, frameIndex(times,video.currentTime) + direction * value));
      const end = Math.min(times[index+1] ?? video.duration, video.duration);
      position = times[index] + Math.max(0, end - times[index]) / 2;
    }
    video.currentTime = Math.max(0,Math.min(video.duration,position));
    currentTime = video.currentTime;
    copyStatus = '';
  };
  const followPicture = (element: HTMLVideoElement) => {
    if (!element.requestVideoFrameCallback) return;
    let handle = 0;
    const presented: VideoFrameRequestCallback = (_, info) => {
      if (!element.seeking) currentTime = info.mediaTime;
      handle = element.requestVideoFrameCallback(presented);
    };
    handle = element.requestVideoFrameCallback(presented);
    return { destroy() { element.cancelVideoFrameCallback(handle); } };
  };
  $effect(() => {
    const path = source, loaded = ready;
    void indexRetry;
    times = []; indexError = '';
    if (!path || !loaded) return;
    const controller = new AbortController();
    void recordingFrameTimes(path,controller.signal).then(value => {
      if (!controller.signal.aborted) times = value;
    }).catch(error => {
      if (!controller.signal.aborted) indexError = error instanceof RecordingIndexError
        ? t('recording-index-' + error.reason, { status: error.status ?? '' }) : t('recording-index-failed');
    });
    return () => controller.abort();
  });
  const fileBase = $derived((name.replace(/[^a-zA-Z0-9_-]+/g,'-') || 'camera') + '-' + variant.start.replaceAll(':','-') + '-' + variant.stream);
  const currentJson = $derived(JSON.stringify(frame,null,2));
  const exportAll = () => recordingJson(times,metadata,{ camera,recordingId:variant.id,stream:variant.stream,start:variant.start,end:variant.end });
  const allReady = $derived(times.length > 0 && (!metadataAvailable || !!metadata || metadataFailed));
  const jsonPageCount = $derived(Math.max(1,Math.ceil(times.length / pageSize)));
  const pageJson = $derived.by(() => {
    if (!jsonOpen || jsonScope !== 'all') return '';
    const start = jsonPage * pageSize;
    return JSON.stringify(times.slice(start,start + pageSize).map((time,i) => frameDetails(start+i,time,metadata)),null,2);
  });
  const copyJson = async () => {
    try {
      if (jsonScope === 'all' && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        const plain = new Blob([exportAll()],{type:'text/plain'});
        await navigator.clipboard.write([new ClipboardItem({'text/plain':plain})]);
      } else {
        await navigator.clipboard.writeText(jsonScope === 'all' ? await exportAll().text() : currentJson);
      }
      copyStatus = 'recording-json-copied';
    } catch { copyStatus = 'event-json-copy-blocked'; }
  };
  const downloadJson = (all: boolean) => {
    const blob = all ? exportAll() : new Blob([currentJson],{ type:'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = fileBase + (all ? '-all-frames' : '-frame-' + (frame.frame ?? 'current')) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(href),1000);
  };
  $effect(() => {
    const clip = variant.id, currentCamera = camera, loaded = ready, available = metadataAvailable;
    untrack(() => { metadata = undefined; metadataFailed = false; });
    if (!loaded || !available) return;
    const controller = new AbortController();
    const path = '/api/v1/cameras/' + currentCamera + '/recordings/' + clip + '/metadata';
    const load = async () => {
      let page = 0;
      const frames: RecordingMetadata['frames'] = [];
      while (!controller.signal.aborted) {
        const result = await api<RecordingMetadata>({path: path + (page ? '?page=' + page : ''),signal:controller.signal});
        if (controller.signal.aborted) return;
        frames.push(...result.frames);
        if (result.nextPage == null) { metadata = { ...result,frames }; return; }
        if (result.nextPage !== page+1 || !result.frames.length) throw new Error('Invalid recording metadata page');
        page = result.nextPage;
      }
    };
    void load().catch(() => { if (!controller.signal.aborted) metadataFailed = true; });
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
    onstream((event.currentTarget as HTMLSelectElement).value as 'main' | 'sub');
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
      source = ''; currentTime = 0; jsonPage = 0; copyStatus = ''; preparing = true; ready = false; failure = undefined; video?.pause();
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

<dialog class="media-dialog recording-dialog" bind:this={dialog} use:dismissOnBackdrop={onclose} oncancel={event => { event.preventDefault(); onclose(); }} aria-labelledby="recording-playback-title">
  <div class="recording-toolbar">
    <div class="row between panel-title">
      <h2 id="recording-playback-title" bind:this={title} tabindex="-1">{t('recording-playback')} · {name}</h2>
      <button onclick={onclose}>{t('close')}</button>
    </div>
    <div class="recording-controls">
      <button disabled={!previous} onclick={() => select(previous)}>{t('recording-previous')}</button>
      <button disabled={!next} onclick={() => select(next)}>{t('recording-next')}</button>
      <select class="recording-quality" aria-label={t('live-quality')} value={variant.stream} onchange={changeStream}>
        {#each recording.variants as item (item.stream)}<option value={item.stream}>{t(item.stream === 'main' ? 'primary' : 'secondary')}</option>{/each}
      </select>
      <div class="recording-end-mode">
        <label for={id + '-end-mode'}>{t('recording-at-end')}</label>
        <select id={id + '-end-mode'} bind:value={mode} onchange={saveMode}>
          <option value="stop">{t('recording-mode-stop')}</option>
          <option value="next">{t('recording-mode-next')}</option>
          <option value="loop">{t('recording-mode-loop')}</option>
        </select>
      </div>
    </div>
    <div class="recording-tools">
      <div class="recording-step" role="group" aria-label={t('recording-navigate')}>
        <button aria-label={t('recording-step-back')} title={t('recording-step-back')} disabled={!ready || (steps[step].unit === 'frames' && !times.length)} onclick={() => stepBy(-1)}>◀</button>
        <select aria-label={t('recording-step-size')} bind:value={step}>
          {#each steps as option,i}<option value={i}>{t('recording-step-' + option.unit + '-' + option.value)}</option>{/each}
        </select>
        <button aria-label={t('recording-step-forward')} title={t('recording-step-forward')} disabled={!ready || (steps[step].unit === 'frames' && !times.length)} onclick={() => stepBy(1)}>▶</button>
      </div>
      {#if source && !failure}
        {#if canExport}<a class="button" href={source + '?download=1&name=' + encodeURIComponent(fileBase.slice(0,160))} download={fileBase + '.mp4'}>{t('recording-download-mp4')}</a>{/if}
        <button type="button" aria-pressed={compactVideo} onclick={() => { compactVideo = !compactVideo; }}>{t(compactVideo ? 'recording-enlarge-video' : 'recording-shrink-video')}</button>
        <button type="button" aria-controls={id+'-json'} aria-expanded={jsonOpen} onclick={() => { jsonOpen = !jsonOpen; copyStatus = ''; }}>{t(jsonOpen ? 'recording-hide-json' : 'recording-metadata-json')}</button>
      {/if}
      {#if jsonOpen && source && !failure}
        <div class="recording-json-actions" role="group" aria-label={t('recording-metadata-json')}>
          <select class="recording-json-scope" aria-label={t('recording-json-scope')} bind:value={jsonScope} onchange={() => { copyStatus = ''; }}>
            <option value="frame">{t('recording-current-frame')}</option><option value="all">{t('recording-all-frames')}</option>
          </select>
          {#if canExport}<button onclick={copyJson} disabled={jsonScope === 'all' && !allReady}>{t('event-copy-json')}</button>
          <button disabled={jsonScope === 'all' && !allReady} onclick={() => downloadJson(jsonScope === 'all')}>{t('recording-download-json')}</button>{/if}
          {#if jsonScope === 'frame' && canExport}
            <button disabled={!allReady} onclick={() => downloadJson(true)}>{t('recording-export-frames')}</button>
          {:else if jsonScope === 'all' && jsonPageCount > 1}
            <button aria-label={t('recording-page-previous')} disabled={jsonPage === 0} onclick={() => jsonPage--}>‹</button>
            <span>{jsonPage + 1} / {jsonPageCount}</span>
            <button aria-label={t('recording-page-next')} disabled={jsonPage+1 >= jsonPageCount} onclick={() => jsonPage++}>›</button>
          {/if}
          {#if copyStatus}<span role="status">{t(copyStatus)}</span>{/if}
        </div>
      {/if}
    </div>
  </div>
  <div class="recording-body" class:compact={compactVideo} class:inspecting={jsonOpen}>
    {#if preparing}
      <div class="recording-stage" role="status">{t('recording-preparing')}</div>
    {:else if source && !failure}
      <!-- svelte-ignore a11y_media_has_caption (Camera recordings do not contain caption tracks.) -->
      <div class="recording-picture">
      <video class="recording-video" controls autoplay playsinline preload="auto" bind:this={video} use:followPicture src={source}
        onloadedmetadata={loadedMetadata} onloadeddata={() => { ready = true; }}
        onseeked={() => { currentTime = video?.currentTime ?? 0; }} ontimeupdate={() => { if (video && !video.requestVideoFrameCallback) currentTime = video.currentTime; }} onended={ended} onerror={() => { failure = {}; }}></video>
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
      {#if indexError}<p class="notice">{indexError} <button onclick={() => { indexRetry++; }}>{t('retry')}</button></p>{/if}
      {#if jsonOpen}
        <section class="recording-json" id={id+'-json'} aria-label={t('recording-metadata-json')}>
          {#if metadataFailed}<p class="notice">{t('recording-metadata-failed')}</p>
          {:else if !metadataAvailable}<p class="muted">{t('recording-metadata-unsupported')}</p>
          {:else if metadata?.truncated}<p class="notice">{t('recording-metadata-truncated')}</p>
          {:else if metadata && !metadata.frames.some(sample => sample.objects.length)}<p class="muted">{t('recording-metadata-empty')}</p>{/if}
          <pre>{jsonScope === 'all' ? pageJson : currentJson}</pre>
        </section>
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
