<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { t, url } from './api.js';
  let { camera, recording, available, offsetMs = 0, eager = false }: { camera: string; recording: string; available: boolean; offsetMs?: number; eager?: boolean } = $props();
  let element: HTMLDivElement;
  let visible = $state(false), failed = $state(false);
  $effect(() => { void [camera,recording,offsetMs]; untrack(() => { failed = false; }); });
  onMount(() => {
    if (eager || typeof IntersectionObserver === 'undefined') { visible = true; return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { visible = true; observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<div class="recording-preview" bind:this={element}>
  {#if available && visible && !failed}
    <img loading={eager ? 'eager' : 'lazy'} decoding="async" alt="" src={url('/api/v1/cameras/' + camera + '/recordings/' + recording + '/preview?offsetMs=' + offsetMs)} onerror={() => { failed = true; }} />
  {:else}
    <span class="muted">{t(failed ? 'recording-preview-failed' : 'recording-preview-placeholder')}</span>
  {/if}
</div>
