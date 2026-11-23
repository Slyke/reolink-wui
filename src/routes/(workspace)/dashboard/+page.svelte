<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { afterNavigate, goto } from '$app/navigation';
  import { api, errorText, t, UiError, url } from '$lib/api.js';
  import { currentCameraId, cameraStatus, type Camera } from '$lib/models.js';
  import { useWorkspace } from '$lib/workspace.js';
  import { matchesPreviewAlert, type LiveStream } from '../../../../shared/playback.js';
  import type { InventoryState } from '../../../../shared/upstreams.js';
  import CameraLiveView from '$lib/CameraLiveView.svelte';

  const workspace = useWorkspace();
  let cameras = $state<Camera[]>([]);
  let inventory = $state<InventoryState>();
  let busy = $state(false);
  let loading = $state(true);
  let error = $state('');
  let pushConnected = $state(false);
  let previewTags = $state<Record<string,string>>({});
  let frameRequests = $state<Record<string, number>>({});
  let reconnect = $state(0);
  const linkedCamera = $derived(currentCameraId(cameras,page.url.searchParams.get('camera')));
  const linkedStream = $derived(page.url.searchParams.get('stream'));
  afterNavigate(({from,to}) => {
    if (from?.url.pathname !== to?.url.pathname || to?.url.searchParams.has('camera')) return;
    const previous=from?.url.searchParams.get('camera');
    if (previous) document.getElementById('dashboard-expand-'+previous)?.focus({preventScroll:true});
  });
  function cameraLink(id:string, open:boolean, stream?: LiveStream) {
    const target = new URL(page.url);
    const fromList = 'dashboardCameraFromList' in page.state && page.state.dashboardCameraFromList === true;
    if (!open && linkedCamera !== id) return;
    if (!open && fromList) { history.back(); return; }
    if (open) target.searchParams.set('camera', id);
    else target.searchParams.delete('camera');
    if (open && stream) target.searchParams.set('stream', stream);
    else target.searchParams.delete('stream');
    if (target.href === page.url.href) return;
    void goto(target, { replaceState: !!linkedCamera, keepFocus: true, noScroll: true,
      state: {...page.state, dashboardCameraFromList: open && (!linkedCamera || fromList)} });
  }
  const watchAlerts = $derived(cameras.some(camera => camera.capabilities.preview));

  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await api<{ cameras: Camera[]; inventory?: InventoryState }>({ path: '/api/v1/cameras' });
      cameras = result.cameras;
      inventory = result.inventory;
      error = '';
    } catch (err) {
      cameras = [];
      error = errorText(err);
      if (err instanceof UiError && err.reason === 'NOT_AUTHENTICATED') await workspace.refreshSession();
    } finally {
      busy = false;
      loading = false;
    }
  };

  $effect(() => {
    const generation = reconnect;
    if (!watchAlerts) return;
    const source = new EventSource(url('/api/v1/events'));
    let active = true;
    source.onopen = () => { pushConnected = true; void refresh(); };
    source.onerror = () => { pushConnected = false; };
    source.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.kind === 'preview') previewTags[message.camera] = message.etag;
      else if (message.kind === 'feed') void refresh();
      else if (message.kind === 'event') {
        const camera = cameras.find(item => item.id === message.camera);
        if (camera?.capabilities.preview && matchesPreviewAlert({ selected: camera.refreshOnAlert, event: message.event })) {
          frameRequests[camera.id] = (frameRequests[camera.id] ?? 0) + 1;
        }
      } else if (message.kind === 'access-changed') {
        source.close();
        void refresh().finally(() => { if (active) reconnect = generation + 1; });
      }
    };
    return () => {
      active = false;
      pushConnected = false;
      source.close();
    };
  });

  onMount(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>{t('dashboard')} · {t('title')}</title></svelte:head>

<div class="row between">
  <h1>{t('dashboard')}</h1>
  <button disabled={busy} onclick={refresh}>{t('refresh')}</button>
</div>
{#if !loading && !error && linkedCamera && !cameras.some(camera => camera.id === linkedCamera && camera.capabilities.mediaAllowed && (camera.capabilities.preview || camera.capabilities.media.length))}
  <p class="notice" role="status">{t('live-link-unavailable')}</p>
{/if}
{#if error}
  <p class="error" role="alert">{error}</p>
{:else if loading}
  <p role="status">{t('loading')}</p>
{:else if cameras.length}
  <div class="camera-grid">
    {#each cameras as camera, index (camera.id)}
      {@const name = camera.name ?? t('camera-generic', { index: index + 1 })}
      <article class="panel stack camera-tile" aria-labelledby={'dashboard-camera-' + camera.id}>
        <div class="row between">
          <h2 id={'dashboard-camera-' + camera.id} class="wrap"><a href={'/monitor?camera=' + camera.id}>{name}</a></h2>
          <span class="pill" data-status={cameraStatus(camera)}>{t(cameraStatus(camera))}</span>
        </div>
        <CameraLiveView {camera} {name} compact linked={linkedCamera === camera.id} {linkedStream}
          setLink={(open,stream) => cameraLink(camera.id,open,stream)} csrf={workspace.current().csrf} administer={workspace.current().user.admin}
          previewTag={previewTags[camera.id]} {pushConnected} refreshRequest={frameRequests[camera.id] ?? 0} />
      </article>
    {/each}
  </div>
{:else}
  <section class="panel stack">
    <h2>{t('cameras')}</h2>
    <p class="muted">{t(inventory ? 'inventory-' + inventory : 'no-cameras')}</p>
    {#if inventory}<a href="/status">{t('status-page')}</a>{/if}
  </section>
{/if}
