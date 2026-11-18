<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { page } from '$app/state';
  import { api, errorText, t, url } from '$lib/api.js';
  import type { Camera } from '$lib/models.js';
  import SearchSelect from '$lib/SearchSelect.svelte';
  import type { RecordingList, StorageInfo } from '../../../../shared/recordings.js';

  let cameras = $state<Camera[]>([]);
  let selected = $state('');
  const camera = $derived(cameras.find(item => item.id === selected));
  let storage = $state<StorageInfo>();
  const playbackAvailable = $derived(Boolean(storage?.playbackAvailable ?? camera?.capabilities.recordingPlayback));
  let listing = $state<RecordingList>();
  let recording = $state<RecordingList['recordings'][number]>();
  let date = $state('');
  let stream = $state<'main' | 'sub'>('sub');
  let initial = $state(true);
  let loading = $state(false);
  let reading = $state(false);
  let error = $state('');
  let playbackError = $state(false);
  let controller: AbortController | undefined;
  let listController: AbortController | undefined;

  const size = (value: number | null) => value === null ? t('empty-value') : t('storage-gb', {
    value: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / 1_000_000_000)
  });
  const search = async ({ signal }: { signal?: AbortSignal } = {}) => {
    listController?.abort();
    const current = new AbortController();
    listController = current;
    const combined = signal ? AbortSignal.any([signal, current.signal]) : current.signal;
    loading = true;
    recording = undefined;
    playbackError = false;
    error = '';
    try {
      const query = new URLSearchParams({ date, stream });
      const next = await api<RecordingList>({
        path: '/api/v1/cameras/' + selected + '/recordings?' + query, signal: combined
      });
      if (!combined.aborted) listing = next;
    } catch (err) {
      if (!combined.aborted) { listing = undefined; error = errorText(err); }
    } finally {
      if (listController === current) loading = false;
    }
  };
  const refresh = async () => {
    if (!camera?.capabilities.recordings) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    reading = true;
    error = '';
    try {
      const next = await api<StorageInfo>({ path: '/api/v1/cameras/' + selected + '/storage', signal: current.signal });
      if (current.signal.aborted) return;
      storage = next;
      if (!date) date = next.cameraTime?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      if (!next.streams.includes(stream)) stream = next.streams[0];
      await search({ signal: current.signal });
    } catch (err) {
      if (!current.signal.aborted) error = errorText(err);
    } finally {
      if (controller === current) reading = false;
    }
  };
  $effect(() => {
    const id = camera?.id;
    const supported = camera?.capabilities.recordings;
    untrack(() => {
      controller?.abort();
      listController?.abort();
      storage = undefined;
      listing = undefined;
      recording = undefined;
      date = '';
      error = '';
      if (id && supported) void refresh();
    });
    return () => { controller?.abort(); listController?.abort(); };
  });

  onMount(() => {
    const request = new AbortController();
    void api<{ cameras: Camera[] }>({ path: '/api/v1/cameras', signal: request.signal }).then(result => {
      if (request.signal.aborted) return;
      cameras = result.cameras;
      const requested = page.url.searchParams.get('camera');
      selected = cameras.find(item => item.id === requested)?.id
        ?? cameras.find(item => item.capabilities.recordings)?.id ?? cameras[0]?.id ?? '';
    }).catch(err => { if (!request.signal.aborted) error = errorText(err); })
      .finally(() => { if (!request.signal.aborted) initial = false; });
    return () => request.abort();
  });
</script>

<svelte:head><title>{t('recordings')} · {t('title')}</title></svelte:head>

