<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { StorageInfo } from '../../shared/recordings.js';
  import { api, errorText, operationId, outcomeText, t, type Outcome } from './api.js';
  import StorageCards from './StorageCards.svelte';

  let { base, cameraName, csrf, canFormat }: {
    base: string; cameraName: string; csrf: string; canFormat: boolean
  } = $props();
  let storage = $state<StorageInfo>();
  let reading = $state(false), formatting = $state(false);
  let error = $state(''), status = $state('');
  let section: HTMLElement;
  const reads = new AbortController();
  export const working = () => reading || formatting;

  onMount(() => {
    if (location.hash === '#sd-card-settings') section.scrollIntoView();
  });
  onDestroy(() => reads.abort());

  export async function refresh() {
    if (working()) return;
    reading = true;
    error = ''; status = '';
    try {
      storage = await api<StorageInfo>({ path: base + '/storage?format=' + canFormat, signal: reads.signal });
    } catch (cause) {
      storage = undefined;
      if (!reads.signal.aborted) error = errorText(cause);
      return false;
    } finally { reading = false; }
  }

  async function formatCard(card: StorageInfo['cards'][number]) {
    if (working() || !canFormat || card.kind !== 'sd' || !card.formatSource) return;
    if (!confirm(t('storage-format-confirm', { slot: card.number, camera: cameraName }))) return;
    formatting = true;
    error = ''; status = '';
    try {
      const result = await api<Outcome>({ path: base + '/storage/format', method: 'POST', csrf,
        body: { operationId: operationId(), slot: card.number, source: card.formatSource, confirm: true } });
      if (result.reason === 'STORAGE_FORMAT_ACCEPTED') status = outcomeText(result);
      else error = outcomeText(result);
      storage = undefined;
    } catch (cause) {
      storage = undefined;
      error = errorText(cause);
    } finally { formatting = false; }
  }
</script>

<section class="stack" id="sd-card-settings" aria-labelledby="sd-card-settings-title" bind:this={section}>
  <div class="row between panel-title">
    <h3 id="sd-card-settings-title">{t('storage')}</h3>
    <button disabled={working()} onclick={refresh}>{t('storage-refresh')}</button>
  </div>
  {#if reading || formatting}<p role="status">{t('loading')}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
  {#if storage}
    <StorageCards cards={storage.cards}>
      {#snippet actions(card)}
        {#if canFormat && card.kind === 'sd'}
          <div class="row"><button class="danger" disabled={working() || !card.formatSource}
            aria-describedby={!card.formatSource ? 'format-unavailable-' + card.number : undefined}
            onclick={() => formatCard(card)}>{t('storage-format')}</button></div>
          {#if !card.formatSource}<p class="muted" id={'format-unavailable-' + card.number}>{t('storage-format-unavailable')}</p>{/if}
        {/if}
      {/snippet}
    </StorageCards>
  {/if}
</section>
