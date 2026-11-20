<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto, replaceState } from '$app/navigation';
  import { api, errorText, t, url } from '$lib/api.js';
  import { formatLocalTimestamp } from '$lib/dates.js';
  import type { Camera } from '$lib/models.js';
  import RecordingExport from '$lib/RecordingExport.svelte';
  import RecordingPlayer from '$lib/RecordingPlayer.svelte';
  import RecordingPreview from '$lib/RecordingPreview.svelte';
  import RecordingTimeline from '$lib/RecordingTimeline.svelte';
  import { RecordingPreviews } from '$lib/recording-previews.js';
  import { groupRecordings, recordingTime, recordingVariant, type RecordingGroup } from '../../../../shared/recording-groups.js';
  import { recordingSize, recordingDuration, recordingKinds } from '$lib/recordings.js';
  import SearchSelect from '$lib/SearchSelect.svelte';
  import { recordingDate, recordingStream, type Recording, type RecordingList, type StorageInfo, type TimelinePhoto } from '../../../../shared/recordings.js';

  const fieldId = $props.id();
  let cameras = $state<Camera[]>([]);
  const linkedCamera = $derived(page.url.searchParams.get('camera'));
  const linkedDate = $derived(recordingDate.safeParse(page.url.searchParams.get('date')).data);
  const linkedClip = $derived(page.url.searchParams.get('recording'));
  const linkedStream = $derived(recordingStream.safeParse(page.url.searchParams.get('stream')).data);
  const selected = $derived(linkedCamera ?? cameras.find(item => item.capabilities.recordings || item.capabilities.timeLapsePhotos)?.id ?? cameras[0]?.id ?? '');
  const camera = $derived(cameras.find(item => item.id === selected));
  const canBrowse = $derived(Boolean(camera?.capabilities.recordings || camera?.capabilities.timeLapsePhotos));
  let storage = $state<StorageInfo>();
  const playbackAvailable = $derived(Boolean(storage?.playbackAvailable ?? camera?.capabilities.recordingPlayback));
  const clockComparison = $derived.by(() => {
    if (!storage?.cameraTime) return;
    const cameraTime = storage.cameraTime;
    const localTime = formatLocalTimestamp(storage.refreshedAt).replace(' ', 'T');
    if (Math.abs(recordingTime(cameraTime) - recordingTime(localTime)) < 300_000) return;
    const sameDay = cameraTime.slice(0, 10) === localTime.slice(0, 10);
    const display = (time: string) => sameDay ? time.slice(11, 16) : time.replace('T', ' ').slice(0, 16);
    return { camera: display(cameraTime), local: display(localTime) };
  });
  const defaultStreams = ['sub', 'main'] as const;
  let listing = $state<{ date: string; recordings: RecordingGroup[]; truncated: boolean; partial: boolean }>();
  let gallery = $state<{date:string;photos:TimelinePhoto[];undatedCount:number}>();
  let photoError = $state(''), photosLoading = $state(false);
  const listedDate = $derived(listing?.date ?? gallery?.date ?? '');
  const undatedCount = $derived(gallery?.date === listedDate ? gallery.undatedCount : 0);
  const timelineVideos = $derived(listing?.recordings ?? []);
  const timelinePhotos = $derived(gallery?.date === listedDate ? gallery.photos : []);
  const previews = $derived(new RecordingPreviews(selected, listedDate));
  $effect(() => {
    const cache = previews;
    return () => cache.close();
  });
  const recording = $derived(linkedClip && linkedCamera === selected && listing && listing.date === linkedDate
    ? listing.recordings.find(group => group.variants.some(item => item.id === linkedClip)) : undefined);
  const stream = $derived(linkedStream ?? recording?.variants.find(item => item.id === linkedClip)?.stream ?? 'sub');
  const startPosition = $derived.by(() => {
    const offset = Number(page.url.searchParams.get('at'));
    return recording && Number.isSafeInteger(offset) ? Math.max(0, Math.min(offset, recordingTime(recording.end) - recordingTime(recording.start))) : 0;
  });
  let highlighted = $state<string>();
  let date = $state('');
  let userSelectedDate = false;
  let initial = $state(true);
  let loading = $state(false);
  let reading = $state(false);
  let cameraError = $state('');
  let storageError = $state('');
  let searchError = $state('');
  let layout = $state<'grid' | 'table'>('grid');
  let pageNumber = $state(0);
  let pageSize = $state('12');
  let timeOrder = $state<'asc' | 'desc'>('desc');
  const ordered = $derived.by(() => {
    const items = listing?.recordings ?? [];
    return timeOrder === 'desc' ? [...items].reverse() : items;
  });
  const perPage = $derived(pageSize === 'all' ? listing?.recordings.length || 1 : Number(pageSize));
  const visible = $derived(ordered.slice(pageNumber * perPage, (pageNumber + 1) * perPage));
  const pageCount = $derived(Math.max(1,Math.ceil((listing?.recordings.length ?? 0) / perPage)));
  const chooseLayout = (value: 'grid' | 'table') => {
    layout = value;
    try { localStorage.setItem('reolink-wui-recordings-layout', value); } catch { /* Storage can be unavailable. */ }
  };
  const choosePageSize = () => {
    pageNumber = 0;
    try { localStorage.setItem('reolink-wui-recordings-page-size', pageSize); } catch { /* Storage can be unavailable. */ }
  };
  const chooseTimeOrder = () => {
    pageNumber = 0;
    try { localStorage.setItem('reolink-wui-recordings-time-order', timeOrder); } catch { /* Storage can be unavailable. */ }
  };
  const listUrl = (cameraId: string, day?: string) => {
    const result = new URL(page.url);
    for (const key of ['camera', 'date', 'recording', 'stream', 'at']) result.searchParams.delete(key);
    if (cameraId) result.searchParams.set('camera', cameraId);
    if (day) result.searchParams.set('date', day);
    return result;
  };
  const navigate = (target: URL, replaceState: boolean, fromList = false) => goto(target, {
    replaceState, keepFocus: true, noScroll: true, state: { ...page.state, recordingFromList: fromList }
  });
  const openedFromList = () => 'recordingFromList' in page.state && page.state.recordingFromList === true;
  const savedStream = (): Recording['stream'] => {
    try { return localStorage.getItem('reolink-wui-recording-stream-' + selected) === 'main' ? 'main' : 'sub'; }
    catch { return 'sub'; }
  };
  const openClip = async (group: RecordingGroup, quality: Recording['stream'], offset: number) => {
    if (!listing) return;
    const base = listUrl(selected, listing.date);
    const target = new URL(base);
    const variant = recordingVariant({ group, stream: quality });
    target.searchParams.set('recording', variant.id);
    target.searchParams.set('stream', variant.stream);
    if (offset > 0) target.searchParams.set('at', String(Math.round(offset)));
    const opening = !linkedClip;
    if (opening && page.url.href !== base.href) await navigate(base, true);
    if (page.url.href !== target.href) await navigate(target, !opening, opening || openedFromList());
  };
  const select = (item: RecordingGroup, offsetMs = 0) => openClip(item, linkedClip ? stream : savedStream(), offsetMs);
  const chooseStream = (value: Recording['stream']) => {
    if (!recording) return;
    try { localStorage.setItem('reolink-wui-recording-stream-' + selected, value); } catch { /* Storage can be unavailable. */ }
    void openClip(recording, value, startPosition);
  };
  const closePlayer = () => {
    if (!linkedClip) return;
    const base = listUrl(camera?.id ?? '', linkedDate);
    if (openedFromList()) {
      // Close also takes effect if the browser reloads before its popstate event.
      replaceState(base, { ...page.state, recordingFromList:false });
      window.history.back();
    } else void navigate(base, true);
  };
  const submitDate = () => {
    const target = listUrl(selected, date);
    if (page.url.href === target.href) void search();
    else void navigate(target, true);
  };
  const hover = (id?: string) => {
    highlighted = id;
    if (id && listing) {
      const index = ordered.findIndex(item => item.id === id);
      if (index >= 0) pageNumber = Math.floor(index / perPage);
    }
  };
  const loadListing = async (signal?: AbortSignal, currentDate = date) => {
    const id = selected, streams = storage?.streams ?? defaultStreams;
    const results: RecordingList[] = [];
    let failure: unknown;
    for (const stream of streams) {
      if (signal?.aborted) throw signal.reason;
      try {
        results.push(await api<RecordingList>({
          path: '/api/v1/cameras/' + id + '/recordings?' + new URLSearchParams({ date: currentDate, stream }), signal
        }));
      } catch (error) { failure = error; }
    }
    if (!results.length) throw failure;
    return {
      date: currentDate, recordings: groupRecordings({ recordings: results.flatMap(result => result.recordings) }),
      truncated: results.some(result => result.truncated), partial: results.length < streams.length
    };
  };
  const renew = async () => {
    const signal = listController?.signal;
    const next = await loadListing(signal, listing?.date);
    if (!signal?.aborted) listing = next;
  };
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
    const id = selected, searchDate = date;
    highlighted = undefined;
    if (listing?.date !== searchDate) listing = undefined;
    if (gallery?.date !== searchDate) gallery = undefined;
    photoError = '';
    photosLoading = Boolean(camera?.capabilities.timeLapsePhotos);
    if (photosLoading) {
      void api<{date:string;photos:TimelinePhoto[];undatedCount:number}>({path:'/api/v1/cameras/'+id+'/time-lapse/photos?date='+searchDate,signal:combined})
        .then(result => { if (!combined.aborted && result.date === searchDate) gallery = result; })
        .catch(err => { if (!combined.aborted) photoError = errorText(err); })
        .finally(() => { if (!combined.aborted && listController === current) photosLoading = false; });
    }
    loading = Boolean(camera?.capabilities.recordings);
    pageNumber = 0;
    searchError = '';
    if (!loading) return;
    try {
      const next = await loadListing(combined,searchDate);
      if (!combined.aborted) listing = next;
    } catch (err) {
      if (!combined.aborted) { listing = undefined; searchError = errorText(err); }
    } finally {
      if (listController === current) loading = false;
    }
  };
  const refresh = async () => {
    if (!canBrowse) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    reading = true;
    storageError = '';
    if (!date) date = formatLocalTimestamp(Date.now()).slice(0, 10);
    const searchedDate = date;
    const searchedStreams = new Set(storage?.streams ?? defaultStreams);
    void search({ signal: current.signal });
    const startedSearch = listController;
    if (!camera?.capabilities.recordings) { reading = false; return; }
    try {
      const next = await api<StorageInfo>({ path: '/api/v1/cameras/' + selected + '/storage', signal: current.signal });
      if (current.signal.aborted) return;
      storage = next;
      // Only refine the automatic search. A newer selection or manual search takes precedence.
      if (listController === startedSearch && date === searchedDate) {
        const nextDate = !userSelectedDate && next.cameraTime ? next.cameraTime.slice(0, 10) : date;
        if (nextDate !== date || next.streams.length !== searchedStreams.size || next.streams.some(stream => !searchedStreams.has(stream))) {
          date = nextDate;
          void search({ signal: current.signal });
        }
      }
    } catch (err) {
      if (!current.signal.aborted) {
        storage = undefined;
        storageError = errorText(err);
      }
    } finally {
      if (controller === current) reading = false;
    }
  };
  let loadedCamera: string | undefined, loadedSupport: string | undefined;
  $effect(() => {
    const id = camera?.id, supported = canBrowse, day = linkedDate;
    const support = [camera?.capabilities.recordings,camera?.capabilities.timeLapsePhotos].join('/');
    untrack(() => {
      if (id === loadedCamera && support === loadedSupport) {
        if (day && supported) {
          userSelectedDate = true;
          date = day;
          if (listing?.date !== day) void search();
        }
        return;
      }
      loadedCamera = id; loadedSupport = support;
      controller?.abort();
      listController?.abort();
      storage = undefined;
      listing = undefined;
      gallery = undefined;
      photosLoading = false; photoError = '';
      date = day ?? '';
      userSelectedDate = Boolean(day);
      storageError = '';
      searchError = '';
      if (id && supported) void refresh();
    });
  });

  onMount(() => {
    try {
      const saved = localStorage.getItem('reolink-wui-recordings-layout');
      if (saved === 'grid' || saved === 'table') layout = saved;
      const order = localStorage.getItem('reolink-wui-recordings-time-order');
      if (order === 'asc' || order === 'desc') timeOrder = order;
      const size = localStorage.getItem('reolink-wui-recordings-page-size');
      if (size && ['12','24','48','96','all'].includes(size)) pageSize = size;
    } catch { /* Storage can be unavailable. */ }
    const request = new AbortController();
    let sequence = 0;
    const listCameras = async () => {
      const current = ++sequence;
      try {
        const result = await api<{ cameras: Camera[] }>({ path: '/api/v1/cameras', signal: request.signal });
        if (request.signal.aborted || current !== sequence) return;
        cameras = result.cameras;
        cameraError = '';
      } catch (err) {
        if (!request.signal.aborted && current === sequence) cameraError = errorText(err);
      } finally { if (!request.signal.aborted && current === sequence) initial = false; }
    };
    void listCameras();
    const access = new EventSource(url('/api/v1/events'));
    access.onmessage = event => {
      if (JSON.parse(event.data).kind !== 'access-changed') return;
      controller?.abort(); listController?.abort();
      previews.close();
      gallery = undefined;
      listing = undefined;
      cameras = [];
      void listCameras();
    };
    return () => { request.abort(); controller?.abort(); listController?.abort(); access.close(); };
  });
