<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { api, errorText, t, UiError, url } from '$lib/api.js';
  import { cameraStatus, type Camera, type CameraEvent } from '$lib/models.js';
  import { matchesPreviewAlert } from '../../../../shared/playback.js';
  import { defaultEventRetention, maxFeedGapReports, type FeedGap } from '../../../../shared/events.js';
  import { useWorkspace } from '$lib/workspace.js';
  import type { InventoryState } from '../../../../shared/upstreams.js';
  import CameraPanel from '$lib/CameraPanel.svelte';
  import FeedGapNotice from '$lib/FeedGapNotice.svelte';

  const workspace = useWorkspace();
  let cameras = $state<Camera[]>([]);
  let inventory = $state<InventoryState>();
  let selected = $state('');
  let loading = $state(true);
  let error = $state('');
  let feed = $state(false);
  let gaps = $state<FeedGap[]>([]);
  let browserGap: Extract<FeedGap, { cause: 'browser-connection' }> | undefined;
  let events = $state<CameraEvent[]>([]);
  let historyError = $state(false);
  let historyRevision = $state(0);
  let historyCamera: string | undefined;
  let eventLimit = defaultEventRetention;
  let revision = $state(0);
  let alertFrameRequest = $state(0);
  let source: EventSource | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let loadSequence = 0;
  let active = false;
  const camera = $derived(cameras.find(item => item.id === selected));
  const feedReady = $derived(feed && !gaps.some(gap => gap.cause === 'bridge-connection' && gap.recoveredAt === undefined));
  const noteGap = (gap: FeedGap) => {
    gaps = [...gaps.filter(previous => previous.id !== gap.id), gap].slice(-maxFeedGapReports);
  };
  const refreshFeed = () => {
    gaps = gaps.filter(gap => (gap.cause === 'bridge-connection' || gap.cause === 'browser-connection') && gap.recoveredAt === undefined);
    historyRevision++;
    void loadCameras();
  };

  $effect(() => {
    const id = camera?.capabilities.events ? camera.id : undefined;
    const version = historyRevision;
    if (id !== historyCamera) {
      events = [];
      historyError = false;
      eventLimit = defaultEventRetention;
      historyCamera = id;
    }
    if (!id) return;
    const controller = new AbortController();
    void api<{ limit: number; events: CameraEvent[] }>({
      path: '/api/v1/cameras/' + id + '/events', signal: controller.signal
    }).then(history => {
      if (controller.signal.aborted || version !== historyRevision) return;
      const byId = new Map([...history.events, ...events].map(entry => [entry.id, entry]));
      eventLimit = history.limit;
      events = [...byId.values()].sort((left, right) => left.observedAt - right.observedAt).slice(-Math.max(1, eventLimit));
      historyError = false;
    }).catch(() => {
      if (!controller.signal.aborted && version === historyRevision) historyError = true;
    });
    return () => controller.abort();
  });

  const loadCameras = async () => {
    const generation = ++loadSequence;
    try {
      const response = await api<{ cameras: Camera[]; inventory?: InventoryState }>({ path: '/api/v1/cameras' });
      if (generation !== loadSequence) return;
      inventory = response.inventory;
      cameras = response.cameras;
      const requested = page.url.searchParams.get('camera');
      if (!cameras.some(item => item.id === selected)) {
        selected = cameras.find(item => item.id === requested)?.id ?? cameras[0]?.id ?? '';
      }
      revision++;
      error = '';
    } catch (err) {
      if (generation !== loadSequence) return;
      cameras = [];
      events = [];
      inventory = undefined;
      error = errorText(err);
      if (err instanceof UiError && err.reason === 'NOT_AUTHENTICATED') await workspace.refreshSession();
    } finally {
      if (generation === loadSequence) loading = false;
    }
  };
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void loadCameras();
    }, 450);
  };
  const stopFeed = () => {
    source?.close();
    source = undefined;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    loadSequence++;
    browserGap = undefined;
    feed = false;
  };
  const connect = () => {
    stopFeed();
    source = new EventSource(url('/api/v1/events'));
    source.onopen = () => {
      feed = true;
      if (browserGap) {
        noteGap({ ...browserGap, recoveredAt: Date.now() });
        browserGap = undefined;
      }
      historyRevision++;
      scheduleRefresh();
    };
    source.onerror = () => {
      feed = false;
      if (!browserGap) {
        browserGap = { cause: 'browser-connection', id: crypto.randomUUID(), detectedAt: Date.now() };
        noteGap(browserGap);
      }
      cameras = cameras.map(item => ({ ...item, availability: { ...item.availability, online: undefined, stale: true } }));
    };
    source.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.kind === 'event') {
        const entry = { id: message.id, observedAt: message.observedAt, event: message.event };
        if (message.camera === historyCamera && !events.some(previous => previous.id === entry.id)) {
          events = [...events, entry].slice(-Math.max(1, eventLimit));
        }
        if (camera?.capabilities.preview && message.camera === camera.id
          && matchesPreviewAlert({ selected: camera.refreshOnAlert, event: entry.event })) alertFrameRequest++;
      } else if (message.kind === 'access-changed') {
        cameras = [];
        events = [];
        gaps = [];
        stopFeed();
        void workspace.refreshSession().then(() => {
          if (active) { connect(); scheduleRefresh(); }
        });
      } else {
        if (message.kind === 'gap') {
          noteGap(message.details ?? { cause: 'unknown', id: crypto.randomUUID(), detectedAt: Date.now() });
          historyRevision++;
        }
        scheduleRefresh();
      }
    };
  };

  onMount(() => {
    active = true;
    connect();
    void loadCameras();
    // An account with zero grants has no per-camera stream events to trigger a refresh.
    const poll = setInterval(() => { if (!camera || !feedReady) scheduleRefresh(); }, 4000);
    return () => {
      active = false;
      clearInterval(poll);
      stopFeed();
    };
  });