<h1>{t('recordings')}</h1>
<section class="panel stack">
  <div class="row between panel-title">
    <h2>{t('recordings-camera')}</h2>
    <button disabled={initial || reading || loading || !camera?.capabilities.recordings} onclick={refresh}>{t('refresh')}</button>
  </div>
  {#if cameras.length}
    <SearchSelect label={t('camera-noun')} bind:value={selected} options={cameras.map((item, index) => ({
      value: item.id, label: item.name ?? t('camera-generic', { index: index + 1 }), detail: item.model
    }))} />
  {:else if initial}
    <p role="status">{t('loading')}</p>
  {:else}
    <p class="muted">{t('no-cameras')}</p>
  {/if}
  {#if camera && !camera.capabilities.recordings}<p class="muted">{t('recordings-unavailable')}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</section>

{#if camera?.capabilities.recordings}
  <section class="panel stack" aria-labelledby="card-storage">
    <h2 id="card-storage" class="panel-title">{t('storage')}</h2>
    {#if storage}
      <div class="grid">
        {#each storage.cards as card (card.number)}
          <article class="panel stack">
            <div class="row between">
              <h3>{t('storage-' + card.kind)}</h3>
              <span class="pill" data-status={card.mounted && card.formatted ? 'online' : 'offline'}>{t(card.mounted && card.formatted ? 'storage-ready' : 'storage-unavailable')}</span>
            </div>
            <dl class="event-metadata">
              <dt>{t('storage-total')}</dt><dd>{size(card.totalBytes)}</dd>
              <dt>{t('storage-used')}</dt><dd>{size(card.usedBytes)}</dd>
              <dt>{t('storage-free')}</dt><dd>{size(card.freeBytes)}</dd>
            </dl>
            {#if card.totalBytes && card.usedBytes !== null}
              <meter min="0" max={card.totalBytes} value={card.usedBytes} aria-label={t('storage-used')}></meter>
            {/if}
          </article>
        {:else}
          <p class="muted">{t('storage-empty')}</p>
        {/each}
      </div>
    {:else if reading}
      <p role="status">{t('loading')}</p>
    {/if}
  </section>

  <section class="panel stack" aria-labelledby="recording-list">
    <h2 id="recording-list" class="panel-title">{t('recordings')}</h2>
    <form class="row recording-search" onsubmit={event => { event.preventDefault(); void search(); }}>
      <label>{t('recording-date')}<input type="date" required bind:value={date} /></label>
      <label>{t('live-quality')}
        <select bind:value={stream}>
          {#each storage?.streams ?? ['main', 'sub'] as value}
            <option value={value}>{t(value === 'main' ? 'primary' : 'secondary')}</option>
          {/each}
        </select>
      </label>
      <button disabled={loading || reading || !date}>{t('recordings-search')}</button>
    </form>
    <p class="muted">{t('recordings-camera-time')}</p>
    {#if !playbackAvailable}<p class="notice">{t('recording-workspace-unavailable')}</p>{/if}
    {#if loading}
      <p role="status">{t('recordings-searching')}</p>
    {:else if listing?.recordings.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Recording rows need keyboard scroll access.) -->
      <div class="table-scroll" role="region" aria-labelledby="recording-list" tabindex="0">
        <table>
          <thead><tr><th>{t('recording-start')}</th><th>{t('recording-end')}</th><th>{t('event-type')}</th><th>{t('recording-size')}</th><th>{t('recording-play')}</th></tr></thead>
          <tbody>
            {#each listing.recordings as item (item.id)}
              <tr>
                <td>{item.start.replace('T', ' ')}</td><td>{item.end.replace('T', ' ')}</td>
                <td>{item.kind ?? t('empty-value')}</td><td>{size(item.sizeBytes)}</td>
                <td><button disabled={!playbackAvailable} onclick={() => { recording = item; playbackError = false; }}>{t('recording-play')}</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if listing}
      <p class="muted">{t('recordings-empty')}</p>
    {/if}
    {#if listing?.truncated}<p class="notice">{t('recordings-truncated')}</p>{/if}
  </section>
  {#if recording && playbackAvailable}
    <section class="panel stack" aria-labelledby="recording-playback">
      <div class="row between panel-title">
        <h2 id="recording-playback">{t('recording-playback')}</h2>
        <button onclick={() => { recording = undefined; }}>{t('close')}</button>
      </div>
      {#key recording.id}
        <!-- svelte-ignore a11y_media_has_caption (The camera supplies the recorded footage without caption tracks.) -->
        <video class="recording-video" controls preload="metadata"
          src={url('/api/v1/cameras/' + selected + '/recordings/' + recording.id + '/video')}
          onerror={() => { playbackError = true; }}></video>
      {/key}
      {#if playbackError}<p class="error" role="alert">{t('recording-playback-failed')}</p>{/if}
    </section>
  {/if}
{/if}
