<script lang="ts">
  import { onMount } from 'svelte';
  import { api, errorText, t, UiError, url } from '$lib/api.js';
  import { cameraStatus, type Camera } from '$lib/models.js';
  import { useWorkspace } from '$lib/workspace.js';
  import { matchesPreviewAlert } from '../../../../shared/playback.js';
  import type { InventoryState } from '../../../../shared/upstreams.js';
  import CameraPreview from '$lib/CameraPreview.svelte';

  const workspace = useWorkspace();
  let cameras = $state<Camera[]>([]);
  let inventory = $state<InventoryState>();
  let busy = $state(false);
  let loading = $state(true);
  let error = $state('');
  let frameRequests = $state<Record<string, number>>({});
  let reconnect = $state(0);
  const watchAlerts = $derived(cameras.some(camera => camera.capabilities.events && camera.capabilities.preview && camera.refreshOnAlert !== 'off'));

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
    source.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.kind === 'event') {
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
{#if error}
  <p class="error" role="alert">{error}</p>
{:else if loading}
  <p role="status">{t('loading')}</p>
{:else if cameras.length}
  <div class="camera-grid">
    {#each cameras as camera, index (camera.id)}
      {@const name = camera.name ?? t('camera-generic', { index: index + 1 })}
      <a class="panel stack camera-tile" href={'/monitor?camera=' + camera.id} aria-labelledby={'dashboard-camera-' + camera.id}>
        <div class="row between">
          <h2 id={'dashboard-camera-' + camera.id} class="wrap">{name}</h2>
          <span class="pill" data-status={cameraStatus(camera)}>{t(cameraStatus(camera))}</span>
        </div>
        {#key camera.capabilities.preview}
          <CameraPreview camera={camera.id} {name} enabled={camera.capabilities.preview}
            refreshRequest={frameRequests[camera.id] ?? 0} />
        {/key}
      </a>
    {/each}
  </div>
{:else}
  <section class="panel stack">
    <h2>{t('cameras')}</h2>
    <p class="muted">{t(inventory ? 'inventory-' + inventory : 'no-cameras')}</p>
    {#if inventory}<a href="/status">{t('status-page')}</a>{/if}
  </section>
{/if}
