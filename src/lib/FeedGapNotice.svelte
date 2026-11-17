<script lang="ts">
  import type { FeedGap } from '../../shared/events.js';
  import { t } from './api.js';
  import { formatLocalTimestamp } from './dates.js';
  import { dismissOnBackdrop } from './dialog.js';
  import type { Camera } from './models.js';

  let { gaps, cameras, onrefresh }: { gaps: FeedGap[]; cameras: Camera[]; onrefresh: () => void } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;
</script>

{#snippet timestamp(value: number)}
  <time datetime={new Date(value).toISOString()}>{formatLocalTimestamp(value)}</time>
{/snippet}

<div class="panel row between notice">
  <p role="status">{t('feed-gap')}</p>
  <div class="row">
    <button type="button" aria-haspopup="dialog" onclick={() => dialog.showModal()}>{t('feed-gap-more')}</button>
    <button type="button" onclick={onrefresh}>{t('refresh')}</button>
  </div>
</div>

<dialog class="event-dialog" bind:this={dialog} use:dismissOnBackdrop aria-labelledby={id}>
  <div class="stack">
    <div class="row between panel-title">
      <h2 {id}>{t('feed-gap-details')}</h2>
      <form method="dialog"><button>{t('close')}</button></form>
    </div>
    <p class="muted">{t('feed-gap-history')}</p>
    {#each gaps.toReversed() as gap (gap.id)}
      <section class="panel stack">
        <h3>{t('feed-gap-' + gap.cause)}</h3>
        <dl class="event-metadata">
          <dt>{t('feed-gap-detected')}</dt><dd>{@render timestamp(gap.detectedAt)}</dd>
          {#if gap.cause === 'bridge-connection' || gap.cause === 'bridge-backlog'}
            <dt>{t('feed-gap-bridge')}</dt><dd>{gap.bridge} · {gap.transport}</dd>
          {/if}
          {#if gap.cause === 'bridge-connection'}
            <dt>{t('feed-gap-issue')}</dt><dd>{t('feed-gap-failure-' + gap.failure)}</dd>
          {/if}
          {#if gap.cause === 'browser-connection' || gap.cause === 'bridge-connection'}
            {#if gap.recoveredAt !== undefined}
              <dt>{t('feed-gap-reconnected')}</dt><dd>{@render timestamp(gap.recoveredAt)}</dd>
            {:else}
              <dt>{t('feed-gap-status')}</dt><dd>{t('feed-gap-reconnecting')}</dd>
            {/if}
          {/if}
          {#if gap.cause === 'delivery-backlog'}
            <dt>{t('feed-gap-skipped')}</dt><dd>{gap.droppedEvents}</dd>
            <dt>{t('feed-gap-first-skipped')}</dt><dd>{@render timestamp(gap.firstObservedAt)}</dd>
            <dt>{t('feed-gap-last-skipped')}</dt><dd>{@render timestamp(gap.lastObservedAt)}</dd>
          {/if}
        </dl>
        {#if gap.cause === 'delivery-backlog'}
          <div>
            <h4>{t(gap.samples.length < gap.droppedEvents ? 'feed-gap-examples' : 'feed-gap-skipped-list')}</h4>
            <ul>
              {#each gap.samples as event}
                <li class="wrap">
                  {cameras.find(camera => camera.id === event.camera)?.name ?? t('camera-noun')}
                  · {t(event.type ?? 'event-observed')} · {@render timestamp(event.observedAt)}
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <p class="muted">{t(gap.cause === 'bridge-backlog' ? 'feed-gap-bridge-backlog-description' : 'feed-gap-unknown-events')}</p>
        {/if}
      </section>
    {/each}
  </div>
</dialog>