</script>

<svelte:head><title>{t('recordings')} · {t('title')}</title></svelte:head>

<h1>{t('recordings')}</h1>
<section class="panel stack">
  <div class="row between panel-title">
    <h2>{t('recordings-camera')}</h2>
    <button disabled={initial || reading || loading || photosLoading || !canBrowse} onclick={refresh}>{t('refresh')}</button>
  </div>
  {#if cameras.length}
    <SearchSelect label={t('camera-noun')} value={selected} onchange={({ value }) => { void navigate(listUrl(value), true); }} options={cameras.map((item, index) => ({
      value: item.id, label: item.name ?? t('camera-generic', { index: index + 1 }), detail: item.model
    }))} />
  {:else if initial}
    <p role="status">{t('loading')}</p>
  {:else}
    <p class="muted">{t('no-cameras')}</p>
  {/if}
  {#if camera && !canBrowse}<p class="muted">{t('recordings-unavailable')}</p>{/if}
  {#if cameraError}<p role="alert" class="error">{cameraError}</p>{/if}
  {#if linkedClip && !initial && !cameraError && (!camera || !linkedDate || (!loading && listing && listing.date === linkedDate && !recording))}
    <p role="status" class="notice">{t('recording-link-unavailable')}</p>
    <div class="row"><button onclick={closePlayer}>{t('recordings-back')}</button></div>
  {/if}
</section>

{#if camera?.capabilities.recordings}
  <section class="panel stack" aria-labelledby="card-storage">
    <h2 id="card-storage" class="panel-title">{t('storage')}</h2>
    {#if storageError}<p role="alert" class="error">{storageError}</p>{/if}
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
{/if}

{#if camera && canBrowse}
  <section class="panel stack" aria-labelledby="recording-list">
    <div class="row between panel-title">
      <h2 id="recording-list">{t('recordings')}</h2>
      <div class="row" role="group" aria-label={t('recording-layout')}>
        <button aria-pressed={layout === 'grid'} onclick={() => chooseLayout('grid')}>{t('recording-layout-grid')}</button>
        <button aria-pressed={layout === 'table'} onclick={() => chooseLayout('table')}>{t('recording-layout-table')}</button>
      </div>
    </div>
    <form class="row recording-search" onsubmit={event => { event.preventDefault(); submitDate(); }}>
      <label>{t('recording-date')}<input type="date" required bind:value={date} oninput={() => { userSelectedDate = true; }} /></label>
      <button disabled={loading || !date}>{t('recordings-search')}</button>
    </form>
    {#if date && !loading}
      {#key camera.id + '/' + date}
        <RecordingExport camera={camera.id} {date} recordings={listing?.date === date ? listing.recordings : []}
          complete={Boolean(listing?.date === date && !listing.partial && !listing.truncated)}
          photos={camera.capabilities.timeLapsePhotoExport} videos={camera.capabilities.recordingExport && playbackAvailable} />
      {/key}
    {/if}
    {#if searchError}<p role="alert" class="error">{searchError}</p>{/if}
    {#if listing?.partial && !loading}<p class="notice">{t('recording-search-partial')}</p>{/if}
    {#if !playbackAvailable && timelineVideos.length}<p class="notice">{t('recording-workspace-unavailable')}</p>{/if}
    {#if photoError}<p role="alert" class="error">{t('timeline-photos-failed')} {photoError}</p>{/if}
    {#if listedDate && (timelineVideos.length || timelinePhotos.length || undatedCount)}
      {#key selected + '/' + listedDate}
        <RecordingTimeline {previews} clockHint={clockComparison ? t('recording-clock-comparison',clockComparison) : undefined}
          warming={!recording} recordings={timelineVideos} photos={timelinePhotos} {undatedCount} date={listedDate} available={Boolean(camera.capabilities.recordingPreview)}
          playable={playbackAvailable} {highlighted} onhover={hover} onselect={select} />
      {/key}
    {/if}
    {#if loading || (photosLoading && !timelineVideos.length && !timelinePhotos.length)}
      <p role="status">{t('recordings-searching')}</p>
    {:else if listing?.recordings.length}
      <div class="row recording-list-controls">
        <div class="field">
          <label for={fieldId + '-time-order'}>{t('recording-time-order')}</label>
          <select id={fieldId + '-time-order'} bind:value={timeOrder} onchange={chooseTimeOrder}>
            <option value="desc">{t('recording-newest-first')}</option>
            <option value="asc">{t('recording-oldest-first')}</option>
          </select>
        </div>
        <div class="field"><label for={fieldId + '-page-size'}>{t('recording-page-size')}</label>
          <select id={fieldId + '-page-size'} bind:value={pageSize} onchange={choosePageSize}>
            {#each ['12','24','48','96'] as size}<option value={size}>{t('recording-items', { count: size })}</option>{/each}
            <option value="all">{t('recording-items-all')}</option>
          </select>
        </div>
        <span class="muted">{t('recording-total', { count: listing.recordings.length })}</span>
      </div>
      {#if layout === 'grid'}
        <div class="recording-grid">
          {#each visible as item (item.id)}
            <article class="recording-card stack" data-recording={item.id} data-highlighted={highlighted === item.id}>
              <button class="recording-poster" disabled={!playbackAvailable}
                aria-label={t('recording-play-at', { time: item.start.replace('T',' ') })} onclick={() => select(item)}>
                <RecordingPreview {previews} recording={item.id} available={Boolean(camera.capabilities.recordingPreview)} />
                <span class="recording-play-overlay" aria-hidden="true">▶</span>
              </button>
              <time class="recording-time" datetime={item.start}><span class="muted">{item.start.slice(0,10)}</span><strong>{item.start.slice(11)}</strong></time>
              <p class="recording-kind">{recordingKinds({ value: item.kind })}</p>
              <div class="row between"><span class="muted">{recordingDuration({ recording: item })} · {recordingSize({ value: item.sizeBytes })}</span>
                <button disabled={!playbackAvailable} onclick={() => select(item)}>{t('recording-play')}</button></div>
            </article>
          {/each}
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable table supports keyboard access.) -->
        <div class="table-scroll table-surface" role="region" aria-labelledby="recording-list" tabindex="0">
          <table class="status-table recordings-table">
            <thead><tr><th>{t('recording-preview')}</th><th>{t('recording-start')}</th><th>{t('recording-end')}</th><th>{t('recording-duration')}</th><th>{t('event-type')}</th><th>{t('recording-size')}</th><th>{t('recording-play')}</th></tr></thead>
            <tbody>
              {#each visible as item (item.id)}
                <tr data-recording={item.id} data-highlighted={highlighted === item.id}>
                  <td><button class="recording-poster recording-poster-small" disabled={!playbackAvailable}
                    aria-label={t('recording-play-at', { time: item.start.replace('T',' ') })} onclick={() => select(item)}>
                    <RecordingPreview {previews} recording={item.id} available={Boolean(camera.capabilities.recordingPreview)} />
                  </button></td>
                  <td><time class="recording-time" datetime={item.start}><span class="muted">{item.start.slice(0,10)}</span><strong>{item.start.slice(11)}</strong></time></td>
                  <td><time class="recording-time" datetime={item.end}><span class="muted">{item.end.slice(0,10)}</span><strong>{item.end.slice(11)}</strong></time></td>
                  <td>{recordingDuration({ recording: item })}</td><td class="recording-kind">{recordingKinds({ value: item.kind })}</td><td>{recordingSize({ value: item.sizeBytes })}</td>
                  <td><button disabled={!playbackAvailable} onclick={() => select(item)}>{t('recording-play')}</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <div class="row between" aria-label={t('recording-pages')}>
        <button disabled={pageNumber === 0} onclick={() => { pageNumber--; }}>{t('recording-page-previous')}</button>
        <span>{t('recording-page-count', { page: pageNumber + 1, count: pageCount, total: listing.recordings.length })}</span>
        <button disabled={pageNumber + 1 >= pageCount} onclick={() => { pageNumber++; }}>{t('recording-page-next')}</button>
      </div>
    {:else if !timelinePhotos.length && !undatedCount && (listing || gallery)}
      <p class="muted">{t(camera.capabilities.timeLapsePhotos && !photoError ? 'timeline-empty' : 'recordings-empty')}</p>
    {/if}
    {#if listing?.truncated}<p class="notice">{t('recordings-truncated')}</p>{/if}
  </section>
  {#if recording && playbackAvailable}
    <RecordingPlayer {stream} onstream={chooseStream} canExport={camera.capabilities.recordingExport} metadataAvailable={camera.capabilities.recordingMetadata} {startPosition} camera={selected} name={camera.name ?? t('camera-noun')} {recording} recordings={listing?.recordings ?? []}
      onselect={item => select(item)} onclose={closePlayer} onrenew={renew} />
  {/if}
{/if}
