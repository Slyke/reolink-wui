<script lang="ts">
  import { onMount } from 'svelte';
  import { t, url } from './api.js';
  let { camera, recording, available }: { camera: string; recording: string; available: boolean } = $props();
  let element: HTMLDivElement;
  let visible = $state(false), failed = $state(false);
  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') { visible = true; return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { visible = true; observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<div class="recording-preview" bind:this={element}>
  {#if available && visible && !failed}
    <img loading="lazy" decoding="async" alt="" src={url('/api/v1/cameras/' + camera + '/recordings/' + recording + '/preview')} onerror={() => { failed = true; }} />
  {:else}
    <span class="muted">{t(failed ? 'recording-preview-failed' : 'recording-preview-placeholder')}</span>
  {/if}
</div>
