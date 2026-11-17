<script lang="ts">
  import { onMount } from 'svelte';
  import { previewAlerts, type PreviewAlert } from '../../shared/playback.js';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';

  let { base, csrf, bridgePreview }: { base: string; csrf: string; bridgePreview: boolean } = $props();
  let source = $state<'direct' | 'proxy'>('direct');
  let proxyUrl = $state('');
  let refreshOnAlert = $state<PreviewAlert>('off');
  let busy = $state(false);
  let loaded = $state(false);
  let error = $state('');
  let message = $state('');
  const path = $derived(base + '/playback');

  const load = async () => {
    busy = true;
    try {
      const settings = await api<{
        source: 'direct' | 'proxy'; proxyUrl?: string; refreshOnAlert: PreviewAlert
      }>({ path });
      source = settings.source;
      proxyUrl = settings.proxyUrl ?? '';
      refreshOnAlert = settings.refreshOnAlert;
      loaded = true;
      error = '';
    } catch (err) { error = errorText(err); }
    finally { busy = false; }
  };
  const save = async () => {
    busy = true;
    error = '';
    message = '';
    try {
      const value = await api<Outcome>({
        path, csrf, method: 'PUT',
        body: {
          operationId: operationId(), source, refreshOnAlert,
          ...(source === 'proxy' ? { proxyUrl: proxyUrl.trim() } : {})
        }
      });
      if (value.outcome === 'confirmed') {
        proxyUrl = value.data?.proxyUrl ?? '';
        message = t('playback-saved');
      } else error = outcomeText(value);
    } catch (err) { error = errorText(err); }
    finally { busy = false; }
  };
  export const refresh = load;
  export const working = () => busy;
  onMount(() => { void load(); });
</script>

<section class="panel stack" aria-labelledby="playback-title">
  <h2 id="playback-title" class="panel-title">{t('playback-settings')}</h2>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if loaded}
    <form class="stack" onsubmit={event => { event.preventDefault(); void save(); }}>
      <label>{t('playback-source')}
        <select bind:value={source}>
          <option value="direct">{t('playback-direct')}</option>
          <option value="proxy">{t('playback-proxy')}</option>
        </select>
      </label>
      {#if source === 'proxy'}
        <label>{t('playback-proxy-url')}
          <input type="url" inputmode="url" autocomplete="off" maxlength="2048" bind:value={proxyUrl}
            placeholder="rtsp://frigate:8554/camera-name" required />
        </label>
        <p class="muted">{t('playback-proxy-hint')}</p>
      {:else}
        <p class="muted">{t('playback-direct-hint')}</p>
      {/if}
      <label>{t('preview-alert')}
        <select bind:value={refreshOnAlert}>
          {#each previewAlerts as value}<option {value}>{t(value === 'any' ? 'preview-alert-any' : value)}</option>{/each}
        </select>
      </label>
      <p class="muted">{t(bridgePreview ? 'preview-bridge-settings-hint' : 'preview-bridge-configure')}</p>
      <div class="row"><button class="primary" disabled={busy}>{t('save')}</button></div>
    </form>
  {:else if busy}
    <p role="status">{t('loading')}</p>
  {:else}
    <div class="row"><button onclick={load}>{t('retry')}</button></div>
  {/if}
</section>
