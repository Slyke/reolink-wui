<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from './api.js';
  import type { RecordingPreviews } from './recording-previews.js';

  let { previews, recording, available, offsetMs = 0, eager = false, photo = false }: {
    previews: RecordingPreviews; recording: string; available: boolean; offsetMs?: number; eager?: boolean; photo?: boolean
  } = $props();
  let element: HTMLDivElement;
  let visible = $state(false), failed = $state(false);
  let image = $state<{ cache: RecordingPreviews; recording: string; src: string; offset: number; jpeg: Blob }>();
  const cacheKey = $derived(photo ? 'photo/' + recording : recording);
  const shown = $derived(available && image?.cache === previews && image.recording === cacheKey ? image : undefined);
  const seconds = $derived(shown ? Math.round((offsetMs - shown.offset) / 1000) : 0);
  onMount(() => {
    if (eager || typeof IntersectionObserver === 'undefined') { visible = true; return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { visible = true; observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  });
  $effect(() => {
    const id = cacheKey, offset = offsetMs, cache = previews, timeline = eager;
    failed = false;
    if (!available || !visible) return;
    const controller = new AbortController();
    const show = async (frame: { jpeg: Blob; offsetMs: number }) => {
      if (untrack(() => image?.jpeg === frame.jpeg)) return;
      const src = URL.createObjectURL(frame.jpeg);
      try {
        const decoded = new Image(); decoded.src = src;
        await decoded.decode();
        if (controller.signal.aborted) { URL.revokeObjectURL(src); return; }
      } catch (error) { URL.revokeObjectURL(src); throw error; }
      if (image) URL.revokeObjectURL(image.src);
      image = { cache, recording: id, src, offset: frame.offsetMs, jpeg: frame.jpeg };
    };
    const hit = cache.exact(id, offset);
    const nearby = !hit && timeline && !photo ? cache.nearest(id, offset) : undefined;
    // Show a warm image immediately while a cold, exact hover waits for the pointer to settle.
    const first = hit ?? nearby;
    const display = first ? show(first).catch(() => { if (!controller.signal.aborted && hit) failed = true; }) : Promise.resolve();
    const fetchExact = async () => {
      try {
        const frame = await cache.read(id, offset, controller.signal);
        await display;
        if (!controller.signal.aborted) await show(frame);
      } catch { if (!controller.signal.aborted) failed = true; }
    };
    const timer = !hit && timeline ? setTimeout(fetchExact, 150) : undefined;
    if (!hit && !timeline) void fetchExact();
    return () => { clearTimeout(timer); controller.abort(); };
  });
  onDestroy(() => { if (image) URL.revokeObjectURL(image.src); });
</script>

<div class="recording-preview" bind:this={element} aria-busy={available && !failed && !shown}>
  {#if shown}
    <img alt="" src={shown.src} />
    {#if eager && seconds !== 0}<small class="preview-earlier">{t(seconds > 0 ? 'recording-nearby-preview' : 'recording-later-preview', { seconds: Math.abs(seconds) })}</small>{/if}
  {:else}<span class="muted">{t(!available || failed ? 'recording-preview-failed' : 'loading')}</span>{/if}
</div>
