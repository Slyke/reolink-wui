<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { StorageInfo } from '../../shared/recordings.js';
  import { t } from './api.js';

  type Card = StorageInfo['cards'][number];
  let { cards, actions }: { cards: Card[]; actions?: Snippet<[Card]> } = $props();
  const size = (bytes: number | null) => bytes === null ? t('empty-value') : t('storage-gb', {
    value: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(bytes / 1_000_000_000)
  });
</script>

<div class="grid">
  {#each cards as card}
    <article class="panel stack">
      <div class="row between">
        <h3>{cards.length > 1 ? t('storage-slot', {kind:t('storage-' + card.kind), slot:card.number}) : t('storage-' + card.kind)}</h3>
        <span class="pill" data-status={card.mounted && card.formatted ? 'online' : 'offline'}>
          {t(card.mounted && card.formatted ? 'storage-ready' : 'storage-unavailable')}
        </span>
      </div>
      <dl class="event-metadata">
        <dt>{t('storage-total')}</dt><dd>{size(card.totalBytes)}</dd>
        <dt>{t('storage-used')}</dt><dd>{size(card.usedBytes)}</dd>
        <dt>{t('storage-free')}</dt><dd>{size(card.freeBytes)}</dd>
      </dl>
      {#if card.totalBytes && card.usedBytes !== null}
        <meter min="0" max={card.totalBytes} value={card.usedBytes} aria-label={t('storage-used')}></meter>
      {/if}
      {@render actions?.(card)}
    </article>
  {:else}
    <p class="muted">{t('storage-empty')}</p>
  {/each}
</div>