</script>

<svelte:head><title>{t('monitor')} · {t('title')}</title></svelte:head>
<svelte:document onvisibilitychange={() => { if (active && !document.hidden) scheduleRefresh(); }} />

<div class="row between">
  <h1>{t('monitor')}</h1>
  <span class="pill" data-status={feedReady ? 'online' : 'stale'}>{t(feedReady ? 'feed-live' : 'feed-down')}</span>
</div>
{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if gaps.length}
  <FeedGapNotice {gaps} {cameras} onrefresh={refreshFeed} />
{/if}
{#if loading}
  <p role="status">{t('loading')}</p>
{:else if !camera}
  <section class="panel stack" aria-labelledby="monitor-empty">
    <h2 id="monitor-empty">{t('cameras')}</h2>
    <p class="muted">{t(inventory ? 'inventory-' + inventory : 'no-cameras')}</p>
    <div class="row">
      {#if inventory}
        <a class="button" href="/status">{t('status-page')}</a>
      {/if}
      <button onclick={loadCameras}>{t('refresh')}</button>
    </div>
  </section>
{:else}
  <div class="dashboard">
    <aside class="panel stack">
      <h2>{t('cameras')}</h2>
      <nav class="stack camera-list" aria-label={t('camera-access')}>
        {#each cameras as item, index (item.id)}
          <button aria-pressed={item.id === selected} onclick={() => selected = item.id}>
            <strong>{item.name ?? t('camera-generic', { index: index + 1 })}</strong>
            <small>{item.model ?? t('model-unknown')}</small>
            <span class="pill" data-status={cameraStatus(item)}>{t(cameraStatus(item))}</span>
          </button>
        {/each}
      </nav>
    </aside>
    {#key camera.id}
      <CameraPanel {camera} {revision} {events} {historyError} {alertFrameRequest}
        administer={workspace.current().user.admin} csrf={workspace.current().csrf} />
    {/key}
  </div>
{/if}
