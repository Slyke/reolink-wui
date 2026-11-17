<script lang="ts">
  import { onMount } from 'svelte';
  import { bridgePreviewPollIntervalMs } from '../../shared/playback.js';
  import { fetchPreview, t, UiError } from './api.js';

  let { camera, name, enabled, refreshRequest = 0 }: {
    camera: string; name: string; enabled: boolean; refreshRequest?: number
  } = $props();
  let panel: HTMLDivElement;
  let image = $state('');
  let failed = $state(false);
  let enqueue: (() => void) | undefined;
  let previousRequest: number | undefined;

  $effect(() => {
    const next = refreshRequest;
    if (previousRequest !== undefined && next !== previousRequest) enqueue?.();
    previousRequest = next;
  });

  onMount(() => {
    let stopped = false;
    let visible = typeof IntersectionObserver === 'undefined';
    let running = false;
    let urgent = false;
    let finishedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let etag: string | undefined;
    const canFetch = () => enabled && !stopped && visible && !document.hidden;
    const clear = () => {
      if (image) URL.revokeObjectURL(image);
      image = '';
      etag = undefined;
    };
    const schedule = () => {
      clearTimeout(timer);
      if (canFetch() && !running && finishedAt !== undefined) {
        timer = setTimeout(update, Math.max(0, Math.ceil(finishedAt + bridgePreviewPollIntervalMs - performance.now())));
      }
    };
    const update = async () => {
      if (!canFetch() || running) return;
      clearTimeout(timer);
      const query = urgent ? '?refresh=true' : '';
      urgent = false;
      running = true;
      request = new AbortController();
      try {
        const next = await fetchPreview({ path: '/api/v1/cameras/' + camera + '/preview' + query, etag, signal: request.signal });
        if (!stopped && enabled) {
          etag = next.etag;
          if (next.image) {
            const previous = image;
            image = URL.createObjectURL(next.image);
            if (previous) URL.revokeObjectURL(previous);
          }
          failed = false;
        }
      } catch (error) {
        if (!stopped) {
          failed = true;
          if (error instanceof UiError && ['ACCESS_DENIED', 'NOT_AUTHENTICATED', 'CAMERA_UNKNOWN'].includes(error.reason)) clear();
        }
      } finally {
        running = false;
        finishedAt = performance.now();
        if (urgent && canFetch()) void update();
        else schedule();
      }
    };
    enqueue = () => {
      urgent = true;
      void update();
    };
    const resume = () => {
      if (urgent || finishedAt === undefined) {
        clearTimeout(timer);
        void update();
      } else schedule();
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });
    observer?.observe(panel);
    document.addEventListener('visibilitychange', resume);
    resume();
    return () => {
      stopped = true;
      enqueue = undefined;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', resume);
      request?.abort();
      clearTimeout(timer);
      clear();
    };
  });
</script>

<div class="viewport preview-viewport" bind:this={panel}>
  {#if image}
    <img src={image} alt={t('preview-alt', { camera: name })} />
    {#if failed}<small class="preview-notice">{t('preview-stale')}</small>{/if}
  {:else}
    <p>{t(!enabled ? 'preview-unconfigured' : failed ? 'preview-offline' : 'preview-waiting')}</p>
  {/if}
</div>
