<script lang="ts">
  import { onMount } from 'svelte';
  import { t, url } from './api.js';
  let { camera, recording, available, offsetMs = 0, eager = false }: { camera: string; recording: string; available: boolean; offsetMs?: number; eager?: boolean } = $props();
  let element: HTMLDivElement;
  let visible = $state(false), failed = $state(false), image = $state(''), earlier = $state(0);
  onMount(() => {
    if (eager || typeof IntersectionObserver === 'undefined') { visible = true; return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { visible = true; observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  });
  $effect(() => {
    const offset = offsetMs;
    const path = url('/api/v1/cameras/' + camera + '/recordings/' + recording + '/preview?offsetMs=' + offset);
    image = ''; failed = false; earlier = 0;
    if (!available || !visible) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) throw new Error('Preview unavailable');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const selected = response.headers.get('x-preview-offset-ms');
      earlier = selected === null ? 0 : Math.max(0,Math.round((offset - Number(selected)) / 1000));
      objectUrl = URL.createObjectURL(blob);
      image = objectUrl;
    })().catch(() => { if (!controller.signal.aborted) failed = true; });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  });
</script>
<div class="recording-preview" bind:this={element}>
  {#if image && !failed}
    <img decoding="async" alt="" src={image} onerror={() => { failed = true; }} />
    {#if eager && earlier > 0}<small class="preview-earlier">{t('recording-nearby-preview',{seconds:earlier})}</small>{/if}
  {:else}<span class="muted">{t(failed ? 'recording-preview-failed' : 'recording-preview-placeholder')}</span>{/if}
</div>
